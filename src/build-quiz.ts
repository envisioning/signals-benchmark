/**
 * cutoff:build — construct the frozen quiz bank for the knowledge-cutoff
 * probe.
 *
 * For every month in the window, a web-grounded model drafts K items:
 * one statement describing something that really happened that month,
 * plus N-1 plausible statements that never happened. A second grounded
 * model (different vendor, same reasoning as the two-judge split in
 * evaluate.ts) then checks each item before it is allowed into the bank.
 *
 * Usage:
 *   pnpm cutoff:build --from 2023-01                 (to = last complete month)
 *   pnpm cutoff:build --from 2023-01 --per-month 6
 *   pnpm cutoff:build --no-verify                    (half the cost, more noise)
 *   pnpm cutoff:build --verifier <slug>              (default: gemini flash, grounded)
 *   pnpm cutoff:build --max-tokens 24000             (if a model reports truncation)
 *   pnpm cutoff:build --top-up 4                     (revisit months holding < 4 items)
 *   pnpm cutoff:build --rebuild                      (ignore the existing bank)
 *   pnpm cutoff:build --dry-run
 *
 * Each month is drafted, filtered, verified and WRITTEN before the next
 * one finishes — the bank on disk is always valid and always complete up
 * to whatever has landed. That matters because a full window is a long
 * run against web-grounded models: interrupt it and you keep every month
 * you already paid for.
 *
 * Default behaviour is APPEND: months already in data/cutoff-quiz.json
 * are left untouched and only missing months are drafted. That's what
 * makes both the quarterly "extend the tail" refresh and resuming an
 * interrupted build free, and it keeps old buckets byte-identical so
 * previously published curves stay valid.
 *
 * Cost: roughly $0.03-0.06 per item with verification on. A 36-month
 * window at 5 items/month lands around $6-10 and 20-40 minutes as a
 * one-off; extending the tail by a quarter costs well under a dollar.
 * Run it in chunks (`--from`/`--to`) if you'd rather not sit through it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import pc from "picocolors"
import { loadEnv, requireKey } from "./env.ts"
import { openrouterChat, extractJson, getKeyUsage } from "./openrouter.ts"
import {
  DEFAULT_BANK_PATH,
  OPTION_LETTERS,
  isMonth,
  lastCompleteMonth,
  monthLabel,
  monthOrdinal,
  monthRange,
  auditBank,
  shuffleOptions,
  validateBank,
  type QuizBank,
  type QuizItem,
} from "./cutoff-quiz.ts"

const DEFAULT_BUILDER = "openai/gpt-5.4:online"
/**
 * Grounded, cheap, and reliable at short JSON — the same reasoning
 * behind the eval pipeline's default judge. Gemini 2.5 *Pro* reasons
 * internally and spends 1.5k+ tokens before the first visible character,
 * which costs 5x more per item for a two-boolean answer.
 */
const DEFAULT_VERIFIER = "google/gemini-2.5-flash:online"
const DEFAULT_PER_MONTH = 5
const DEFAULT_N_OPTIONS = 8

/**
 * Rotated across items so a month's questions aren't five variations of
 * US politics — a narrow bank measures coverage of one news beat rather
 * than of the month.
 */
const DOMAINS = [
  "world politics or policy",
  "science, space, or medicine",
  "business, markets, or technology",
  "sport",
  "culture, film, music, or literature",
  "disasters, accidents, or extreme weather",
]

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fact: { type: "string" },
          distractors: { type: "array", items: { type: "string" } },
          domain: { type: "string" },
          source_url: { type: "string" },
          source_title: { type: "string" },
        },
        required: ["fact", "distractors", "domain", "source_url", "source_title"],
      },
    },
  },
  required: ["items"],
}

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fact_confirmed: { type: "boolean" },
    any_distractor_real: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["fact_confirmed", "any_distractor_real", "reason"],
}

type DraftItem = {
  fact: string
  distractors: string[]
  domain: string
  source_url: string
  source_title: string
}

