/**
 * Knowledge-cutoff probe.
 *
 * Adapted from Shrivu Shankar's method
 * (https://blog.sshh.io/p/exploring-claudegpt-knowledge-cutoffs). Three
 * independent probes per model:
 *
 *   1. quiz        — N-way multiple choice on real dated events, bucketed
 *                    by month. Accuracy decays from a plateau down to
 *                    chance as questions move past what the model saw in
 *                    training; the cutoff is read off that curve.
 *   2. self-report — ask the model what month it is / when its training
 *                    data ends, sampled over several phrasings.
 *   3. identity    — ask the model what model it is, sampled over several
 *                    phrasings. Doesn't date anything by itself, but a
 *                    model that thinks it's its own predecessor is a
 *                    strong hint about what its training data contained.
 *
 * Why this lives in a foresight benchmark: the Currency axis measures how
 * recent a model's *cited evidence* is. Cutoff measures how recent its
 * *world model* is. A model whose knowledge stops 14 months ago cannot
 * generate a current signal of change no matter how well it writes.
 *
 * Cutoff is deliberately NOT folded into the composite score. It's a
 * property of the model, not a quality judgement, and the honest reading
 * is "here is when this model stops knowing things" — reported alongside.
 */
import { openrouterChat, extractJson } from "./openrouter.ts"
import { isReasoningModel, shouldPassReasoning } from "./generate.ts"
import {
  OPTION_LETTERS,
  monthLabel,
  monthOrdinal,
  monthsPresent,
  ordinalToMonth,
  type QuizBank,
  type QuizItem,
} from "./cutoff-quiz.ts"

// ── Types ────────────────────────────────────────────────────────────

export type QuizAnswer = {
  item_id: string
  month: string
  /** Index the model picked, or null when it refused / returned garbage. */
  picked: number | null
  correct: boolean
  /** Set when the call failed outright (rate limit, timeout, 4xx). */
  error?: string
}

export type QuizBucket = {
  month: string
  /** Questions actually answered (refusals and errors excluded). */
  n: number
  correct: number
  /** correct / n, or null when the bucket had nothing to score. */
  accuracy: number | null
  /** Questions where the model declined or returned an unparseable answer. */
  refusals: number
  errors: number
}

export type CutoffEstimate = {
  /** Best single-month estimate, "YYYY-MM". */
  month: string
  /** Interpolated day inside that month — the curve's midpoint crossing. */
  date: string
  /** Bracketing buckets the crossing falls between. */
  lower: string
  upper: string
  /** Mean accuracy over the plateau window, 0..1. */
  plateau: number
  /** 1 / n_options. */
  chance: number
  /** Midpoint between plateau and chance — where we call the cutoff. */
  threshold: number
}

export type QuizProbe = {
  n_options: number
  buckets: QuizBucket[]
  n_questions: number
  n_answered: number
  n_refused: number
  n_errored: number
  overall_accuracy: number | null
  estimate: CutoffEstimate | null
  /** Why `estimate` is null. Absent when an estimate was produced. */
  estimate_reason?: EstimateFailure
}

export type EstimateFailure =
  | "too-few-buckets"
  | "no-signal"
  | "no-decline-in-window"
  | "below-threshold-throughout"

export type SelfReportProbe = {
  /** "What month is it?" — the model's belief about the present. */
  today: SelfReportSeries
  /** "When does your training data end?" — the model's stated cutoff. */
  cutoff: SelfReportSeries
}

export type SelfReportSeries = {
  /** Every parsed YYYY-MM, one per sample, in call order. */
  samples: string[]
  /** Samples that produced no parseable month. */
  unparsed: number
  /** Median of `samples` (lower median on ties), or null when empty. */
  median: string | null
  /** Most frequent value, or null when empty. */
  mode: string | null
  /** Months between the earliest and latest sample. */
  spread_months: number | null
}

export type IdentityProbe = {
  /** Normalized answer → count, most frequent first. */
  answers: { answer: string; count: number }[]
  n_samples: number
  /** Share of samples naming the vendor from the model's own slug. */
  vendor_match_rate: number
}

export type ModelCutoff = {
  model: string
  probed_at: string
  quiz: QuizProbe
  self_report?: SelfReportProbe
  identity?: IdentityProbe
  cost_usd?: number
}

export type CutoffReport = {
  run_id: string
  started_at: string
  finished_at: string
  quiz_version: string
  quiz_builder_model: string
  n_options: number
  months: string[]
  /** Questions per model = items in the window. */
  n_questions: number
  models: ModelCutoff[]
  billed_actual_usd?: number
}

