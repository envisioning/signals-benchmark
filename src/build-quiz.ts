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
 *   pnpm cutoff:build --rebuild                      (ignore the existing bank)
 *   pnpm cutoff:build --dry-run
 *
 * Default behaviour is APPEND: months already in data/cutoff-quiz.json
 * are left untouched and only missing months are drafted. That's what
 * makes the quarterly "extend the tail" refresh cheap, and it keeps old
 * buckets byte-identical so previously published curves stay valid.
 *
 * Cost: roughly $0.03-0.06 per item with verification on. A 36-month
 * window at 5 items/month lands around $6-10 as a one-off; extending
 * the tail by a quarter costs well under a dollar.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  shuffleOptions,
  validateBank,
  type QuizBank,
  type QuizItem,
} from "./cutoff-quiz.ts"

const DEFAULT_BUILDER = "openai/gpt-5.4:online"
const DEFAULT_VERIFIER = "google/gemini-2.5-pro:online"
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

function draftPrompt(month: string, count: number, nOptions: number): string {
  const domains = DOMAINS.slice(0, count).join("; ")
  return `Search the web for notable events from ${monthLabel(month)}.

Produce ${count} quiz items. Each item is one TRUE statement about something that
actually happened in ${monthLabel(month)}, plus ${nOptions - 1} FALSE statements.

Spread the items across these domains, one each where possible: ${domains}.

Rules for the TRUE statement:
- It must be well documented — the kind of event a Wikipedia "${monthLabel(month)}" or
  "${month.slice(0, 4)} in review" page records. Give the source URL you used.
- It must have happened in ${monthLabel(month)}, not the month before or after.
- Prefer outcomes that could NOT have been confidently predicted a year earlier.
  The result of a scheduled event is good; the fact that a scheduled event was
  scheduled is not.

Rules for the FALSE statements:
- Plausible but untrue. They must not describe anything that really happened at
  any time, in any month — a distractor that is real elsewhere in the timeline
  makes the item unscoreable.
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
Each item needs exactly ${nOptions - 1} distractors.`
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
  if (!Array.isArray(item.distractors) || item.distractors.length !== nOptions - 1) {
    return `expected ${nOptions - 1} distractors, got ${item.distractors?.length ?? 0}`
  }
  const all = [item.fact, ...item.distractors].map((s) => s.trim())
  if (all.some((s) => !s)) return "empty option"
  if (new Set(all.map((s) => s.toLowerCase())).size !== all.length) return "duplicate options"
  for (const s of all) {
    const leak = s.match(DATE_LEAK_RE)
    if (leak) return `date leak in option: "${leak[0]}"`
  }
  const lens = item.distractors.map((d) => d.trim().length).sort((a, b) => a - b)
  const median = lens[Math.floor(lens.length / 2)]
  const ratio = item.fact.trim().length / Math.max(1, median)
  if (ratio > 1.6 || ratio < 0.6) return `fact length outlier (${ratio.toFixed(2)}x median)`
  if (!/^https?:\/\//.test(item.source_url ?? "")) return "missing source url"
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
  const concurrency = Number(args.concurrency ?? 4)
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
  const todo = allMonths.filter((m) => !have.has(m))

  const version =
    (args.version as string) ??
    existing?.version ??
    `${new Date().toISOString().slice(0, 7)}-v1`

  console.log(pc.bold(pc.cyan("\ncutoff:build")))
  console.log(pc.dim(`  window:    ${from} … ${to} (${allMonths.length} months)`))
  console.log(pc.dim(`  to draft:  ${todo.length} months × ${perMonth} items`))
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

  const drafted: { month: string; item: DraftItem }[] = []
  let done = 0
  await pMap(
    todo,
    async (month) => {
      const res = await openrouterChat({
        apiKey,
        model: builder,
        messages: [{ role: "user", content: draftPrompt(month, perMonth, nOptions) }],
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "quiz_items", strict: true, schema: DRAFT_SCHEMA },
        },
        temperature: 0.4,
        maxTokens: 8000,
        webSearch: true,
        timeoutMs: 300_000,
      })
      done++
      if (!res.success) {
        console.log(`  [${done}/${todo.length}] ${month} — ${pc.red(res.message.slice(0, 70))}`)
        return
      }
      let items: DraftItem[] = []
      try {
        items = (extractJson(res.text)?.items ?? []) as DraftItem[]
      } catch {
        console.log(`  [${done}/${todo.length}] ${month} — ${pc.red("unparseable draft")}`)
        return
      }
      let kept = 0
      for (const item of items) {
        const why = localReject(item, nOptions)
        if (why) {
          console.log(pc.dim(`      drop ${month}: ${why}`))
          continue
        }
        drafted.push({ month, item })
        kept++
      }
      console.log(
        `  [${done}/${todo.length}] ${month} — ${pc.green(`${kept} drafted`)}${
          kept < items.length ? pc.dim(` (${items.length - kept} rejected locally)`) : ""
        }`
      )
    },
    { concurrency }
  )

  let accepted = drafted
  if (verify && drafted.length > 0) {
    console.log(pc.bold(`\nVerifying ${drafted.length} items with ${verifier}`))
    let vdone = 0
    const verdicts = await pMap(
      drafted,
      async (d) => {
        const res = await openrouterChat({
          apiKey,
          model: verifier,
          messages: [{ role: "user", content: verifyPrompt(d.month, d.item) }],
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "verdict", strict: true, schema: VERIFY_SCHEMA },
          },
          temperature: 0,
          maxTokens: 1500,
          webSearch: true,
          timeoutMs: 300_000,
        })
        vdone++
        if (!res.success) return { d, ok: false, reason: `verifier error: ${res.message}` }
        try {
          const v = extractJson(res.text)
          const ok = v?.fact_confirmed === true && v?.any_distractor_real === false
          return { d, ok, reason: String(v?.reason ?? "") }
        } catch {
          return { d, ok: false, reason: "unparseable verdict" }
        }
      },
      { concurrency }
    )
    const rejected = verdicts.filter((v) => !v.ok)
    for (const r of rejected) {
      console.log(pc.dim(`      drop ${r.d.month}: ${r.reason.slice(0, 90)}`))
    }
    accepted = verdicts.filter((v) => v.ok).map((v) => v.d)
    console.log(
      pc.dim(`  verified ${accepted.length}/${drafted.length} (${rejected.length} dropped)`)
    )
  }

  const newItems: QuizItem[] = accepted.map(({ month, item }, i) => {
    const id = `${month}-${String(i).padStart(3, "0")}-${slug(item.fact)}`
    const { options, answer } = shuffleOptions(id, item.fact.trim(), item.distractors.map((d) => d.trim()))
    return {
      id,
      month,
      domain: item.domain,
      options,
      answer,
      source: { url: item.source_url, title: item.source_title },
    }
  })

  const items = [...(existing?.items ?? []), ...newItems].sort(
    (a, b) => monthOrdinal(a.month) - monthOrdinal(b.month) || a.id.localeCompare(b.id)
  )
  const bank: QuizBank = {
    version,
    built_at: new Date().toISOString(),
    builder_model: builder,
    ...(verify ? { verifier_model: verifier } : {}),
    n_options: nOptions,
    months: [...new Set(items.map((it) => it.month))].sort(
      (a, b) => monthOrdinal(a) - monthOrdinal(b)
    ),
    items,
  }
  validateBank(bank)

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(bank, null, 2))

  const thin = bank.months.filter(
    (m) => items.filter((it) => it.month === m).length < Math.max(2, Math.ceil(perMonth / 2))
  )
  console.log()
  console.log(pc.green(`✓ Wrote ${outPath}`))
  console.log(
    pc.dim(`  ${bank.items.length} items · ${bank.months.length} months · ${nOptions}-way · version ${version}`)
  )
  if (thin.length > 0) {
    console.log(
      pc.yellow(
        `  Thin months (re-run to top up): ${thin.join(", ")}`
      )
    )
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

await main()
