"use client"

/**
 * Per-industry rankings overview.
 *
 * Shows a compact matrix: rows = models, columns = briefs (industries).
 * Each cell = that model's composite score on that brief, colored by
 * value. Lets the user spot at a glance: which models are generalists
 * (consistent across industries) vs specialists (peaks on some, dips
 * on others).
 *
 * This is different from the existing PerBrief drill-down below: that
 * one is "pick a brief, see the model ranking + signals". This one is
 * "see all briefs and all models in one matrix" — the bird's-eye view
 * the user asked for ("per-industry scores").
 */
import { useState } from "react"
import type { ModelScore } from "@/lib/results"

type Axis = "composite" | "verifiability" | "specificity" | "currency" | "coverage"
const AXES: { key: Axis; label: string }[] = [
  { key: "composite", label: "Composite" },
  { key: "verifiability", label: "Verifiability" },
  { key: "specificity", label: "Specificity" },
  { key: "currency", label: "Currency" },
  { key: "coverage", label: "Coverage" },
]

function colorFor(v: number | undefined): string {
  if (v === undefined) return "text-white/20"
  if (v >= 80) return "text-emerald-300"
  if (v >= 70) return "text-emerald-400/90"
  if (v >= 60) return "text-yellow-300/90"
  if (v >= 50) return "text-yellow-400/80"
  if (v >= 40) return "text-orange-400/80"
  return "text-red-400/80"
}

function bgFor(v: number | undefined): string {
  if (v === undefined) return "bg-white/[0.02]"
  if (v >= 80) return "bg-emerald-500/15"
  if (v >= 70) return "bg-emerald-500/10"
  if (v >= 60) return "bg-yellow-500/10"
  if (v >= 50) return "bg-yellow-500/[0.06]"
  if (v >= 40) return "bg-orange-500/[0.08]"
  return "bg-red-500/[0.08]"
}

export function PerIndustry({
  scores,
  briefIds,
}: {
  scores: ModelScore[]
  briefIds: string[]
}) {
  const [axis, setAxis] = useState<Axis>("composite")

  // Sort models by overall composite (stable ranking down the left
  // edge so the matrix reads "best generalist at top").
  const ordered = [...scores].sort(
    (a, b) => b.overall.composite - a.overall.composite
  )

  // Per-brief average across the cohort — for the "Cohort avg" row.
  const cohortAvg: Record<string, number> = {}
  for (const bid of briefIds) {
    const values = scores
      .map((s) => s.per_brief[bid]?.[axis])
      .filter((v): v is number => typeof v === "number")
    cohortAvg[bid] = values.length
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : 0
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Per-industry scores
          </h2>
          <p className="mt-0.5 text-xs text-white/50">
            Each cell = a model's score on a brief. Rows ordered by overall composite.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-white/10 bg-black/30 p-1 text-xs">
          {AXES.map((a) => (
            <button
              key={a.key}
              onClick={() => setAxis(a.key)}
              className={`rounded px-2.5 py-1 transition ${
                axis === a.key
                  ? "bg-white/10 text-white"
                  : "text-white/60 hover:text-white"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-xs">
          <thead className="bg-white/5 text-left text-white/60">
            <tr>
              <th className="sticky left-0 z-10 bg-[#0e1114] px-3 py-2 font-medium">
                Model
              </th>
              <th className="px-2 py-2 text-right font-medium">Overall</th>
              {briefIds.map((b) => (
                <th
                  key={b}
                  className="px-2 py-2 font-medium"
                  title={b}
                >
                  <div className="origin-bottom-left -rotate-45 whitespace-nowrap pl-1 text-[11px] text-white/60">
                    {b.replace(/-/g, " ")}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {ordered.map((s) => (
              <tr key={s.model} className="hover:bg-white/[0.03]">
                <td className="sticky left-0 z-10 bg-[#0e1114] px-3 py-1.5 font-mono text-[11px] text-white whitespace-nowrap">
                  {s.model}
                </td>
                <td
                  className={`px-2 py-1.5 text-right font-semibold tabular-nums ${colorFor(s.overall[axis])}`}
                >
                  {s.overall[axis]}
                </td>
                {briefIds.map((b) => {
                  const v = s.per_brief[b]?.[axis]
                  return (
                    <td
                      key={b}
                      className={`px-2 py-1.5 text-center tabular-nums ${bgFor(v)} ${colorFor(v)}`}
                    >
                      {v ?? "—"}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="border-t-2 border-white/10 bg-white/[0.02]">
              <td className="sticky left-0 z-10 bg-[#0e1114] px-3 py-1.5 text-[11px] uppercase tracking-wide text-white/40">
                Cohort avg
              </td>
              <td className="px-2 py-1.5 text-right text-white/60 tabular-nums">
                —
              </td>
              {briefIds.map((b) => (
                <td
                  key={b}
                  className="px-2 py-1.5 text-center text-white/60 tabular-nums"
                >
                  {cohortAvg[b]}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
