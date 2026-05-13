/**
 * Scoring + aggregation.
 *
 * Coverage is computed here (not in evaluate.ts) because it's a
 * brief-level metric that requires every model's output for the same
 * brief — category balance plus how much a model's signal set overlaps
 * with the rest of the cohort.
 *
 * Composite weights:
 *   verifiability 0.40 — substance of the claim
 *   specificity   0.30 — writing quality / hype resistance
 *   currency      0.15 — recency of supporting evidence
 *   coverage      0.15 — breadth across categories + uniqueness
 *
 * These are deliberate: substance > form > recency ≈ breadth. Adjust
 * here if your buyer persona weights them differently — the per-axis
 * sub-leaderboards stay valid regardless of composite weighting.
 */
import type {
  Brief,
  ModelEvaluation,
  ModelRun,
  ModelScore,
} from "./types.ts"

export const WEIGHTS = {
  verifiability: 0.4,
  specificity: 0.3,
  currency: 0.15,
  coverage: 0.15,
} as const

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersect = 0
  for (const x of a) if (b.has(x)) intersect++
  const union = a.size + b.size - intersect
  return union === 0 ? 0 : intersect / union
}

/**
 * Compute coverage per (brief, model). Two parts averaged:
 *   - category_balance: how evenly distributed signals are across the
 *     brief's categories (uniform = 100; one bucket = 0).
 *   - unique_share: share of this model's signals that have NO near-
 *     duplicate in any other model's signal set for the same brief
 *     (Jaccard < 0.3 on title+summary tokens). Rewards finding things
 *     others missed.
 */
export function computeCoverage(
  brief: Brief,
  runsForBrief: ModelRun[]
): Record<string, { score: number; category_balance: number; unique_share: number }> {
  const out: Record<string, { score: number; category_balance: number; unique_share: number }> = {}

  // Build per-model token sets for similarity matching.
  const tokenSets: Record<string, Set<string>[]> = {}
  for (const run of runsForBrief) {
    tokenSets[run.model] = run.signals.map((s) => tokenize(`${s.title} ${s.summary}`))
  }

  for (const run of runsForBrief) {
    const wantedCats = brief.categories
    const counts = new Map<string, number>(wantedCats.map((c) => [c, 0]))
    for (const sig of run.signals) {
      if (counts.has(sig.category)) {
        counts.set(sig.category, (counts.get(sig.category) ?? 0) + 1)
      }
    }
    const values = [...counts.values()]
    const totalAssigned = values.reduce((a, b) => a + b, 0)
    let category_balance = 0
    if (totalAssigned > 0) {
      const ideal = totalAssigned / wantedCats.length
      const meanDev =
        values.reduce((acc, v) => acc + Math.abs(v - ideal), 0) /
        wantedCats.length
      const normalized = Math.max(0, 1 - meanDev / Math.max(1, ideal))
      category_balance = Math.round(normalized * 100)
    }

    // unique_share
    const mySet = tokenSets[run.model] ?? []
    let uniqueCount = 0
    for (const myTokens of mySet) {
      let maxSim = 0
      outer: for (const otherRun of runsForBrief) {
        if (otherRun.model === run.model) continue
        for (const otherTokens of tokenSets[otherRun.model] ?? []) {
          const sim = jaccard(myTokens, otherTokens)
          if (sim > maxSim) maxSim = sim
          if (maxSim >= 0.3) break outer
        }
      }
      if (maxSim < 0.3) uniqueCount++
    }
    const unique_share =
      mySet.length === 0 ? 0 : Math.round((uniqueCount / mySet.length) * 100)

    const score = Math.round((category_balance + unique_share) / 2)
    out[run.model] = { score, category_balance, unique_share }
  }

  return out
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function scoreModels({
  briefs,
  runs,
  evaluations,
}: {
  briefs: Brief[]
  runs: ModelRun[]
  evaluations: ModelEvaluation[]
}): ModelScore[] {
  const briefById = new Map(briefs.map((b) => [b.id, b]))
  const runByBriefModel = new Map<string, ModelRun>()
  for (const r of runs) runByBriefModel.set(`${r.brief_id}::${r.model}`, r)
  const evalByBriefModel = new Map<string, ModelEvaluation>()
  for (const e of evaluations) evalByBriefModel.set(`${e.brief_id}::${e.model}`, e)

  // Per-brief coverage (needs the full cohort).
  const briefIds = [...new Set(runs.map((r) => r.brief_id))]
  const coverageByBrief: Record<string, Record<string, ReturnType<typeof computeCoverage>[string]>> = {}
  for (const bid of briefIds) {
    const brief = briefById.get(bid)
    if (!brief) continue
    const briefRuns = runs.filter((r) => r.brief_id === bid && !r.error)
    coverageByBrief[bid] = computeCoverage(brief, briefRuns)
  }

  const models = [...new Set(runs.map((r) => r.model))]
  const scored: ModelScore[] = []

  for (const model of models) {
    const per_brief: ModelScore["per_brief"] = {}
    const vAcc: number[] = []
    const sAcc: number[] = []
    const cAcc: number[] = []
    const covAcc: number[] = []
    const compositeAcc: number[] = []
    let nSignalsTotal = 0
    let briefsCovered = 0

    for (const bid of briefIds) {
      const run = runByBriefModel.get(`${bid}::${model}`)
      const ev = evalByBriefModel.get(`${bid}::${model}`)
      if (!run || run.error || !ev) continue

      const verifiability = Math.round(mean(ev.evaluations.map((e) => e.verifiability.score)))
      const specificity = Math.round(mean(ev.evaluations.map((e) => e.specificity.score)))
      const currency = Math.round(mean(ev.evaluations.map((e) => e.currency.score)))
      const coverage = coverageByBrief[bid]?.[model]?.score ?? 0

      const composite = Math.round(
        verifiability * WEIGHTS.verifiability +
          specificity * WEIGHTS.specificity +
          currency * WEIGHTS.currency +
          coverage * WEIGHTS.coverage
      )

      per_brief[bid] = {
        verifiability,
        specificity,
        currency,
        coverage,
        composite,
        n_signals: run.signals.length,
      }
      vAcc.push(verifiability)
      sAcc.push(specificity)
      cAcc.push(currency)
      covAcc.push(coverage)
      compositeAcc.push(composite)
      nSignalsTotal += run.signals.length
      briefsCovered++
    }

    scored.push({
      model,
      per_brief,
      overall: {
        verifiability: Math.round(mean(vAcc)),
        specificity: Math.round(mean(sAcc)),
        currency: Math.round(mean(cAcc)),
        coverage: Math.round(mean(covAcc)),
        composite: Math.round(mean(compositeAcc)),
        n_signals_total: nSignalsTotal,
        n_briefs: briefsCovered,
      },
    })
  }

  scored.sort((a, b) => b.overall.composite - a.overall.composite)
  return scored
}