// ── Estimator (pure — unit-tested in cutoff.test.ts) ──────────────────

export const ESTIMATOR_DEFAULTS = {
  /** Buckets averaged at the old end of the window to find the plateau. */
  plateauWindow: 6,
  /** Centered moving-average width. 1 disables smoothing. */
  smoothing: 3,
  /** Plateau must clear chance by this much for the curve to mean anything. */
  minSignal: 0.15,
  /** Buckets below this many scored questions are dropped from the curve. */
  minBucketN: 2,
} as const

/**
 * Centered moving average over a series with holes (`null`). Holes stay
 * holes; the window shrinks at the edges rather than wrapping. Smoothing
 * matters because monthly buckets are small (4-8 questions) and a single
 * lucky guess swings a raw bucket by 12-25 points.
 */
export function smoothSeries(
  values: (number | null)[],
  width = ESTIMATOR_DEFAULTS.smoothing
): (number | null)[] {
  if (width <= 1) return [...values]
  const half = Math.floor(width / 2)
  return values.map((v, i) => {
    if (v === null) return null
    const window: number[] = []
    for (let j = i - half; j <= i + half; j++) {
      const x = values[j]
      if (j >= 0 && j < values.length && x !== null) window.push(x)
    }
    return window.reduce((a, b) => a + b, 0) / window.length
  })
}

/**
 * Read a cutoff off the accuracy curve.
 *
 * The curve runs high (the model knows this month) and falls to chance
 * (it's guessing). We take the *midpoint* of that fall, not its start or
 * end — the same choice the source method makes, and for the same two
 * reasons: models partially anticipate near-future events, and the last
 * few months before a cutoff are undersampled in training data, so
 * accuracy starts sagging before knowledge actually stops.
 *
 * Returns null with a reason when the curve can't support an estimate —
 * an over-confident guess here would be worse than an honest gap.
 */
export function estimateCutoff(
  buckets: QuizBucket[],
  nOptions: number,
  opts: Partial<typeof ESTIMATOR_DEFAULTS> = {}
): { estimate: CutoffEstimate | null; reason?: EstimateFailure } {
  const cfg = { ...ESTIMATOR_DEFAULTS, ...opts }
  const chance = 1 / nOptions

  const ordered = [...buckets].sort(
    (a, b) => monthOrdinal(a.month) - monthOrdinal(b.month)
  )
  const usable = ordered.map((b) =>
    b.accuracy !== null && b.n >= cfg.minBucketN ? b.accuracy : null
  )
  const scored = usable.filter((v) => v !== null).length
  if (scored < cfg.plateauWindow + 2) return { estimate: null, reason: "too-few-buckets" }

  const smoothed = smoothSeries(usable, cfg.smoothing)

  // Plateau: the oldest `plateauWindow` buckets that actually scored.
  const plateauValues: number[] = []
  for (const v of smoothed) {
    if (v === null) continue
    plateauValues.push(v)
    if (plateauValues.length === cfg.plateauWindow) break
  }
  const plateau = plateauValues.reduce((a, b) => a + b, 0) / plateauValues.length

  if (plateau - chance < cfg.minSignal) return { estimate: null, reason: "no-signal" }
  const threshold = (plateau + chance) / 2

  // Indices of buckets that scored, so we can walk the curve ignoring holes.
  const idx = smoothed.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0)
  const last = idx[idx.length - 1]
  if ((smoothed[last] as number) >= threshold) {
    // Still above threshold at the newest bucket: the cutoff is at or
    // after the end of the window. Widen the window, don't guess.
    return { estimate: null, reason: "no-decline-in-window" }
  }

  // Walk backwards for the LAST above→below crossing. Taking the last
  // one (rather than the first) keeps a mid-window dip — a month that
  // simply produced hard questions — from being mistaken for the cutoff.
  for (let k = idx.length - 1; k > 0; k--) {
    const hi = idx[k - 1]
    const lo = idx[k]
    const a = smoothed[hi] as number
    const b = smoothed[lo] as number
    if (a >= threshold && b < threshold) {
      const span = a - b
      const frac = span === 0 ? 0.5 : (a - threshold) / span
      const loOrd = monthOrdinal(ordered[hi].month)
      const hiOrd = monthOrdinal(ordered[lo].month)
      // Buckets are anchored at mid-month; interpolate between anchors.
      const exact = loOrd + frac * (hiOrd - loOrd)
      const month = ordinalToMonth(Math.round(exact))
      return {
        estimate: {
          month,
          date: ordinalFractionToDate(exact),
          lower: ordered[hi].month,
          upper: ordered[lo].month,
          plateau: round3(plateau),
          chance: round3(chance),
          threshold: round3(threshold),
        },
      }
    }
  }
  return { estimate: null, reason: "below-threshold-throughout" }
}

