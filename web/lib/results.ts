/**
 * Server-only helpers to read benchmark runs from ../results/.
 *
 * The CLI emits one directory per run; this module is the only place that
 * touches the filesystem. Anything that needs run data should import from
 * here so we can swap to a remote/Supabase backend later without touching
 * the page components.
 */
import "server-only"
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

export type Brief = {
  id: string
  sector: string
  topic: string
  audience: string
  categories: string[]
  signalsPerCategory: number
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

export type BenchmarkMeta = {
  run_id: string
  started_at: string
  finished_at?: string
  judge_model: string
  specificity_judge: string
  briefs_version: string
  models: string[]
  brief_ids: string[]
  /** Sum of per-call usage.cost reported by OpenRouter for phase-1 generation. */
  total_cost_usd?: number
  /** Sum of per-call usage.cost reported by OpenRouter for phase-2 judging. */
  judge_cost_usd?: number
  /**
   * Actually-billed cost computed by diffing /auth/key usage at run
   * start vs end. Closer to the OpenRouter dashboard truth than the
   * two per-call sums above, which can over- or under-report the
   * web-search surcharge on :online models.
   */
  billed_actual_usd?: number
}

export type Leaderboard = {
  run: BenchmarkMeta
  scores: ModelScore[]
}

export type SignalEvaluation = {
  signal_index: number
  verifiability: { verdict: string; score: number; comments?: string }
  currency: { score: number; newest_source_date?: string }
  specificity: { score: number; comments?: string }
  sources: { url: string; title?: string }[]
}

export type ModelEvaluation = {
  brief_id: string
  model: string
  judge_model: string
  evaluations: SignalEvaluation[]
}

export type ModelRun = {
  brief_id: string
  model: string
  started_at: string
  finished_at: string
  duration_ms: number
  cost_usd?: number
  tokens?: number
  signals: { title: string; category: string; summary: string }[]
  error?: { code: number; message: string }
}

const RESULTS_DIR = resolve(process.cwd(), "..", "results")

export function resultsDirExists(): boolean {
  return existsSync(RESULTS_DIR)
}

export function listRuns(): { run_id: string; mtime: number; hasLeaderboard: boolean }[] {
  if (!existsSync(RESULTS_DIR)) return []
  const entries = readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(RESULTS_DIR, e.name)
      const lbPath = join(dir, "leaderboard.json")
      const metaPath = join(dir, "meta.json")
      const exists = existsSync(metaPath)
      if (!exists) return null
      const stat = statSync(metaPath)
      return {
        run_id: e.name,
        mtime: stat.mtimeMs,
        hasLeaderboard: existsSync(lbPath),
      }
    })
    .filter((x): x is { run_id: string; mtime: number; hasLeaderboard: boolean } => !!x)
  entries.sort((a, b) => b.mtime - a.mtime)
  return entries
}

export function getLatestRunId(): string | undefined {
  const runs = listRuns()
  return runs[0]?.run_id
}

export function loadLeaderboard(runId: string): Leaderboard | null {
  const path = join(RESULTS_DIR, runId, "leaderboard.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Leaderboard
  } catch {
    return null
  }
}

export function loadMeta(runId: string): BenchmarkMeta | null {
  const path = join(RESULTS_DIR, runId, "meta.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BenchmarkMeta
  } catch {
    return null
  }
}

export function loadRun(runId: string, briefId: string, model: string): ModelRun | null {
  const file = `${briefId}__${model.replace(/\//g, "_")}.json`
  const path = join(RESULTS_DIR, runId, "runs", file)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ModelRun
  } catch {
    return null
  }
}

export function loadEval(runId: string, briefId: string, model: string): ModelEvaluation | null {
  const file = `${briefId}__${model.replace(/\//g, "_")}.json`
  const path = join(RESULTS_DIR, runId, "evals", file)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ModelEvaluation
  } catch {
    return null
  }
}
