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
  assembleItems,
  auditBank,
  shuffleOptions,
  validateBank,
  type QuizBank,
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
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string" },
          domain: { type: "string" },
          source_url: { type: "string" },
          source_title: { type: "string" },
        },
        required: ["statement", "domain", "source_url", "source_title"],
      },
    },
  },
  required: ["events"],
}

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    confirmed: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["confirmed", "reason"],
}

type DraftEvent = {
  statement: string
  domain: string
  source_url: string
  source_title: string
}

function draftPrompt(
  month: string,
  count: number,
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
Produce ${count} statements, each describing a DIFFERENT thing that actually
happened in ${monthLabel(month)}.

Spread them across these domains, one each where possible: ${domains}.

Rules:
- Each must be well documented — the kind of event a Wikipedia
  "${monthLabel(month)}" or "${month.slice(0, 4)} in review" page records. Give the
  source URL you used for each.
- It must have happened in ${monthLabel(month)}, not the month before or after.
- Prefer outcomes that could NOT have been confidently predicted a year earlier.
  The result of a scheduled event is good; the fact that one was scheduled is not.
- 15-25 words. Declarative. Named actors and concrete specifics in every one.
- NEVER mention a month name, a year, or a relative date ("last week"). The quiz
  asks the reader WHICH MONTH this happened in — a date in the text gives it away.
- Write them all to one standard. Every statement becomes a wrong answer in other
  months' questions, so a statement that reads differently from the rest is a tell
  wherever it appears.

Respond ONLY with JSON:
{"events":[{"statement":"...","domain":"...","source_url":"https://...","source_title":"..."}]}`
}

function verifyPrompt(month: string, event: DraftEvent): string {
  return `Check one statement using web search.

Statement, claimed to describe something that happened in ${monthLabel(month)}:
  ${event.statement}

Answer:
1. confirmed — did this really happen, and in ${monthLabel(month)}? Answer false if
   it happened in a different month, or if you cannot confirm it. The month matters:
   this statement becomes a wrong answer in other months' questions, so a wrong date
   corrupts the quiz in both directions.

Respond ONLY with JSON:
{"confirmed":true,"reason":"one sentence"}`
}

// ── Local quality gates (free — run before spending on verification) ──

const DATE_LEAK_RE =
  /\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(last|next|this)\s+(week|month|year)\b/i

/**
 * Reject events that would give their own month away, or that can't be
 * audited later. Length is no longer policed here: every option in a
 * finished item is one of these statements, written to the same brief, so
 * there is no "real one reads differently" tell left to gate against.
 * auditBank still measures it on the assembled quiz.
 */
function localReject(event: DraftEvent): string | null {
  if (!event?.statement?.trim()) return "empty statement"
  const leak = event.statement.match(DATE_LEAK_RE)
  if (leak) return `date leak: "${leak[0]}"`
  if (!/^https?:\/\//.test(event.source_url ?? "")) return "missing source url"
  return null
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
  const have = new Set(existing?.events.map((e) => e.month) ?? [])
  const countFor = (m: string) =>
    existing?.events.filter((e) => e.month === m).length ?? 0
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
      pc.dim(`  existing:  ${existing.events.length} events across ${have.size} months (kept)`)
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
    events: DraftEvent[]
    drafted: number
    localDrops: number
    verifyDrops: number
    error?: string
  }> {
    const res = await askJson({
      apiKey,
      model: builder,
      messages: [{ role: "user", content: draftPrompt(month, want, avoid) }],
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "events", strict: true, schema: DRAFT_SCHEMA },
      },
      temperature: 0.4,
      maxTokens,
      webSearch: true,
      timeoutMs: 150_000,
    })
    if (!res.ok) {
      return { events: [], drafted: 0, localDrops: 0, verifyDrops: 0, error: res.error }
    }
    const raw = (res.value?.events ?? []) as DraftEvent[]

    // Free gates first — never pay a verifier to look at a statement we
    // can already tell is unusable.
    const passed: DraftEvent[] = []
    for (const event of raw) {
      const why = localReject(event)
      if (why) {
        console.log(pc.dim(`      drop ${month}: ${why}`))
        continue
      }
      passed.push(event)
    }

    let accepted = passed
    let verifyDrops = 0
    if (verify && passed.length > 0) {
      const verdicts = await pMap(
        passed,
        async (event) => {
          const v = await askJson({
            apiKey,
            model: verifier,
            messages: [{ role: "user", content: verifyPrompt(month, event) }],
            responseFormat: {
              type: "json_schema",
              json_schema: { name: "verdict", strict: true, schema: VERIFY_SCHEMA },
            },
            temperature: 0,
            maxTokens,
            webSearch: true,
            timeoutMs: 150_000,
          })
          if (!v.ok) return { event, ok: false, reason: `verifier: ${v.error}` }
          return {
            event,
            ok: v.value?.confirmed === true,
            reason: String(v.value?.reason ?? ""),
          }
        },
        { concurrency: Math.min(want, 5) }
      )
      for (const v of verdicts) {
        if (!v.ok) console.log(pc.dim(`      drop ${month}: ${v.reason.slice(0, 90)}`))
      }
      accepted = verdicts.filter((v) => v.ok).map((v) => v.event)
      verifyDrops = verdicts.length - accepted.length
    }

    return {
      events: accepted,
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
    events: [...(existing?.events ?? [])],
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
  function flush(month: string, drafts: DraftEvent[]): Promise<void> {
    flushing = flushing.then(() => {
      const offset = bank.events.filter((e) => e.month === month).length
      const seen = new Set(bank.events.map((e) => e.statement.trim().toLowerCase()))
      const fresh = drafts.filter((d) => !seen.has(d.statement.trim().toLowerCase()))
      bank.events.push(
        ...fresh.map((d, i) => ({
          id: `${month}-${String(offset + i).padStart(2, "0")}-${slug(d.statement)}`,
          month,
          domain: d.domain,
          statement: d.statement.trim(),
          source: { url: d.source_url, title: d.source_title },
        }))
      )
      bank.events.sort(
        (a, b) => monthOrdinal(a.month) - monthOrdinal(b.month) || a.id.localeCompare(b.id)
      )
      bank.months = [...new Set(bank.events.map((e) => e.month))].sort(
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
      const held = bank.events.filter((e) => e.month === month)
      const want = topUpTo > 0 ? Math.max(1, topUpTo - held.length) : perMonth
      // Show the builder what this month already has so a top-up gets
      // new events rather than paraphrases of the ones we banked.
      const avoid = held.map((e) => e.statement)
      const r = await buildMonth(month, want, avoid)
      // A month that yielded nothing leaves the file alone — no point
      // rewriting the bank to bump its timestamp.
      if (r.events.length > 0) await flush(month, r.events)
      done++
      const elapsed = (Date.now() - startedAt) / 1000
      const eta = done === 0 ? 0 : (elapsed / done) * (todo.length - done)
      const status = r.error
        ? pc.red(`✗ ${r.error.slice(0, 60)}`)
        : pc.green(`${r.events.length} kept`) +
          (r.localDrops + r.verifyDrops > 0
            ? pc.dim(` (${r.localDrops + r.verifyDrops} dropped)`)
            : "")
      if (r.error) failed++
      console.log(
        `  [${done}/${todo.length}] ${month} — ${status}` +
          pc.dim(
            ` · ${bank.events.length} events banked · ${fmtDuration(eta)} left${await billedSoFar()}`
          )
      )
    },
    { concurrency }
  )

  const assembled = assembleItems(bank.events, { nOptions })
  const audit = auditBank(bank, assembled)
  const thin = bank.months.filter(
    (m) => bank.events.filter((e) => e.month === m).length < Math.max(2, Math.ceil(perMonth / 2))
  )
  console.log()
  console.log(pc.green(`✓ Wrote ${outPath}`))
  console.log(
    pc.dim(
      `  ${bank.events.length} events · ${bank.months.length} months · ${nOptions}-way · version ${version}`
    )
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