/**
 * Fractional month ordinal → ISO date, anchoring each bucket at the
 * 15th. 24303.5 is mid-way between the 15th of one month and the 15th
 * of the next, i.e. roughly the 1st of the later month.
 */
function ordinalFractionToDate(exact: number): string {
  const base = Math.floor(exact)
  const frac = exact - base
  const [y, m] = ordinalToMonth(base).split("-").map(Number)
  const start = Date.UTC(y, m - 1, 15)
  const next = Date.UTC(y, m, 15)
  const t = start + frac * (next - start)
  return new Date(t).toISOString().slice(0, 10)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Group per-question answers into month buckets. */
export function bucketAnswers(answers: QuizAnswer[]): QuizBucket[] {
  const byMonth = new Map<string, QuizBucket>()
  for (const a of answers) {
    let b = byMonth.get(a.month)
    if (!b) {
      b = { month: a.month, n: 0, correct: 0, accuracy: null, refusals: 0, errors: 0 }
      byMonth.set(a.month, b)
    }
    if (a.error) {
      b.errors++
    } else if (a.picked === null) {
      b.refusals++
    } else {
      b.n++
      if (a.correct) b.correct++
    }
  }
  const out = [...byMonth.values()]
  for (const b of out) b.accuracy = b.n === 0 ? null : b.correct / b.n
  return out.sort((a, b) => monthOrdinal(a.month) - monthOrdinal(b.month))
}

// ── Prompts ──────────────────────────────────────────────────────────

function quizPrompt(item: QuizItem, nOptions: number): string {
  const lines = item.options
    .slice(0, nOptions)
    .map((opt, i) => `${OPTION_LETTERS[i]}. ${opt}`)
  const letters = OPTION_LETTERS.slice(0, nOptions)
  return `Exactly one of the following statements describes something that really happened in ${monthLabel(
    item.month
  )}. The other ${nOptions - 1} never happened.

${lines.join("\n")}

Which one is real? Answer with a single letter (${letters[0]}-${letters[nOptions - 1]}).
You must choose one. If you are not sure, pick your best guess — do not explain, do not decline.
Respond with JSON: {"answer": "${letters[0]}"}`
}

/**
 * Five phrasings each, per the source method. Varying the phrasing
 * matters: models are heavily post-trained on some of these exact
 * questions and comparatively untouched on others, and the spread
 * across phrasings is itself the interesting signal.
 */
const TODAY_PROMPTS = [
  `What is today's date? Answer with JSON: {"answer": "YYYY-MM"}. If you are not certain, give your single best guess anyway.`,
  `If you had to bet, what month and year is it right now? No hedging — commit to one answer. Respond with JSON: {"answer": "YYYY-MM"}.`,
  `Complete this with your best guess and nothing else — the current month is: respond as JSON {"answer": "YYYY-MM"}.`,
  `Imagine you must timestamp this conversation. What month would you write? JSON: {"answer": "YYYY-MM"}.`,
  `Guess the present month. You will not be penalised for being wrong, only for refusing. JSON: {"answer": "YYYY-MM"}.`,
]

const CUTOFF_PROMPTS = [
  `When does your training data end? Answer with a single month as JSON: {"answer": "YYYY-MM"}.`,
  `What is the most recent month for which you have reliable knowledge of world events? JSON: {"answer": "YYYY-MM"}.`,
  `Your knowledge cutoff date is — complete it. Respond as JSON {"answer": "YYYY-MM"}, best guess if unsure.`,
  `After which month do you start being unaware of news? One month, JSON: {"answer": "YYYY-MM"}.`,
  `If you had to state your knowledge cutoff to a user right now, what month would you name? JSON: {"answer": "YYYY-MM"}.`,
]

const IDENTITY_PROMPTS = [
  `What model are you? Answer with just the name and version, guess if you are not sure. JSON: {"answer": "..."}.`,
  `Which AI model am I talking to? Name and version only, no caveats. JSON: {"answer": "..."}.`,
  `State your model name and version, nothing else. JSON: {"answer": "..."}.`,
  `If you had to guess your own model name, what would you say? JSON: {"answer": "..."}.`,
  `Who made you and what are you called? Keep it to the vendor and model name. JSON: {"answer": "..."}.`,
]

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const

// ── Response parsing ─────────────────────────────────────────────────

/** Pull `answer` out of a JSON reply, tolerating prose and fences. */
function parseAnswerField(text: string): string | null {
  try {
    const parsed = extractJson(text)
    const v = parsed?.answer
    if (typeof v === "string" && v.trim()) return v.trim()
  } catch {
    /* fall through to the lenient paths below */
  }
  return null
}

/**
 * Option letter → index. Falls back to finding a lone letter in prose
 * ("The answer is C.") because several models ignore response_format on
 * short prompts and just talk.
 */
export function parseOptionLetter(text: string, nOptions: number): number | null {
  const letters = OPTION_LETTERS.slice(0, nOptions)
  const fromJson = parseAnswerField(text)
  const candidate = fromJson ?? text
  const direct = candidate.trim().toUpperCase()
  if (direct.length === 1) {
    const i = letters.indexOf(direct as (typeof OPTION_LETTERS)[number])
    if (i >= 0) return i
  }
  const m = candidate
    .toUpperCase()
    .match(new RegExp(`\\b([${letters.join("")}])\\b(?![-\\w])`))
  if (m) return letters.indexOf(m[1] as (typeof OPTION_LETTERS)[number])
  return null
}

/** First plausible YYYY-MM in the reply. Accepts "March 2025" too. */
export function parseMonthAnswer(text: string): string | null {
  const candidate = parseAnswerField(text) ?? text
  const iso = candidate.match(/\b(19|20)\d{2}-(0[1-9]|1[0-2])\b/)
  if (iso) return iso[0]
  const named = candidate.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+((?:19|20)\d{2})\b/i
  )
  if (named) {
    const months = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ]
    const m = months.indexOf(named[1].toLowerCase()) + 1
    return `${named[2]}-${String(m).padStart(2, "0")}`
  }
  // Bare year, e.g. "2024" — snap to mid-year so it still enters the
  // distribution rather than being dropped as unparsed.
  const year = candidate.match(/\b(19|20)\d{2}\b/)
  if (year) return `${year[0]}-06`
  return null
}

