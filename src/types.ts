/**
 * Shared types for the model benchmark runner.
 *
 * Keep this file dependency-free — it's imported by every other module
 * and we want it cheap to load. No zod here; validation lives next to
 * each step that needs it.
 */

export type Brief = {
  id: string
  sector: string
  topic: string
  audience: string
  categories: string[]
  signalsPerCategory: number
}

export type GeneratedSignal = {
  title: string
  category: string
  summary: string
}

export type ModelRun = {
  brief_id: string
  model: string
  started_at: string
  finished_at: string
  duration_ms: number
  cost_usd?: number
  tokens?: number
  signals: GeneratedSignal[]
  error?: { code: number; message: string }
}

export type VerificationVerdict =
  | "grounded"
  | "speculative"
  | "indicative"
  | "dubious"
  | "fabricated"
  | "future"

export type SignalEvaluation = {
  signal_index: number
  verifiability: { verdict: VerificationVerdict; score: number; comments?: string }
  currency: { score: number; newest_source_date?: string }
  specificity: { score: number; comments?: string }
  sources: { url: string; title?: string; date?: string }[]
}

export type ModelEvaluation = {
  brief_id: string
  model: string
  judge_model: string
  evaluations: SignalEvaluation[]
  coverage: {
    score: number
    category_balance: number
    unique_share: number
  }
  /** Sum of OpenRouter-reported costs for verifier + specificity calls. */
  judge_cost_usd?: number
  /** Number of signals served from cache, by judge. */
  cache_hits?: { verifier: number; specificity: number }
}

export type ModelScore = {
  model: string
  per_brief: Record<
    string,
    {
      verifiability: number
      currency: number
      specificity: number
      coverage: number
      composite: number
      n_signals: number
    }
  >
  overall: {
    verifiability: number
    currency: number
    specificity: number
    coverage: number
    composite: number
    n_signals_total: number
    n_briefs: number
  }
}

export type BenchmarkRun = {
  run_id: string
  started_at: string
  finished_at?: string
  judge_model: string
  specificity_judge: string
  briefs_version: string
  models: string[]
  brief_ids: string[]
  /** Sum of generation costs (phase 1) reported by OpenRouter. */
  total_cost_usd?: number
  /** Sum of judge costs (phase 2) reported by OpenRouter. */
  judge_cost_usd?: number
  /**
   * Actually-billed amount for this run, computed by diffing the API
   * key's lifetime usage at the start and end of the run. More
   * reliable than summing per-call usage.cost because OpenRouter's
   * :online web-search surcharge isn't always in that field.
   */
  billed_actual_usd?: number
}
