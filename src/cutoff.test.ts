/**
 * Tests for the knowledge-cutoff estimator.
 *
 * The estimator is the one piece of the cutoff probe that turns noisy
 * data into a published claim ("this model's knowledge stops in March
 * 2025"), so it is pinned here against synthetic curves whose true
 * answer we know. Everything else in src/cutoff.ts is I/O against a
 * model API and is exercised by running it.
 *
 * The properties that matter, and why:
 *   - a clean decay is read at its MIDPOINT, not its start or end
 *   - a mid-window dip is not mistaken for the cutoff
 *   - a curve that never falls yields NO estimate rather than the last
 *     month in the window (which would silently report the window edge
 *     as every recent model's cutoff)
 *   - a model at chance throughout yields no estimate either
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  bucketAnswers,
  estimateCutoff,
  parseMonthAnswer,
  parseOptionLetter,
  smoothSeries,
  type QuizAnswer,
  type QuizBucket,
} from "./cutoff.ts"
import { monthOrdinal, monthRange, ordinalToMonth, shuffleOptions } from "./cutoff-quiz.ts"

const N_OPTIONS = 8
const CHANCE = 1 / N_OPTIONS

/** Build buckets from an accuracy series starting at `from`. */
function buckets(from: string, accuracies: number[], n = 8): QuizBucket[] {
  return accuracies.map((acc, i) => ({
    month: ordinalToMonth(monthOrdinal(from) + i),
    n,
    correct: Math.round(acc * n),
    accuracy: acc,
    refusals: 0,
    errors: 0,
  }))
}

/**
 * A model that knows everything up to `cutoffIndex`, then decays to
 * chance over `rampMonths`. The midpoint of that ramp is what the
 * estimator should report.
 */
function decayCurve(plateau: number, cutoffIndex: number, rampMonths: number, total: number) {
  return Array.from({ length: total }, (_, i) => {
    if (i <= cutoffIndex) return plateau
    const t = Math.min(1, (i - cutoffIndex) / rampMonths)
    return plateau + (CHANCE - plateau) * t
  })
}

test("reads a clean decay at its midpoint", () => {
  // Plateau 0.85 through index 17 (2024-06), decaying to chance by index 23.
  const series = decayCurve(0.85, 17, 6, 30)
  const { estimate, reason } = estimateCutoff(buckets("2023-01", series), N_OPTIONS)
  assert.equal(reason, undefined)
  assert.ok(estimate, "expected an estimate")
  // Midpoint of the ramp is ~index 20 → 2024-09. Smoothing shifts it by
  // under a month either way; assert the bracket rather than a point.
  const ord = monthOrdinal(estimate!.month)
  assert.ok(
    ord >= monthOrdinal("2024-08") && ord <= monthOrdinal("2024-10"),
    `estimate ${estimate!.month} outside 2024-08..2024-10`
  )
  assert.ok(estimate!.plateau > 0.8, `plateau ${estimate!.plateau} should reflect the high end`)
  assert.equal(estimate!.chance, 0.125)
  assert.ok(estimate!.threshold > CHANCE && estimate!.threshold < estimate!.plateau)
  // The interpolated day must sit inside the bracketing months.
  assert.ok(estimate!.date >= `${estimate!.lower}-01` && estimate!.date <= `${estimate!.upper}-31`)
})

test("a sharp cliff is dated at the cliff", () => {
  const series = decayCurve(0.9, 20, 1, 30)
  const { estimate } = estimateCutoff(buckets("2023-01", series), N_OPTIONS)
  assert.ok(estimate)
  const ord = monthOrdinal(estimate!.month)
  assert.ok(
    ord >= monthOrdinal("2024-09") && ord <= monthOrdinal("2024-11"),
    `estimate ${estimate!.month} should sit at the 2024-09 cliff`
  )
})

test("later cutoff estimates later than earlier cutoff, same shape", () => {
  const early = estimateCutoff(buckets("2023-01", decayCurve(0.85, 12, 5, 30)), N_OPTIONS)
  const late = estimateCutoff(buckets("2023-01", decayCurve(0.85, 22, 5, 30)), N_OPTIONS)
  assert.ok(early.estimate && late.estimate)
  assert.ok(
    monthOrdinal(late.estimate!.month) - monthOrdinal(early.estimate!.month) >= 8,
    "a 10-month-later cutoff should move the estimate by roughly 10 months"
  )
})

test("a mid-window dip is not mistaken for the cutoff", () => {
  // Hard month at index 8 drops to chance, then recovery, then the real
  // decay at 20. Taking the FIRST crossing would date this 2023-09.
  const series = decayCurve(0.85, 20, 4, 30)
  series[8] = CHANCE
  series[9] = CHANCE + 0.05
  const { estimate } = estimateCutoff(buckets("2023-01", series), N_OPTIONS)
  assert.ok(estimate)
  assert.ok(
    monthOrdinal(estimate!.month) >= monthOrdinal("2024-08"),
    `estimate ${estimate!.month} was dragged back by the mid-window dip`
  )
})