// ── Probes ───────────────────────────────────────────────────────────

type ChatDeps = { apiKey: string; model: string; timeoutMs?: number }

/**
 * Reasoning models burn output tokens before the visible answer, exactly
 * as in generation. These prompts want one letter, so the ceiling only
 * has to cover internal reasoning — but it has to cover it, or the
 * model returns an empty body and we score a refusal it never made.
 */
function tokenCeiling(model: string): number {
  return isReasoningModel(model) ? 8000 : 400
}

async function askOnce(
  { apiKey, model, timeoutMs }: ChatDeps,
  prompt: string,
  temperature: number
) {
  return openrouterChat({
    apiKey,
    model,
    messages: [{ role: "user", content: prompt }],
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "answer", strict: true, schema: ANSWER_SCHEMA as any },
    },
    temperature,
    maxTokens: tokenCeiling(model),
    reasoning: shouldPassReasoning(model)
      ? { effort: "minimal", exclude: true }
      : undefined,
    timeoutMs: timeoutMs ?? (isReasoningModel(model) ? 180_000 : 90_000),
  })
}

export async function runQuizProbe({
  apiKey,
  model,
  bank,
  items,
  concurrency = 6,
  onProgress,
}: {
  apiKey: string
  model: string
  bank: QuizBank
  items: QuizItem[]
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}): Promise<{ probe: QuizProbe; cost: number }> {
  const { default: pMap } = await import("p-map")
  let cost = 0
  let done = 0

  const answers = await pMap(
    items,
    async (item): Promise<QuizAnswer> => {
      // Temperature 0: we want the model's modal belief, not a sample of
      // its uncertainty. Sampling noise would blur the decay curve.
      const res = await askOnce({ apiKey, model }, quizPrompt(item, bank.n_options), 0)
      done++
      onProgress?.(done, items.length)
      if (!res.success) {
        return { item_id: item.id, month: item.month, picked: null, correct: false, error: res.message }
      }
      cost += res.usage?.cost ?? 0
      const picked = parseOptionLetter(res.text, bank.n_options)
      return {
        item_id: item.id,
        month: item.month,
        picked,
        correct: picked !== null && picked === item.answer,
      }
    },
    { concurrency }
  )

  const buckets = bucketAnswers(answers)
  const nAnswered = buckets.reduce((a, b) => a + b.n, 0)
  const nCorrect = buckets.reduce((a, b) => a + b.correct, 0)
  const { estimate, reason } = estimateCutoff(buckets, bank.n_options)

  return {
    probe: {
      n_options: bank.n_options,
      buckets,
      n_questions: items.length,
      n_answered: nAnswered,
      n_refused: buckets.reduce((a, b) => a + b.refusals, 0),
      n_errored: buckets.reduce((a, b) => a + b.errors, 0),
      overall_accuracy: nAnswered === 0 ? null : nCorrect / nAnswered,
      estimate,
      ...(reason ? { estimate_reason: reason } : {}),
    },
    cost,
  }
}