function draftPrompt(
  month: string,
  count: number,
  nOptions: number,
  avoid: string[] = []
): string {
  const domains = DOMAINS.slice(0, count).join("; ")
  const exclusion =
    avoid.length === 0
      ? ""
      : `\nThe bank already covers these events for this month — pick DIFFERENT ones:\n${avoid
          .map((a) => `  - ${a}`)
          .join("\n")}\n`
  return `Search the web for notable events from ${monthLabel(month)}.
${exclusion}

Produce ${count} quiz items. Each item is one TRUE statement about something that
actually happened in ${monthLabel(month)}, plus ${nOptions + 1} FALSE statements.
(That is more false statements than the quiz uses — extras are selected from, so
write all of them to the same standard.)

Spread the items across these domains, one each where possible: ${domains}.

Rules for the TRUE statement:
- It must be well documented — the kind of event a Wikipedia "${monthLabel(month)}" or
  "${month.slice(0, 4)} in review" page records. Give the source URL you used.
- It must have happened in ${monthLabel(month)}, not the month before or after.
- Prefer outcomes that could NOT have been confidently predicted a year earlier.
  The result of a scheduled event is good; the fact that a scheduled event was
  scheduled is not.

Rules for the FALSE statements (this is the part that decides whether the quiz
measures anything):
- EVERY named entity must be REAL and recognisable: real people, real
  organisations, real missions, real products, real places. NEVER invent a name.
  A reader who has never heard of "the Helioscope mission" can rule it out
  without knowing what happened that month — that is recognition, not knowledge,
  and it makes the whole item worthless. Reuse the real entities from the true
  statement and its neighbours.
- Build the falsehood by changing WHAT HAPPENED to real entities: flip the
  outcome, swap which real party did it, change the direction or the magnitude,
  pair two real entities that were not involved with each other. Never by
  inventing who it happened to.
- Each false statement must be something that could plausibly have been the
  headline that month, and that a well-informed reader could not rule out
  without actually knowing the month's news.
- They must not describe anything that really happened at any time, in any
  month — a distractor that is real elsewhere in the timeline is unscoreable.
- Same domain, same register, same level of detail as the true one.

Rules for ALL ${nOptions} statements in an item:
- 15-25 words. Declarative. Named actors and concrete specifics in every one.
- NEVER mention a month name, a year, or a relative date ("last week"). The
  reader is told the month separately; a date inside a statement gives it away.
- No statement may hint at which one is true through length, hedging, or
  vagueness. Written down, the ${nOptions} should be indistinguishable to someone
  who does not know what happened.

Respond ONLY with JSON:
{"items":[{"fact":"...","distractors":["...", "..."],"domain":"...","source_url":"https://...","source_title":"..."}]}
Each item needs at least ${nOptions + 1} distractors.`
}

function verifyPrompt(month: string, item: DraftItem): string {
  return `Check a quiz item about ${monthLabel(month)} using web search.

Statement claimed TRUE for ${monthLabel(month)}:
  ${item.fact}

Statements claimed FALSE (should describe nothing that ever happened):
${item.distractors.map((d, i) => `  ${i + 1}. ${d}`).join("\n")}

Answer two questions:
1. fact_confirmed — did the true statement really happen, and in ${monthLabel(month)}?
   Answer false if it happened in a different month, or you cannot confirm it.
2. any_distractor_real — does ANY of the false statements describe a real event
   (at any date), or a real event with only cosmetic details changed?

Respond ONLY with JSON:
{"fact_confirmed":true,"any_distractor_real":false,"reason":"one sentence"}`
}

// ── Local quality gates (free — run before spending on verification) ──

const DATE_LEAK_RE =
  /\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(last|next|this)\s+(week|month|year)\b/i

/**
 * Reject items whose true statement is identifiable without knowing the
 * answer. Two tells matter in practice: a date inside a statement, and a
 * true statement conspicuously longer or shorter than its distractors
 * (models write the real one with more detail). Both would inflate every
 * model's plateau accuracy and push the estimated cutoff later.
 */
