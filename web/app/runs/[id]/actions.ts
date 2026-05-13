"use server"

/**
 * Server action: load all runs + evals for a single brief.
 *
 * We don't ship this in the initial page payload because briefs can have
 * dozens of models attached and each one has a full signal list — would
 * inflate the HTML response. Action is called on-demand when the user
 * picks a brief in the drill-down UI.
 */
import { loadEval, loadMeta, loadRun } from "@/lib/results"

export async function getBriefDetail(runId: string, briefId: string) {
  const meta = loadMeta(runId)
  if (!meta) return null

  const byModel: Record<
    string,
    {
      signals: { title: string; category: string; summary: string }[]
      evaluations:
        | {
            signal_index: number
            verifiability: { verdict: string; score: number; comments?: string }
            currency: { score: number; newest_source_date?: string }
            specificity: { score: number; comments?: string }
            sources: { url: string; title?: string }[]
          }[]
        | undefined
      error?: { code: number; message: string }
    }
  > = {}

  for (const model of meta.models) {
    const run = loadRun(runId, briefId, model)
    if (!run) continue
    const ev = loadEval(runId, briefId, model)
    byModel[model] = {
      signals: run.signals,
      evaluations: ev?.evaluations,
      error: run.error,
    }
  }

  return { briefId, byModel }
}