function summarizeSeries(samples: string[], unparsed: number): SelfReportSeries {
  if (samples.length === 0) {
    return { samples, unparsed, median: null, mode: null, spread_months: null }
  }
  const ords = samples.map(monthOrdinal).sort((a, b) => a - b)
  const median = ordinalToMonth(ords[Math.floor((ords.length - 1) / 2)])
  const counts = new Map<string, number>()
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1)
  const mode = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || monthOrdinal(b[0]) - monthOrdinal(a[0])
  )[0][0]
  return {
    samples,
    unparsed,
    median,
    mode,
    spread_months: ords[ords.length - 1] - ords[0],
  }
}

export async function runSelfReportProbe({
  apiKey,
  model,
  samplesPerPhrasing = 3,
  concurrency = 6,
}: {
  apiKey: string
  model: string
  samplesPerPhrasing?: number
  concurrency?: number
}): Promise<{ probe: SelfReportProbe; cost: number }> {
  const { default: pMap } = await import("p-map")
  let cost = 0

  async function series(prompts: string[]): Promise<SelfReportSeries> {
    const jobs = prompts.flatMap((p) =>
      Array.from({ length: samplesPerPhrasing }, () => p)
    )
    const results = await pMap(
      jobs,
      async (prompt) => {
        // Temperature 1: here we DO want the distribution — the spread
        // across samples is what distinguishes a model that knows its
        // cutoff from one that is confabulating a plausible-looking date.
        const res = await askOnce({ apiKey, model }, prompt, 1)
        if (!res.success) return null
        cost += res.usage?.cost ?? 0
        return parseMonthAnswer(res.text)
      },
      { concurrency }
    )
    const parsed = results.filter((r): r is string => r !== null)
    return summarizeSeries(parsed, results.length - parsed.length)
  }

  const today = await series(TODAY_PROMPTS)
  const cutoff = await series(CUTOFF_PROMPTS)
  return { probe: { today, cutoff }, cost }
}

/** Strip punctuation/casing so "Claude 3.5 Sonnet." and "claude 3.5 sonnet" merge. */
function normalizeIdentity(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}

export async function runIdentityProbe({
  apiKey,
  model,
  samplesPerPhrasing = 4,
  concurrency = 6,
}: {
  apiKey: string
  model: string
  samplesPerPhrasing?: number
  concurrency?: number
}): Promise<{ probe: IdentityProbe; cost: number }> {
  const { default: pMap } = await import("p-map")
  let cost = 0
  const jobs = IDENTITY_PROMPTS.flatMap((p) =>
    Array.from({ length: samplesPerPhrasing }, () => p)
  )
  const results = await pMap(
    jobs,
    async (prompt) => {
      const res = await askOnce({ apiKey, model }, prompt, 1)
      if (!res.success) return null
      cost += res.usage?.cost ?? 0
      const raw = parseAnswerField(res.text) ?? res.text
      return normalizeIdentity(raw)
    },
    { concurrency }
  )
  const parsed = results.filter((r): r is string => r !== null && r.length > 0)
  const counts = new Map<string, number>()
  for (const a of parsed) counts.set(a, (counts.get(a) ?? 0) + 1)

  // Vendor from the slug's own prefix ("anthropic/claude-opus-4.6" →
  // "anthropic"). Deliberately loose: we're asking "does it know whose
  // model it is", not grading the version number.
  const vendorToken = model.split("/")[0].toLowerCase().replace(/[^a-z]/g, "")
  const vendorHits = parsed.filter((a) =>
    a.replace(/[^a-z]/g, "").includes(vendorToken)
  ).length

  return {
    probe: {
      answers: [...counts.entries()]
        .map(([answer, count]) => ({ answer, count }))
        .sort((a, b) => b.count - a.count),
      n_samples: parsed.length,
      vendor_match_rate: parsed.length === 0 ? 0 : vendorHits / parsed.length,
    },
    cost,
  }
}

/** Months the report should chart — union of every model's buckets. */
export function reportMonths(models: ModelCutoff[]): string[] {
  return monthsPresent(
    models.flatMap((m) => m.quiz.buckets.map((b) => ({ month: b.month }) as QuizItem))
  )
}
