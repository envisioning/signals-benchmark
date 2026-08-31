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
  /** First day of `month` — buckets are monthly, so this is not finer. */
  date: string
  /** Range of splits that fit nearly as well as the best one. */
  lower: string
  upper: string
  /** Fitted accuracy before the change point, 0..1. */
  plateau: number
  /** 1 / n_options. */
  chance: number
  /**
   * Accuracy the curve actually decays to, from the newest buckets.
   * Above `chance` when the quiz leaks recognisable-but-undated signal.
   */
  floor: number
  /** Midpoint between the two fitted levels. */
  threshold: number
}

export type QuizProbe = {
  n_options: number
  /**
   * Set when the per-model cost cap stopped the probe early. The
   * remaining questions were never asked, so the curve is partial and
   * any estimate off it should be read as provisional.
   */
  cost_capped?: boolean
  /** Measured cost of the first question, used for the projection below. */
  first_call_usd?: number
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
  | "too-many-failures"
  | "too-expensive"
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
  /**
   * Which bank, and which distractor gap, this model actually answered.
   * Recorded per model rather than per run because models are added to a
   * report over time — a new model probed after the bank grew has not sat
   * the same exam as the others, and comparing them would be wrong.
   */
  quiz_version: string
  /** Fingerprint of the event pool — the label alone survives an append. */
  quiz_hash: string
  month_gap: number
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
  /** Minimum buckets either side of the split, so a fit needs real support. */
  minSegment: 3,
  /** Fewer scored buckets than this and we don't try at all. */
  minBuckets: 8,
  /** The drop across the split must clear this to count as a decline. */
  minSignal: 0.15,
  /** Buckets below this many scored questions are dropped from the curve. */
  minBucketN: 2,
  /** Splits within this fraction of the best fit form the reported bracket. */
  bracketTolerance: 0.05,
} as const

type Fit = { index: number; sse: number; left: number; right: number }

function weightedMean(values: number[], weights: number[]): number {
  const w = weights.reduce((a, b) => a + b, 0)
  if (w === 0) return 0
  return values.reduce((a, v, i) => a + v * weights[i], 0) / w
}

/**
 * Best single step through the curve: the split that minimises weighted
 * squared error either side. Weights are the bucket sizes, so a month
 * that only scored two questions pulls proportionally less than one that
 * scored six.
 */
function fitStep(values: number[], weights: number[], minSegment: number): Fit[] {
  const fits: Fit[] = []
  for (let k = minSegment; k <= values.length - minSegment; k++) {
    const lv = values.slice(0, k)
    const lw = weights.slice(0, k)
    const rv = values.slice(k)
    const rw = weights.slice(k)
    const left = weightedMean(lv, lw)
    const right = weightedMean(rv, rw)
    const sse =
      lv.reduce((a, v, i) => a + lw[i] * (v - left) ** 2, 0) +
      rv.reduce((a, v, i) => a + rw[i] * (v - right) ** 2, 0)
    fits.push({ index: k, sse, left, right })
  }
  return fits
}

