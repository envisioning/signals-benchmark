"use client"

/**
 * Sortable leaderboard table.
 *
 * Header click toggles asc/desc on that axis. Composite is the default
 * sort. The bar widths give a quick visual sense of distribution
 * without needing to read the numbers.
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

function compositeColor(v: number): string {
  if (v >= 75) return "bg-emerald-500/15 text-emerald-300"
  if (v >= 60) return "bg-yellow-500/15 text-yellow-300"
  return "bg-red-500/15 text-red-300"
}

function bar(v: number): string {
  // Tailwind doesn't allow dynamic width classes, so we ship style inline.
  return `${Math.max(0, Math.min(100, v))}%`
}

export function Leaderboard({ scores }: { scores: ModelScore[] }) {
  const [sortBy, setSortBy] = useState<Axis>("composite")
  const [dir, setDir] = useState<"asc" | "desc">("desc")

  const sorted = [...scores].sort((a, b) => {
    const av = a.overall[sortBy]
    const bv = b.overall[sortBy]
    return dir === "desc" ? bv - av : av - bv
  })

  function handleSort(axis: Axis) {
    if (sortBy === axis) {
      setDir(dir === "desc" ? "asc" : "desc")
    } else {
      setSortBy(axis)
      setDir("desc")
    }
  }

  return (
    <section className="mt-8">
      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold text-white">Models ranked</h2>
        <p className="text-xs text-white/50">
          Click any axis to re-sort · weights: Verif 0.40 · Spec 0.30 · Cur 0.15 · Cov 0.15
        </p>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-white/60">
            <tr>
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Model</th>
              {AXES.map((ax) => (
                <th
                  key={ax.key}
                  onClick={() => handleSort(ax.key)}
                  className={`cursor-pointer select-none px-4 py-2 text-right font-medium hover:text-white ${
                    sortBy === ax.key ? "text-white" : ""
                  }`}
                >
                  {ax.label}
                  {sortBy === ax.key && <span className="ml-1 text-white/50">{dir === "desc" ? "↓" : "↑"}</span>}
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium">Briefs</th>
              <th className="px-4 py-2 text-right font-medium">Signals</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {sorted.map((s, i) => (
              <tr key={s.model} className="hover:bg-white/5">
                <td className="px-4 py-2 text-white/50">{i + 1}</td>
                <td className="px-4 py-2 font-mono text-xs text-white">{s.model}</td>
                {AXES.map((ax) => {
                  const v = s.overall[ax.key]
                  const isComposite = ax.key === "composite"
                  return (
                    <td key={ax.key} className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="relative h-1.5 w-24 overflow-hidden rounded bg-white/5">
                          <div
                            className={`absolute inset-y-0 left-0 ${
                              isComposite ? "bg-emerald-400/60" : "bg-white/30"
                            }`}
                            style={{ width: bar(v) }}
                          />
                        </div>
                        <span
                          className={`min-w-[2.5rem] rounded px-2 py-0.5 text-xs tabular-nums ${
                            isComposite ? compositeColor(v) : "text-white/80"
                          }`}
                        >
                          {v}
                        </span>
                      </div>
                    </td>
                  )
                })}
                <td className="px-4 py-2 text-right text-white/60 tabular-nums">
                  {s.overall.n_briefs}
                </td>
                <td className="px-4 py-2 text-right text-white/60 tabular-nums">
                  {s.overall.n_signals_total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