function localReject(item: DraftItem, nOptions: number): string | null {
  if (!item.fact?.trim()) return "empty fact"
  if (!Array.isArray(item.distractors) || item.distractors.length < nOptions - 1) {
    return `expected at least ${nOptions - 1} distractors, got ${item.distractors?.length ?? 0}`
  }
  const all = [item.fact, ...item.distractors].map((s) => s.trim())
  if (all.some((s) => !s)) return "empty option"
  if (new Set(all.map((s) => s.toLowerCase())).size !== all.length) return "duplicate options"
  for (const s of all) {
    const leak = s.match(DATE_LEAK_RE)
    if (leak) return `date leak in option: "${leak[0]}"`
  }
  if (!/^https?:\/\//.test(item.source_url ?? "")) return "missing source url"
  return null
}

/**
 * Choose which distractors actually ship, so the true statement is never
 * the longest or shortest of the set.
 *
 * Length is the tell that shows up in practice: a real event gets stated
 * plainly, an invented one gets embellished. On a first pilot the true
 * answer was the longest option in 35% of items against a 13% chance
 * rate — enough for "pick the longest" to beat guessing, which would
 * inflate every model's plateau and push every estimated cutoff later.
 *
 * The builder is asked for MORE distractors than the quiz needs, so this
 * is a selection problem rather than a rejection problem: keep one
 * distractor longer than the fact and one shorter (bracketing it), then
 * fill the rest with whichever are closest to it in length. Nothing is
 * thrown away that we already paid for unless the bracket is impossible.
 */
export function selectDistractors(
  fact: string,
  distractors: string[],
  need: number
): { chosen: string[] } | { reject: string } {
  const factLen = fact.length
  const longer = distractors
    .filter((d) => d.length > factLen)
    .sort((a, b) => a.length - b.length)
  const shorter = distractors
    .filter((d) => d.length < factLen)
    .sort((a, b) => b.length - a.length)
  if (longer.length === 0) return { reject: "no distractor longer than the fact" }
  if (shorter.length === 0) return { reject: "no distractor shorter than the fact" }

  const chosen = [longer[0], shorter[0]]
  const rest = distractors
    .filter((d) => !chosen.includes(d))
    .sort((a, b) => Math.abs(a.length - factLen) - Math.abs(b.length - factLen))
  for (const d of rest) {
    if (chosen.length >= need) break
    chosen.push(d)
  }
  if (chosen.length < need) {
    return { reject: `only ${chosen.length} usable distractors, need ${need}` }
  }
  return { chosen: chosen.slice(0, need) }
}

// ── Arg parsing ──────────────────────────────────────────────────────

type Args = Record<string, string | boolean>
function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  const apiKey = requireKey()

  const outPath = resolve((args.out as string) ?? DEFAULT_BANK_PATH)
  const nOptions = Number(args["n-options"] ?? DEFAULT_N_OPTIONS)
  const perMonth = Number(args["per-month"] ?? DEFAULT_PER_MONTH)
  const builder = (args.builder as string) ?? DEFAULT_BUILDER
  const verifier = (args.verifier as string) ?? DEFAULT_VERIFIER
  const verify = !args["no-verify"]
  const concurrency = Number(args.concurrency ?? 6)
  /**
   * Generous by default. These are per-month one-off calls, and the
   * failure mode of a low ceiling (truncated JSON, whole month lost,
   * money already spent) is far worse than a few unused tokens — models
   * are billed for what they emit, not for the ceiling.
   */
  const maxTokens = Number(args["max-tokens"] ?? 16_000)
  const to = (args.to as string) ?? lastCompleteMonth()
  const from = (args.from as string) ?? defaultFrom(to)

  if (!isMonth(from) || !isMonth(to)) {
    console.error(pc.red(`--from/--to must be YYYY-MM (got ${from} / ${to})`))
    process.exit(1)
  }
  if (nOptions < 2 || nOptions > OPTION_LETTERS.length) {
    console.error(pc.red(`--n-options must be 2..${OPTION_LETTERS.length}`))
    process.exit(1)
  }

  const rebuild = Boolean(args.rebuild)
  const existing =
    !rebuild && existsSync(outPath)
      ? (JSON.parse(readFileSync(outPath, "utf-8")) as QuizBank)
      : null

  if (existing && existing.n_options !== nOptions) {
    console.error(
      pc.red(
        `Existing bank is ${existing.n_options}-way but --n-options is ${nOptions}. ` +
          `Pass --rebuild to start a new bank (and bump --version).`
      )
    )
    process.exit(1)
  }

  const allMonths = monthRange(from, to)
  const have = new Set(existing?.items.map((it) => it.month) ?? [])
  const countFor = (m: string) =>
    existing?.items.filter((it) => it.month === m).length ?? 0
  /**
   * --top-up <n> revisits months that came back THIN rather than only
   * months that are missing. Selection is strict enough that a month can
   * land with one or two items, and a bucket that small makes accuracy
   * quantised (0/50/100%) — noise the curve then has to be smoothed
   * through. Without this, topping up meant hand-editing the bank.
   */
  const topUpTo = args["top-up"] ? Number(args["top-up"]) : 0
  const todo = allMonths.filter((m) =>
    topUpTo > 0 ? countFor(m) < topUpTo : !have.has(m)
  )

  const version =
    (args.version as string) ??
    existing?.version ??
    `${new Date().toISOString().slice(0, 7)}-v1`

  console.log(pc.bold(pc.cyan("\ncutoff:build")))
  console.log(pc.dim(`  window:    ${from} … ${to} (${allMonths.length} months)`))
  console.log(
    pc.dim(
      topUpTo > 0
        ? `  to top up: ${todo.length} months holding < ${topUpTo} items`
        : `  to draft:  ${todo.length} months × ${perMonth} items`
    )
  )
  if (existing) {
    console.log(
      pc.dim(`  existing:  ${existing.items.length} items across ${have.size} months (kept)`)
    )
  }
  console.log(pc.dim(`  builder:   ${builder}`))
  console.log(pc.dim(`  verifier:  ${verify ? verifier : "(disabled)"}`))
  console.log(pc.dim(`  out:       ${outPath}\n`))

  if (todo.length === 0) {
    console.log(pc.yellow("Nothing to draft — bank already covers the window."))
    return
  }
  if (args["dry-run"]) {
    console.log(pc.yellow("Dry run — exiting before any API calls."))
    return
  }

  const usageAtStart = await getKeyUsage(apiKey)
  const { default: pMap } = await import("p-map")
  const startedAt = Date.now()

  /**
   * Draft, filter and verify ONE month, and return the items that
   * survived. Deliberately month-atomic: the caller writes each month's
   * result to disk as it lands, so an interrupted build keeps every
   * month it already paid for and re-running resumes from there. An
   * earlier version drafted everything, then verified everything, then
   * wrote once at the end — a 40-minute run that lost the lot on Ctrl-C.
   */
  async function buildMonth(
    month: string,
    want: number,
    avoid: string[]
  ): Promise<{
    items: DraftItem[]
    drafted: number
    localDrops: number
    verifyDrops: number
    error?: string
  }> {
    const res = await askJson({
      apiKey,
      model: builder,
      messages: [{ role: "user", content: draftPrompt(month, want, nOptions, avoid) }],
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "quiz_items", strict: true, schema: DRAFT_SCHEMA },
      },
      temperature: 0.4,
      maxTokens,
      webSearch: true,
      timeoutMs: 150_000,
    })
    if (!res.ok) {
      return { items: [], drafted: 0, localDrops: 0, verifyDrops: 0, error: res.error }
    }
    const raw = (res.value?.items ?? []) as DraftItem[]

    // Free gates first — never pay a verifier to look at an item we can
    // already tell is unusable.
    const passed: DraftItem[] = []
    for (const item of raw) {
      const why = localReject(item, nOptions)
      if (why) {
        console.log(pc.dim(`      drop ${month}: ${why}`))
        continue
      }
      // Trim the surplus down to the shipping set here, so the verifier
      // only ever sees the statements that will actually appear.
      const picked = selectDistractors(
        item.fact.trim(),
        item.distractors.map((d) => d.trim()),
        nOptions - 1
      )
      if ("reject" in picked) {
        console.log(pc.dim(`      drop ${month}: ${picked.reject}`))
        continue
      }
      passed.push({ ...item, distractors: picked.chosen })
    }

    let accepted = passed
    let verifyDrops = 0
    if (verify && passed.length > 0) {
      const verdicts = await pMap(
        passed,
        async (item) => {
          const v = await askJson({
            apiKey,
            model: verifier,
            messages: [{ role: "user", content: verifyPrompt(month, item) }],
            responseFormat: {
              type: "json_schema",
              json_schema: { name: "verdict", strict: true, schema: VERIFY_SCHEMA },
            },
            temperature: 0,
            maxTokens,
            webSearch: true,
            timeoutMs: 150_000,
          })
          if (!v.ok) return { item, ok: false, reason: `verifier: ${v.error}` }
          return {
            item,
            ok:
              v.value?.fact_confirmed === true &&
              v.value?.any_distractor_real === false,
            reason: String(v.value?.reason ?? ""),
          }
        },
        { concurrency: Math.min(perMonth, 5) }
      )
      for (const v of verdicts) {
        if (!v.ok) console.log(pc.dim(`      drop ${month}: ${v.reason.slice(0, 90)}`))
      }
      accepted = verdicts.filter((v) => v.ok).map((v) => v.item)
      verifyDrops = verdicts.length - accepted.length
    }

    return {
      items: accepted,
      drafted: raw.length,
      localDrops: raw.length - passed.length,
      verifyDrops,
    }
  }

  // Accumulating bank, flushed after every month.
  const bank: QuizBank = {
    version,
    built_at: new Date().toISOString(),
    builder_model: builder,
    ...(verify ? { verifier_model: verifier } : {}),
    n_options: nOptions,
    months: [...have].sort((a, b) => monthOrdinal(a) - monthOrdinal(b)),
    items: [...(existing?.items ?? [])],
  }

  // Months run concurrently, so serialise the read-modify-write.
  let flushing: Promise<void> = Promise.resolve()
  /**
   * Ids are assigned HERE rather than in buildMonth, because their index
   * has to be relative to what the bank already holds for that month. A
   * top-up that restarted numbering at 0 would collide with the existing
   * items and fail validation — inside the flush, i.e. after the calls
   * were paid for.
   */
  function flush(month: string, drafts: DraftItem[]): Promise<void> {
    flushing = flushing.then(() => {
      const offset = bank.items.filter((it) => it.month === month).length
      const items: QuizItem[] = drafts.map((d, i) => {
        const id = `${month}-${String(offset + i).padStart(2, "0")}-${slug(d.fact)}`
        const { options, answer } = shuffleOptions(
          id,
          d.fact.trim(),
          d.distractors.map((x) => x.trim())
        )
        return {
          id,
          month,
          domain: d.domain,
          options,
          answer,
          source: { url: d.source_url, title: d.source_title },
        }
      })
      bank.items.push(...items)
      bank.items.sort(
        (a, b) => monthOrdinal(a.month) - monthOrdinal(b.month) || a.id.localeCompare(b.id)
      )
      bank.months = [...new Set(bank.items.map((it) => it.month))].sort(
        (a, b) => monthOrdinal(a) - monthOrdinal(b)
      )
      bank.built_at = new Date().toISOString()
      validateBank(bank)
      mkdirSync(dirname(outPath), { recursive: true })
      // Write-then-rename so an interrupt can't leave a half-written file.
      const tmp = `${outPath}.tmp`
      writeFileSync(tmp, JSON.stringify(bank, null, 2))
      renameSync(tmp, outPath)
    })
    return flushing
  }

  let done = 0
  let failed = 0
  await pMap(
    todo,
    async (month) => {
      const held = bank.items.filter((it) => it.month === month)
      const want = topUpTo > 0 ? Math.max(1, topUpTo - held.length) : perMonth
      // Show the builder what this month already has so a top-up gets
      // new events rather than paraphrases of the ones we banked.
      const avoid = held.map((it) => it.options[it.answer])
      const r = await buildMonth(month, want, avoid)
      // A month that yielded nothing leaves the file alone — no point
      // rewriting the bank to bump its timestamp.
      if (r.items.length > 0) await flush(month, r.items)
      done++
      const elapsed = (Date.now() - startedAt) / 1000
      const eta = done === 0 ? 0 : (elapsed / done) * (todo.length - done)
      const status = r.error
        ? pc.red(`✗ ${r.error.slice(0, 60)}`)
        : pc.green(`${r.items.length} kept`) +
          (r.localDrops + r.verifyDrops > 0
            ? pc.dim(` (${r.localDrops + r.verifyDrops} dropped)`)
            : "")
      if (r.error) failed++
      console.log(
        `  [${done}/${todo.length}] ${month} — ${status}` +
          pc.dim(
            ` · ${bank.items.length} items banked · ${fmtDuration(eta)} left${await billedSoFar()}`
          )
      )
    },
    { concurrency }
  )

  const audit = auditBank(bank)
  const thin = bank.months.filter(
    (m) => bank.items.filter((it) => it.month === m).length < Math.max(2, Math.ceil(perMonth / 2))
  )
  console.log()
  console.log(pc.green(`✓ Wrote ${outPath}`))
  console.log(
    pc.dim(`  ${bank.items.length} items · ${bank.months.length} months · ${nOptions}-way · version ${version}`)
  )
  if (failed > 0) {
    console.log(
      pc.yellow(`  ${failed} month(s) failed outright — re-run to retry just those.`)
    )
  }
  if (thin.length > 0) {
    console.log(
      pc.yellow(
        `  Thin months (delete them from the bank and re-run to top up): ${thin.join(", ")}`
      )
    )
  }
  console.log(
    pc.dim(
      `  audit: true answer is shortest in ${Math.round(audit.shortest_rate * 100)}% of items, ` +
        `longest in ${Math.round(audit.longest_rate * 100)}% (chance ${Math.round((100 / nOptions))}%)`
    )
  )
  for (const w of audit.warnings) {
    console.log(pc.yellow(`  ⚠ ${w}`))
  }
  const usageAtEnd = await getKeyUsage(apiKey)
  if (usageAtStart !== null && usageAtEnd !== null) {
    console.log(pc.bold(`  Billed: $${Math.max(0, usageAtEnd - usageAtStart).toFixed(4)}`))
  }
  console.log()
  console.log(pc.bold("Next:"))
  console.log("  Skim the bank — the true answers should not stand out.")
  console.log("  git add data/cutoff-quiz.json && git commit -m \"cutoff: quiz bank\"")
  console.log("  pnpm cutoff")

  /** Running total billed on this key since the build started. */
  async function billedSoFar(): Promise<string> {
    if (usageAtStart === null) return ""
    const now = await getKeyUsage(apiKey)
    if (now === null) return ""
    return ` · $${Math.max(0, now - usageAtStart).toFixed(2)}`
  }
}