/**
 * Read a cutoff off the accuracy curve.
 *
 * The curve runs high while the model knows the month and drops once it
 * doesn't. We locate that drop as a CHANGE POINT — the split minimising
 * weighted squared error either side — rather than by walking the curve
 * for a threshold crossing. Two reasons, both learned the expensive way
 * on real data:
 *
 *   - The level after the drop is not chance. A quiz item leaks whenever
 *     an option can be ruled out without knowing the month, and models
 *     differ in how much they exploit that, so the floor is a property of
 *     the measurement and has to be estimated, not assumed. gpt-4.1-mini
 *     (documented cutoff 2024-06) answered 2025-2026 events at 54%
 *     against 12.5% chance; a chance-anchored threshold dated it 2026-05.
 *   - Monthly buckets are small, so single buckets swing wildly. A
 *     crossing rule keys on individual points and latches onto late
 *     noise; fitting two levels uses every bucket at once. On the same
 *     data the change point lands at 2024-03 — three months early, which
 *     is the direction the midpoint convention intends: training data
 *     thins out before a cutoff and models partially anticipate what
 *     comes next, so the observed drop precedes the true date.
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

  const scored = [...buckets]
    .sort((a, b) => monthOrdinal(a.month) - monthOrdinal(b.month))
    .filter(
      (b): b is QuizBucket & { accuracy: number } =>
        b.accuracy !== null && b.n >= cfg.minBucketN
    )
  if (
    scored.length < cfg.minBuckets ||
    scored.length < cfg.minSegment * 2 + 1
  ) {
    return { estimate: null, reason: "too-few-buckets" }
  }

  const values = scored.map((b) => b.accuracy)
  const weights = scored.map((b) => b.n)
  const fits = fitStep(values, weights, cfg.minSegment)
  if (fits.length === 0) return { estimate: null, reason: "too-few-buckets" }

  const best = fits.reduce((a, b) => (b.sse < a.sse ? b : a))
  const plateau = best.left
  const floor = best.right

  // Never meaningfully above chance anywhere: nothing to date. Checked
  // against chance, because this is "the model never knew this material",
  // distinct from "it still knows it" below.
  if (plateau - chance < cfg.minSignal) return { estimate: null, reason: "no-signal" }
  // Both levels high: the model is still answering well at the newest
  // month tested, so its cutoff is at or beyond the window.
  if (plateau - floor < cfg.minSignal) {
    return { estimate: null, reason: "no-decline-in-window" }
  }

  // Bracket: every split that fits nearly as well. A wide bracket is
  // itself the finding — it means the decline is gradual or the buckets
  // are too noisy to place it precisely.
  const near = fits.filter(
    (f) => f.sse <= best.sse * (1 + cfg.bracketTolerance) && f.left > f.right
  )
  const indices = near.length > 0 ? near.map((f) => f.index) : [best.index]
  const loIdx = Math.max(0, Math.min(...indices) - 1)
  const hiIdx = Math.min(scored.length - 1, Math.max(...indices))

  const month = scored[best.index].month
  return {
    estimate: {
      month,
      date: `${month}-01`,
      lower: scored[loIdx].month,
      upper: scored[hiIdx].month,
      plateau: round3(plateau),
      chance: round3(chance),
      floor: round3(floor),
      threshold: round3((plateau + floor) / 2),
    },
  }
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
 * Starting token ceiling. Models that reason internally burn output
 * tokens before the first visible character, and these prompts want one
 * letter — so the ceiling has to cover thinking we can't see.
 *
 * The name-based guess is only a STARTING point. It is a heuristic over
 * slugs and it silently fails on every model that reasons without saying
 * so in its name: gemini-3.5-flash spent 382 tokens thinking against a
 * 400 ceiling and returned the string `{"answer` on 169 of 215 questions,
 * which scored as 169 refusals and left too few buckets to fit. The
 * asker below detects that at runtime instead of trusting this.
 */
function startingCeiling(model: string): number {
  return isReasoningModel(model) ? 8000 : 400
}

/** Cut off by the ceiling rather than finished. */
function wasTruncated(res: Awaited<ReturnType<typeof openrouterChat>>): boolean {
  return res.success && res.raw?.choices?.[0]?.finish_reason === "length"
}

/**
 * Per-model asker with an adaptive token ceiling.
 *
 * On the first truncation it raises the ceiling and retries, and keeps
 * the raised ceiling for every later call to that model — so a cohort
 * run pays for one extra call to discover a model reasons, not 215 of
 * them. A response still truncated after the retry is reported as an
 * error rather than a refusal: the model answered, we failed to let it.
 */
function makeAsker({ apiKey, model, timeoutMs }: ChatDeps) {
  let ceiling = startingCeiling(model)
  return async function ask(prompt: string, temperature: number) {
    let lastFailure: Awaited<ReturnType<typeof openrouterChat>> | null = null
    // Two escalation attempts (truncation) x three tries (transient
    // failure). A cohort run drives 12 calls in flight against one key,
    // and a rate limit or provider blip with no retry silently becomes a
    // hole in the curve: deepseek-v4-pro came back with 158 errors out of
    // 215 questions and still produced a confident-looking estimate.
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let tries = 0; tries < 3; tries++) {
        if (tries > 0) await new Promise((r) => setTimeout(r, tries * 3000))
        const res = await openrouterChat({
          apiKey,
          model,
          messages: [{ role: "user", content: prompt }],
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "answer", strict: true, schema: ANSWER_SCHEMA as any },
          },
          temperature,
          maxTokens: ceiling,
          reasoning: shouldPassReasoning(model)
            ? { effort: "minimal", exclude: true }
            : undefined,
          timeoutMs: timeoutMs ?? (ceiling > 1000 ? 180_000 : 90_000),
        })
        if (res.success) {
          if (!wasTruncated(res)) return res
          break // truncated: escalate the ceiling rather than retrying as-is
        }
        lastFailure = res
      }
      if (attempt === 0) ceiling = Math.max(ceiling * 8, 4000)
    }
    return (
      lastFailure ?? {
        success: false as const,
        code: 500,
        message: `truncated at ${ceiling} tokens (model reasons before answering)`,
      }
    )
  }
}

