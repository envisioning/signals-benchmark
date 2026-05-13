/**
 * Leaderboard renderer.
 *
 * Emits both a markdown file (for sharing / committing to a repo) and a
 * console-friendly version. Per-axis sub-leaderboards live below the
 * composite so buyers with different priorities can find the model that
 * fits their use case.
 */
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import pc from "picocolors"
import type { BenchmarkRun, ModelScore } from "./types.ts"
import { WEIGHTS } from "./score.ts"

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n)
  return s + " ".repeat(n - s.length)
}

function fmt(score: number): string {
  return score.toString().padStart(3, " ")
}

export function renderMarkdown({
  run,
  scores,
}: {
  run: BenchmarkRun
  scores: ModelScore[]
}): string {
  const lines: string[] = []
  lines.push(`# Signals Benchmark Leaderboard`)
  lines.push("")
  lines.push(`- **Run ID:** \`${run.run_id}\``)
  lines.push(`- **Briefs version:** \`${run.briefs_version}\``)
  lines.push(`- **Briefs:** ${run.brief_ids.length}`)
  lines.push(`- **Models tested:** ${run.models.length}`)
  lines.push(`- **Judge (verifiability):** \`${run.judge_model}\``)
  lines.push(`- **Judge (specificity):** \`${run.specificity_judge}\``)
  lines.push(`- **Started:** ${run.started_at}`)
  if (run.finished_at) lines.push(`- **Finished:** ${run.finished_at}`)
  if (run.total_cost_usd !== undefined) {
    lines.push(`- **Generation cost:** $${run.total_cost_usd.toFixed(4)}`)
  }
  if (run.judge_cost_usd !== undefined) {
    lines.push(`- **Judging cost:** $${run.judge_cost_usd.toFixed(4)}`)
  }
  if (run.billed_actual_usd !== undefined) {
    lines.push(`- **Actually billed (OpenRouter /auth/key diff):** $${run.billed_actual_usd.toFixed(4)}`)
  }
  lines.push("")
  lines.push(
    `Composite weighting: Verifiability ${WEIGHTS.verifiability} · Specificity ${WEIGHTS.specificity} · Currency ${WEIGHTS.currency} · Coverage ${WEIGHTS.coverage}`
  )
  lines.push("")

  // Composite leaderboard
  lines.push(`## Composite leaderboard`)
  lines.push("")
  lines.push(`| # | Model | Composite | Verifiability | Specificity | Currency | Coverage | Briefs | Signals |`)
  lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|`)
  scores.forEach((s, i) => {
    lines.push(
      `| ${i + 1} | \`${s.model}\` | **${s.overall.composite}** | ${s.overall.verifiability} | ${s.overall.specificity} | ${s.overall.currency} | ${s.overall.coverage} | ${s.overall.n_briefs} | ${s.overall.n_signals_total} |`
    )
  })
  lines.push("")

  // Per-axis sub-leaderboards
  const axes: { key: keyof ModelScore["overall"]; label: string }[] = [
    { key: "verifiability", label: "Verifiability (web-grounded)" },
    { key: "specificity", label: "Specificity (writing quality)" },
    { key: "currency", label: "Currency (source recency)" },
    { key: "coverage", label: "Coverage (breadth + uniqueness)" },
  ]
  for (const axis of axes) {
    lines.push(`## ${axis.label}`)
    lines.push("")
    const sorted = [...scores].sort(
      (a, b) => (b.overall[axis.key] as number) - (a.overall[axis.key] as number)
    )
    lines.push(`| # | Model | Score |`)
    lines.push(`|---|---|---:|`)
    sorted.slice(0, 20).forEach((s, i) => {
      lines.push(`| ${i + 1} | \`${s.model}\` | ${s.overall[axis.key]} |`)
    })
    lines.push("")
  }

  // Per-brief detail (top 10 composite models only — keeps file readable)
  lines.push(`## Per-brief detail (top 10 by composite)`)
  lines.push("")
  const topModels = scores.slice(0, 10)
  for (const bid of run.brief_ids) {
    lines.push(`### ${bid}`)
    lines.push("")
    lines.push(`| Model | Composite | Verif. | Spec. | Cur. | Cov. | n |`)
    lines.push(`|---|---:|---:|---:|---:|---:|---:|`)
    const rows = topModels
      .map((s) => ({ model: s.model, b: s.per_brief[bid] }))
      .filter((r) => r.b)
      .sort((a, b) => b.b!.composite - a.b!.composite)
    for (const r of rows) {
      lines.push(
        `| \`${r.model}\` | **${r.b!.composite}** | ${r.b!.verifiability} | ${r.b!.specificity} | ${r.b!.currency} | ${r.b!.coverage} | ${r.b!.n_signals} |`
      )
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function renderConsole({
  run,
  scores,
}: {
  run: BenchmarkRun
  scores: ModelScore[]
}): string {
  const lines: string[] = []
  lines.push("")
  lines.push(pc.bold(pc.cyan(`Signals Benchmark — ${run.run_id}`)))
  lines.push(
    pc.dim(
      `${run.brief_ids.length} briefs · ${run.models.length} models · judge: ${run.judge_model}`
    )
  )
  lines.push("")
  lines.push(
    pc.bold(
      `${pad("#", 4)}${pad("Model", 44)}${pad("Comp", 6)}${pad("Verif", 7)}${pad("Spec", 6)}${pad("Cur", 5)}${pad("Cov", 5)}`
    )
  )
  lines.push(pc.dim("─".repeat(77)))
  scores.forEach((s, i) => {
    const rank = `${i + 1}`
    const composite = s.overall.composite
    const compColor =
      composite >= 75 ? pc.green : composite >= 60 ? pc.yellow : pc.red
    lines.push(
      `${pad(rank, 4)}${pad(s.model, 44)}${compColor(pad(fmt(composite), 6))}${pad(fmt(s.overall.verifiability), 7)}${pad(fmt(s.overall.specificity), 6)}${pad(fmt(s.overall.currency), 5)}${pad(fmt(s.overall.coverage), 5)}`
    )
  })
  lines.push("")
  return lines.join("\n")
}

export function writeReport({
  run,
  scores,
  outDir,
}: {
  run: BenchmarkRun
  scores: ModelScore[]
  outDir: string
}): { mdPath: string; jsonPath: string } {
  const md = renderMarkdown({ run, scores })
  const mdPath = resolve(outDir, "leaderboard.md")
  writeFileSync(mdPath, md, "utf-8")

  const jsonPath = resolve(outDir, "leaderboard.json")
  writeFileSync(jsonPath, JSON.stringify({ run, scores }, null, 2), "utf-8")

  return { mdPath, jsonPath }
}