/**
 * One grounded call that must come back as JSON.
 *
 * Retries once on failure, because grounded calls fail transiently often
 * enough (rate limits, upstream search timeouts) that losing a whole
 * month to one blip costs more than the extra call.
 *
 * Truncation is treated as a failure and retried, not passed to the
 * parser. Several capable models reason internally before writing a
 * single visible character: gemini-2.5-pro spent 1,436 tokens thinking
 * about a two-boolean verdict and got cut off mid-string, which reaches
 * the parser as "unparseable" and looks like a model quality problem
 * rather than a ceiling that is too low. Checking finish_reason names
 * the real fault.
 */
async function askJson(
  opts: Parameters<typeof openrouterChat>[0]
): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  let lastError = "unknown"
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000))
    const res = await openrouterChat(opts)
    if (!res.success) {
      lastError = res.message
      continue
    }
    if (res.raw?.choices?.[0]?.finish_reason === "length") {
      lastError = `response truncated at ${opts.maxTokens} tokens (raise --max-tokens, or use a model that reasons less)`
      continue
    }
    try {
      return { ok: true, value: extractJson(res.text) }
    } catch {
      lastError = `unparseable JSON: ${res.text.slice(0, 120)}`
    }
  }
  return { ok: false, error: lastError }
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m"
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

/** 36 months back — long enough to see a plateau before any current cutoff. */
function defaultFrom(to: string): string {
  const [y, m] = to.split("-").map(Number)
  const ord = y * 12 + (m - 1) - 35
  return `${String(Math.floor(ord / 12)).padStart(4, "0")}-${String((ord % 12) + 1).padStart(2, "0")}`
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
}

// Importing this module for its helpers (tests) must not kick off a build.
if (process.argv[1]?.endsWith("build-quiz.ts")) {
  await main()
}