export async function runQuizProbe({
  apiKey,
  model,
  bank,
  items,
  concurrency = 6,
  maxCostUsd,
  onProgress,
}: {
  apiKey: string
  model: string
  bank: QuizBank
  items: QuizItem[]
  concurrency?: number
  /**
   * Stop asking once this model has cost this much. Per-call cost varies
   * by ~50x across a cohort — a deep-research model runs a search pass
   * per question, so 215 questions can cost more than the entire rest of
   * the run. Without a cap, one slug in the cohort sets the budget.
   */
  maxCostUsd?: number
  onProgress?: (done: number, total: number) => void
}): Promise<{ probe: QuizProbe; cost: number }> {
  const { default: pMap } = await import("p-map")
  const ask = makeAsker({ apiKey, model })
  let cost = 0
  let done = 0
  let capped = false

  /**
   * Price the model on ONE question before committing to the rest.
   *
   * A running cost cap cannot contain a model whose calls are expensive:
   * with 8 questions in flight, perplexity/sonar-deep-research blew
   * through a $2 cap to $10.60 and still answered only 14 of 215, because
   * each call runs its own research pass. Paying five times the cap for a
   * curve too sparse to fit is the worst of both outcomes.
   *
   * So project from the first call and decline the model outright when it
   * can't be measured within budget. Worst case is now one call over.
   */
  let firstCallUsd: number | undefined
  if (maxCostUsd !== undefined && items.length > 0) {
    const probe = await ask(quizPrompt(items[0], bank.n_options), 0)
    firstCallUsd = probe.success ? (probe.usage?.cost ?? 0) : 0
    cost += firstCallUsd
    const projected = firstCallUsd * items.length
    if (projected > maxCostUsd) {
      return {
        probe: {
          n_options: bank.n_options,
          buckets: [],
          n_questions: items.length,
          n_answered: 0,
          n_refused: 0,
          n_errored: 0,
          overall_accuracy: null,
          estimate: null,
          estimate_reason: "too-expensive",
          first_call_usd: firstCallUsd,
        },
        cost,
      }
    }
  }

  const answers = await pMap(
    items,
    async (item): Promise<QuizAnswer> => {
      if (maxCostUsd !== undefined && cost >= maxCostUsd) {
        capped = true
        return {
          item_id: item.id,
          month: item.month,
          picked: null,
          correct: false,
          error: "cost cap reached",
        }
      }
      // Temperature 0: we want the model's modal belief, not a sample of
      // its uncertainty. Sampling noise would blur the decay curve.
      const res = await ask(quizPrompt(item, bank.n_options), 0)
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
  // A probe that mostly failed is not a curve. Fitting one anyway
  // produces a plausible month off a handful of surviving buckets and
  // nothing in the output says the model barely answered.
  const answerRate = items.length === 0 ? 0 : nAnswered / items.length
  const { estimate, reason } =
    answerRate < 0.6
      ? { estimate: null, reason: "too-many-failures" as const }
      : estimateCutoff(buckets, bank.n_options)

  return {
    probe: {
      n_options: bank.n_options,
      ...(capped ? { cost_capped: true } : {}),
      ...(firstCallUsd !== undefined ? { first_call_usd: firstCallUsd } : {}),
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
  const ask = makeAsker({ apiKey, model })
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
        const res = await ask(prompt, 1)
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
  const ask = makeAsker({ apiKey, model })
  let cost = 0
  const jobs = IDENTITY_PROMPTS.flatMap((p) =>
    Array.from({ length: samplesPerPhrasing }, () => p)
  )
  const results = await pMap(
    jobs,
    async (prompt) => {
      const res = await ask(prompt, 1)
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
