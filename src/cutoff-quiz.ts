/**
 * The frozen quiz bank behind the knowledge-cutoff probe.
 *
 * Method adapted from Shrivu Shankar's write-up on estimating model
 * knowledge cutoffs (https://blog.sshh.io/p/exploring-claudegpt-knowledge-cutoffs):
 * quiz a model with N-way multiple-choice questions about real events
 * bucketed by month, then read the cutoff off the error-rate curve.
 *
 * The bank is a build artifact, not hand-written: `pnpm cutoff:build`
 * asks a web-grounded model to draft items month by month and (by
 * default) has a second grounded model verify them. The result is
 * committed to `data/cutoff-quiz.json` so every model in a cohort
 * answers the exact same questions — that's the whole point, and it's
 * why this file is the loader/validator rather than the source of the
 * items.
 *
 * Treat a published bank as IMMUTABLE the same way BRIEFS is. Adding
 * months to the tail is fine (older buckets keep their items, so old
 * curves stay comparable); editing or removing existing items is not —
 * bump `version` and publish a new file instead.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * How far away, in months, a distractor event must be drawn from.
 *
 * Calibrated against models with published cutoffs: at a 2-month gap even
 * gpt-4.1 could not reliably place events it knew (plateau 50%), which
 * flattens the step the estimator is looking for. At 9 months the plateau
 * reaches 99% while the estimate stays put, so the gap buys dynamic range
 * without moving the answer. The cost is temporal resolution: this cannot
 * distinguish cutoffs a month or two apart, and does not claim to.
 */
export const DEFAULT_MONTH_GAP = 9

/** Default on-disk location, relative to the repo root. */
export const DEFAULT_BANK_PATH = "data/cutoff-quiz.json"

/** Letters used to label options in the prompt. Caps the bank at 8-way. */
export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const

export type QuizItem = {
  /** Stable id — also the shuffle seed, so option order is fixed forever. */
  id: string
  /** Bucket this item scores into, "YYYY-MM". */
  month: string
  /** Loose topical tag ("politics", "science", ...) — used for build-time balance. */
  domain: string
  /** Exactly `n_options` statements; exactly one of them really happened. */
  options: string[]
  /** Index into `options` of the true statement. */
  answer: number
  /** Where the builder found the true statement. Kept for auditability. */
  source?: { url: string; title?: string }
}

export type QuizBank = {
  version: string
  built_at: string
  builder_model: string
  verifier_model?: string
  n_options: number
  /** Ascending "YYYY-MM" list. May be sparse if a month yielded nothing. */
  months: string[]
  /**
   * Verified real events, one per quiz question. The bank stores EVENTS
   * rather than finished multiple-choice items because each item's wrong
   * options are other months' events — see assembleItems. Adding a month
   * therefore enriches the distractor pool for every other month too.
   */
  events: QuizEvent[]
}

// ── Month helpers ────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s)
}

/** "2025-03" → 24303 (months since year 0). Cheap, order-preserving. */
export function monthOrdinal(month: string): number {
  const [y, m] = month.split("-").map(Number)
  return y * 12 + (m - 1)
}