test("no decline in the window yields no estimate, not the window edge", () => {
  const series = Array.from({ length: 30 }, () => 0.85)
  const { estimate, reason } = estimateCutoff(buckets("2023-01", series), N_OPTIONS)
  assert.equal(estimate, null)
  assert.equal(reason, "no-decline-in-window")
})

test("a model at chance throughout yields no estimate", () => {
  const series = Array.from({ length: 30 }, () => CHANCE + 0.02)
  const { estimate, reason } = estimateCutoff(buckets("2023-01", series), N_OPTIONS)
  assert.equal(estimate, null)
  assert.equal(reason, "no-signal")
})

test("too few scored buckets yields no estimate", () => {
  const { estimate, reason } = estimateCutoff(
    buckets("2023-01", decayCurve(0.85, 2, 2, 6)),
    N_OPTIONS
  )
  assert.equal(estimate, null)
  assert.equal(reason, "too-few-buckets")
})

test("buckets below the minimum sample size are dropped, not scored", () => {
  const series = decayCurve(0.85, 17, 6, 30)
  const bs = buckets("2023-01", series)
  // A single-question bucket that happened to be wrong would otherwise
  // read as a 0% month and pull the crossing earlier.
  bs[15] = { ...bs[15], n: 1, correct: 0, accuracy: 0 }
  const { estimate } = estimateCutoff(bs, N_OPTIONS)
  assert.ok(estimate)
  assert.ok(monthOrdinal(estimate!.month) >= monthOrdinal("2024-08"))
})

test("estimate survives per-bucket noise", () => {
  // Deterministic ±0.12 jitter on top of a clean curve.
  const series = decayCurve(0.85, 17, 6, 30).map((v, i) =>
    Math.max(0, Math.min(1, v + (i % 3 === 0 ? 0.12 : i % 3 === 1 ? -0.12 : 0)))
  )
  const { estimate } = estimateCutoff(buckets("2023-01", series), N_OPTIONS)
  assert.ok(estimate)
  const ord = monthOrdinal(estimate!.month)
  assert.ok(
    ord >= monthOrdinal("2024-07") && ord <= monthOrdinal("2024-11"),
    `noisy estimate ${estimate!.month} drifted more than 2 months`
  )
})

test("smoothing keeps holes and shrinks the window at the edges", () => {
  const s = smoothSeries([1, null, 0, 0.5], 3)
  assert.equal(s[1], null)
  assert.equal(s[0], 1) // only neighbour is a hole, so the value stands
  assert.equal(s[2], 0.25) // mean(0, 0.5) — the hole at 1 is skipped, not zeroed
  assert.equal(s[3], 0.25) // mean(0, 0.5) — no wrap-around past the edge
})

test("bucketing separates refusals and errors from wrong answers", () => {
  const answers: QuizAnswer[] = [
    { item_id: "a", month: "2025-01", picked: 0, correct: true },
    { item_id: "b", month: "2025-01", picked: 3, correct: false },
    { item_id: "c", month: "2025-01", picked: null, correct: false },
    { item_id: "d", month: "2025-01", picked: null, correct: false, error: "429" },
  ]
  const [b] = bucketAnswers(answers)
  assert.equal(b.n, 2)
  assert.equal(b.correct, 1)
  assert.equal(b.accuracy, 0.5)
  assert.equal(b.refusals, 1)
  assert.equal(b.errors, 1)
})

test("option-letter parsing tolerates JSON, bare letters, and prose", () => {
  assert.equal(parseOptionLetter('{"answer":"C"}', 8), 2)
  assert.equal(parseOptionLetter("  f  ", 8), 5)
  assert.equal(parseOptionLetter("The answer is D.", 8), 3)
  assert.equal(parseOptionLetter("```json\n{\"answer\": \"H\"}\n```", 8), 7)
  // Out of range for a 4-way item, and nothing parseable at all.
  assert.equal(parseOptionLetter('{"answer":"G"}', 4), null)
  assert.equal(parseOptionLetter("I cannot determine which of these is real.", 8), null)
})

test("month parsing accepts ISO, prose, and bare years", () => {
  assert.equal(parseMonthAnswer('{"answer":"2024-11"}'), "2024-11")
  assert.equal(parseMonthAnswer("I believe it is March 2025."), "2025-03")
  assert.equal(parseMonthAnswer("sometime in 2023"), "2023-06")
  assert.equal(parseMonthAnswer("I have no way to know."), null)
})

test("option order is deterministic per item id", () => {
  const a = shuffleOptions("2025-03-001-x", "TRUE", ["d1", "d2", "d3"])
  const b = shuffleOptions("2025-03-001-x", "TRUE", ["d1", "d2", "d3"])
  assert.deepEqual(a, b)
  assert.equal(a.options[a.answer], "TRUE")
  // Different ids must not all land the answer in the same slot.
  const positions = new Set(
    Array.from({ length: 12 }, (_, i) =>
      shuffleOptions(`item-${i}`, "TRUE", ["d1", "d2", "d3"]).answer
    )
  )
  assert.ok(positions.size > 1, "answer position should vary across items")
})

test("month range is inclusive and ordered", () => {
  assert.deepEqual(monthRange("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"])
  assert.deepEqual(monthRange("2026-02", "2025-11"), [])
})
