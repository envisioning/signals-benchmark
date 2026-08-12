/**
 * Regression test for the `--into` + `--briefs <subset>` scoring bug.
 *
 * `scoreModels` computes coverage per brief by looking each brief up in a
 * map built from its `briefs` argument (score.ts:131,141). Any brief that
 * appears in `runs` but NOT in `briefs` is skipped, so its coverage silently
 * falls back to 0 (score.ts:168). When the full cohort's runs are scored
 * against only a 1-brief subset, coverage collapses to ~0 for every brief
 * except the subset one — dragging down composite for EVERY model.
 *
 * The cli fix (cli.ts, `scoringBriefs`) guarantees scoreModels always sees
 * the full brief set in --into mode. This test pins the underlying contract:
 * pass the full brief set and coverage stays healthy; pass a subset and it
 * collapses — so a future regression that hands scoreModels a subset fails
 * here loudly.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { scoreModels } from "./score.ts"
import type { Brief, ModelEvaluation, ModelRun } from "./types.ts"

const BRIEFS: Brief[] = ["b1", "b2", "b3"].map((id) => ({
  id,
  sector: "tech",
  topic: `topic ${id}`,
  audience: "analysts",
  categories: ["alpha", "beta"],
  signalsPerCategory: 1,
}))

// Two models, each producing balanced (one per category) and mutually
// distinct signals for every brief → category_balance 100, unique_share 100.
const SIGNALS: Record<string, { title: string; category: string; summary: string }[]> = {
  m1: [
    { title: "quantum lattice breakthrough", category: "alpha", summary: "novel supercooled fabrication method" },
    { title: "orbital relay constellation", category: "beta", summary: "expanded satellite mesh deployment" },
  ],
  m2: [
    { title: "photonic interconnect milestone", category: "alpha", summary: "chiplet bandwidth doubling achieved" },
    { title: "geothermal drilling advance", category: "beta", summary: "deeper reservoir tapping technique" },
  ],
}

function makeRuns(): ModelRun[] {
  const runs: ModelRun[] = []
  for (const brief of BRIEFS) {
    for (const model of ["m1", "m2"]) {
      runs.push({
        brief_id: brief.id,
        model,
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:10Z",
        duration_ms: 10_000,
        signals: SIGNALS[model],
      })
    }
  }
  return runs
}

function makeEvals(): ModelEvaluation[] {
  const evals: ModelEvaluation[] = []
  for (const brief of BRIEFS) {
    for (const model of ["m1", "m2"]) {
      evals.push({
        brief_id: brief.id,
        model,
        judge_model: "judge",
        evaluations: SIGNALS[model].map((_, i) => ({
          signal_index: i,
          verifiability: { verdict: "grounded", score: 80 },
          currency: { score: 70 },
          specificity: { score: 75 },
          sources: [],
        })),
        coverage: { score: 0, category_balance: 0, unique_share: 0 },
      })
    }
  }
  return evals
}

test("full brief set keeps coverage healthy for every model", () => {
  const scores = scoreModels({ briefs: BRIEFS, runs: makeRuns(), evaluations: makeEvals() })
  assert.equal(scores.length, 2)
  for (const s of scores) {
    // Balanced + distinct signals → coverage should be at the top of the range.
    assert.ok(
      s.overall.coverage >= 80,
      `${s.model}: expected healthy coverage, got ${s.overall.coverage}`
    )
  }
})

test("scoring the full cohort against a 1-brief subset collapses coverage (the bug)", () => {
  const runs = makeRuns()
  const evaluations = makeEvals()
  const full = scoreModels({ briefs: BRIEFS, runs, evaluations })
  const subset = scoreModels({ briefs: [BRIEFS[0]], runs, evaluations })

  const covOf = (scores: typeof full, model: string) =>
    scores.find((s) => s.model === model)!.overall.coverage

  for (const model of ["m1", "m2"]) {
    const fullCov = covOf(full, model)
    const subsetCov = covOf(subset, model)
    // b2/b3 are absent from the subset → their coverage falls back to 0,
    // so the average must drop well below the full-set value.
    assert.ok(
      subsetCov < fullCov - 30,
      `${model}: subset coverage (${subsetCov}) should collapse vs full (${fullCov})`
    )
  }
})
