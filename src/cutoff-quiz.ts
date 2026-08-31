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
  /** Ascending "YYYY-MM" list. May be sparse if a month yielded no items. */
  months: string[]
  items: QuizItem[]
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
  if (!Array.isArray(bank.items) || bank.items.length === 0) fail("no items")

  const seen = new Set<string>()
  for (const [i, it] of bank.items.entries()) {
    const where = `items[${i}]${it?.id ? ` (${it.id})` : ""}`
    if (!it?.id) fail(`${where}: missing id`)
    if (seen.has(it.id)) fail(`${where}: duplicate id`)
    seen.add(it.id)
    if (!isMonth(it.month)) fail(`${where}: month must be YYYY-MM, got ${it.month}`)
    if (!Array.isArray(it.options) || it.options.length !== bank.n_options) {
      fail(`${where}: expected ${bank.n_options} options, got ${it.options?.length}`)
    }
    if (new Set(it.options).size !== it.options.length) fail(`${where}: duplicate options`)
    if (!Number.isInteger(it.answer) || it.answer < 0 || it.answer >= bank.n_options) {
      fail(`${where}: answer index out of range`)
    }
  }
}

/** Items for the requested months, in bank order. */
export function itemsForMonths(bank: QuizBank, months: string[]): QuizItem[] {
  const want = new Set(months)
  return bank.items.filter((it) => want.has(it.month))
}

/** Distinct months present in `items`, ascending. */
export function monthsPresent(items: QuizItem[]): string[] {
  return [...new Set(items.map((it) => it.month))].sort(
    (a, b) => monthOrdinal(a) - monthOrdinal(b)
  )
}