export function ordinalToMonth(ord: number): string {
  const y = Math.floor(ord / 12)
  const m = (ord % 12) + 1
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`
}

/** Inclusive ascending range of months. */
export function monthRange(from: string, to: string): string[] {
  const a = monthOrdinal(from)
  const b = monthOrdinal(to)
  if (b < a) return []
  const out: string[] = []
  for (let i = a; i <= b; i++) out.push(ordinalToMonth(i))
  return out
}

/** "2025-03" → "March 2025". Used in prompts and reports. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  })
  return `${name} ${y}`
}

/** The most recent month that has fully elapsed, relative to `now`. */
export function lastCompleteMonth(now = new Date()): string {
  return ordinalToMonth(
    monthOrdinal(
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
    ) - 1
  )
}

// ── Deterministic shuffle ────────────────────────────────────────────

/** xmur3 string hash → 32-bit seed. Keeps option order stable per item id. */
function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Shuffle `options` deterministically from `id` and report where the
 * true statement landed. Called at build time so the committed bank is
 * inspectable — but seeded rather than random so a rebuild of the same
 * item produces the same layout.
 */
export function shuffleOptions(
  id: string,
  correct: string,
  distractors: string[]
): { options: string[]; answer: number } {
  const options = [correct, ...distractors]
  const rand = prng(seedFrom(id))
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return { options, answer: options.indexOf(correct) }
}

// ── Assembly ─────────────────────────────────────────────────────────

/** One verified real event. The unit the bank is actually built from. */
export type QuizEvent = {
  id: string
  month: string
  domain: string
  /** Present tense, no dates — see the date-leak gate in build-quiz.ts. */
  statement: string
  source?: { url: string; title?: string }
}

/**
 * Assemble multiple-choice items where EVERY option is a real event and
 * only the month differs.
 *
 * Fabricated distractors don't work, however they are written. Invent
 * the entity names and a model rules them out by recognising that no
 * such mission exists; use real entities and it rules them out because
 * the claim is implausible. Either way it scores far above chance on
 * months it cannot know: gpt-4.1-mini, cutoff 2024-06, scored 40% and
 * then 72% on those two designs against 12.5% chance.
 *
 * Drawing the distractors from other months' verified events removes the
 * shortcut: all eight options really happened, all are plausible, and the
 * only thing that separates them is knowing WHEN. That is the quantity we
 * are trying to measure.
 *
 * Distractors are taken at least `minMonthGap` months away so an event
 * that straddles a month boundary can't make an item ambiguous, and from
 * the same domain where possible so the answer isn't "the one about
 * sport". Selection is seeded by the event id, so the same pool always
 * assembles the same quiz.
 */
export function assembleItems(
  events: QuizEvent[],
  {
    nOptions,
    minMonthGap = 2,
  }: { nOptions: number; minMonthGap?: number }
): QuizItem[] {
  const items: QuizItem[] = []
  for (const event of events) {
    const rand = prng(seedFrom(`${event.id}::assemble`))
    const far = events.filter(
      (e) =>
        e.id !== event.id &&
        Math.abs(monthOrdinal(e.month) - monthOrdinal(event.month)) >= minMonthGap &&
        e.statement !== event.statement
    )
    // Same domain first; top up from the rest of the pool when a domain
    // is too thin to fill the item on its own.
    const sameDomain = far.filter((e) => e.domain === event.domain)
    const others = far.filter((e) => e.domain !== event.domain)
    const pick = (pool: QuizEvent[], n: number): QuizEvent[] => {
      const copy = [...pool]
      const out: QuizEvent[] = []
      while (out.length < n && copy.length > 0) {
        out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0])
      }
      return out
    }
    const need = nOptions - 1
    const chosen = pick(sameDomain, need)
    if (chosen.length < need) chosen.push(...pick(others, need - chosen.length))
    if (chosen.length < need) continue // pool too small to build this item

    const { options, answer } = shuffleOptions(
      event.id,
      event.statement,
      chosen.map((e) => e.statement)
    )
    items.push({
      id: event.id,
      month: event.month,
      domain: event.domain,
      options,
      answer,
      ...(event.source ? { source: event.source } : {}),
    })
  }
  return items
}

// ── Load + validate ──────────────────────────────────────────────────

export class QuizBankError extends Error {}

/**
 * Read and validate a bank. Throws `QuizBankError` with an actionable
 * message — the runner surfaces it verbatim, because the most common
 * failure by far is "you haven't built a bank yet".
 */
export function loadQuizBank(path = DEFAULT_BANK_PATH): QuizBank {
  const abs = resolve(path)
  if (!existsSync(abs)) {
    throw new QuizBankError(
      `No quiz bank at ${abs}.\n` +
        `Build one first (one-off, web-grounded, ~$1-3):\n` +
        `  pnpm cutoff:build --from 2023-01\n` +
        `Then commit data/cutoff-quiz.json so runs stay comparable.`
    )
  }
  let bank: QuizBank
  try {
    bank = JSON.parse(readFileSync(abs, "utf-8")) as QuizBank
  } catch (e: any) {
    throw new QuizBankError(`Quiz bank at ${abs} is not valid JSON: ${e?.message ?? e}`)
  }
  validateBank(bank)
  if (bank.events.length === 0) {
    throw new QuizBankError(
      `Quiz bank at ${abs} has no events.\n` +
        `Every draft was rejected, or the build failed before writing any month.\n` +
        `Re-run: pnpm cutoff:build --from <YYYY-MM>`
    )
  }
  return bank
}

/** Structural validation. Exported so `cutoff:build` can check before writing. */
export function validateBank(bank: QuizBank): void {
  const fail = (msg: string) => {
    throw new QuizBankError(`Invalid quiz bank: ${msg}`)
  }
  if (!bank || typeof bank !== "object") fail("not an object")
  if (typeof bank.version !== "string" || !bank.version) fail("missing version")
  if (!Number.isInteger(bank.n_options)) fail("missing n_options")
  if (bank.n_options < 2 || bank.n_options > OPTION_LETTERS.length) {
    fail(`n_options must be 2..${OPTION_LETTERS.length}, got ${bank.n_options}`)
  }
  // Emptiness is NOT a structural error: `cutoff:build` validates the
  // bank after every month it writes, and the first month can legitimately
  // yield nothing. Usability is checked in loadQuizBank instead.
  if (!Array.isArray(bank.events)) fail("events must be an array")

  const seen = new Set<string>()
  const seenStatements = new Set<string>()
  for (const [i, e] of bank.events.entries()) {
    const where = `events[${i}]${e?.id ? ` (${e.id})` : ""}`
    if (!e?.id) fail(`${where}: missing id`)
    if (seen.has(e.id)) fail(`${where}: duplicate id`)
    seen.add(e.id)
    if (!isMonth(e.month)) fail(`${where}: month must be YYYY-MM, got ${e.month}`)
    if (typeof e.statement !== "string" || e.statement.trim().length === 0) {
      fail(`${where}: empty statement`)
    }
    // A statement repeated under two months would appear twice in one
    // item — one of them as a wrong answer that is actually right.
    const key = e.statement.trim().toLowerCase()
    if (seenStatements.has(key)) fail(`${where}: duplicate statement`)
    seenStatements.add(key)
  }
}

/**
 * Assemble the quiz for a window.
 *
 * Distractors are drawn from the WHOLE bank, not just the window: a
 * narrow window would otherwise leave a thin pool, and an item whose
 * wrong options all come from two nearby months is both easier and less
 * comparable to the same item in a wider run.
 */
export function itemsForMonths(
  bank: QuizBank,
  months: string[],
  minMonthGap = DEFAULT_MONTH_GAP
): QuizItem[] {
  const want = new Set(months)
  const all = assembleItems(bank.events, {
    nOptions: bank.n_options,
    minMonthGap,
  })
  return all.filter((it) => want.has(it.month))
}

// ── Audit ────────────────────────────────────────────────────────────

export type BankAudit = {
  n_items: number
  n_months: number
  /** Share of items whose true option is the shortest of the set. */
  shortest_rate: number
  /** Share whose true option is the longest. */
  longest_rate: number
  /** Answer-position counts, index 0..n_options-1. */
  position_counts: number[]
  /** Largest deviation of any position's share from uniform. */
  position_bias: number
  /** Items per month, ascending by month. */
  per_month: { month: string; n: number }[]
  warnings: string[]
}

/**
 * Look for the tells that would let a model score above chance WITHOUT
 * knowing what happened — the failure mode that quietly inflates every
 * model's plateau and pushes every estimated cutoff later.
 *
 * The one that shows up in practice is length: a real event gets stated
 * plainly while invented ones get embellished, so "pick the shortest"
 * becomes a winning strategy. Chance is 1/n_options; anything much above
 * that is a bank problem, not a model result.
 */
export function auditBank(bank: QuizBank, items: QuizItem[]): BankAudit {
  const n = items.length
  const chance = 1 / bank.n_options
  let shortest = 0
  let longest = 0
  const positions = new Array<number>(bank.n_options).fill(0)

  for (const it of items) {
    const lens = it.options.map((o) => o.length)
    const answerLen = lens[it.answer]
    if (answerLen === Math.min(...lens)) shortest++
    if (answerLen === Math.max(...lens)) longest++
    positions[it.answer]++
  }

  const shortest_rate = n === 0 ? 0 : shortest / n
  const longest_rate = n === 0 ? 0 : longest / n
  const position_bias =
    n === 0 ? 0 : Math.max(...positions.map((c) => Math.abs(c / n - chance)))

  const perMonthMap = new Map<string, number>()
  for (const it of items) {
    perMonthMap.set(it.month, (perMonthMap.get(it.month) ?? 0) + 1)
  }
  const per_month = [...perMonthMap.entries()]
    .map(([month, count]) => ({ month, n: count }))
    .sort((a, b) => monthOrdinal(a.month) - monthOrdinal(b.month))

  const warnings: string[] = []
  // 2x chance is the line: below it, a length heuristic buys a model
  // less than a coin flip's worth of edge over the window.
  if (n >= 20 && shortest_rate > chance * 2) {
    warnings.push(
      `true answer is the shortest option in ${pct(shortest_rate)} of items (chance ${pct(chance)}) — "pick the shortest" beats guessing`
    )
  }
  if (n >= 20 && shortest_rate + longest_rate > chance * 4) {
    warnings.push(
      `true answer is an extreme by length in ${pct(shortest_rate + longest_rate)} of items — check the events are written to one standard`
    )
  }
  if (n >= 20 && longest_rate > chance * 2) {
    warnings.push(
      `true answer is the longest option in ${pct(longest_rate)} of items (chance ${pct(chance)})`
    )
  }
  if (n >= 40 && position_bias > chance) {
    warnings.push(
      `answer positions are uneven (worst slot deviates ${pct(position_bias)} from uniform)`
    )
  }
  return {
    n_items: n,
    n_months: per_month.length,
    shortest_rate,
    longest_rate,
    position_counts: positions,
    position_bias,
    per_month,
    warnings,
  }
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** Distinct months present in `items`, ascending. */
export function monthsPresent(items: QuizItem[]): string[] {
  return [...new Set(items.map((it) => it.month))].sort(
    (a, b) => monthOrdinal(a) - monthOrdinal(b)
  )
}
