"use client"

/**
 * Per-brief drill-down.
 *
 * Pick a brief, see how the top models compare on it specifically, and
 * load the actual signals + per-signal verdicts via a server action.
 * Keeps the initial page payload small — we only fetch a brief's raw
 * runs/evals when the user asks for them.
 */
import { useEffect, useState } from "react"
import type { ModelScore } from "@/lib/results"
import { getBriefDetail } from "./actions"

type BriefDetail = Awaited<ReturnType<typeof getBriefDetail>>

export function PerBrief({
  runId,
  scores,
  briefIds,
}: {
  runId: string
  scores: ModelScore[]
  briefIds: string[]
}) {
  const [briefId, setBriefId] = useState<string>(briefIds[0] ?? "")
  const [detail, setDetail] = useState<BriefDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [openModel, setOpenModel] = useState<string | null>(null)

  useEffect(() => {
    if (!briefId) return
    setLoading(true)
    setOpenModel(null)
    getBriefDetail(runId, briefId).then((d) => {
      setDetail(d)
      setLoading(false)
    })
  }, [runId, briefId])

  const rows = scores
    .map((s) => ({ model: s.model, b: s.per_brief[briefId] }))
    .filter((r): r is { model: string; b: NonNullable<typeof r.b> } => !!r.b)
    .sort((a, b) => b.b.composite - a.b.composite)

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">Per-brief drill-down</h2>
        <select
          value={briefId}
          onChange={(e) => setBriefId(e.target.value)}
          className="rounded-md border border-white/10 bg-black/40 px-3 py-1.5 text-sm text-white"
        >
          {briefIds.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-white/60">
            <tr>
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 text-right font-medium">Comp</th>
              <th className="px-4 py-2 text-right font-medium">Verif</th>
              <th className="px-4 py-2 text-right font-medium">Spec</th>
              <th className="px-4 py-2 text-right font-medium">Cur</th>
              <th className="px-4 py-2 text-right font-medium">Cov</th>
              <th className="px-4 py-2 text-right font-medium">Signals</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r, i) => {
              const isOpen = openModel === r.model
              return (
                <ModelRow
                  key={r.model}
                  i={i}
                  model={r.model}
                  b={r.b}
                  isOpen={isOpen}
                  onToggle={() => setOpenModel(isOpen ? null : r.model)}
                  detail={detail}
                  loading={loading}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ModelRow({
  i,
  model,
  b,
  isOpen,
  onToggle,
  detail,
  loading,
}: {
  i: number
  model: string
  b: {
    composite: number
    verifiability: number
    specificity: number
    currency: number
    coverage: number
    n_signals: number
  }
  isOpen: boolean
  onToggle: () => void
  detail: BriefDetail | null
  loading: boolean
}) {
  const modelDetail = detail?.byModel?.[model]
  return (
    <>
      <tr className="hover:bg-white/5">
        <td className="px-4 py-2 text-white/50">{i + 1}</td>
        <td className="px-4 py-2 font-mono text-xs text-white">{model}</td>
        <td className="px-4 py-2 text-right font-medium tabular-nums">{b.composite}</td>
        <td className="px-4 py-2 text-right text-white/70 tabular-nums">{b.verifiability}</td>
        <td className="px-4 py-2 text-right text-white/70 tabular-nums">{b.specificity}</td>
        <td className="px-4 py-2 text-right text-white/70 tabular-nums">{b.currency}</td>
        <td className="px-4 py-2 text-right text-white/70 tabular-nums">{b.coverage}</td>
        <td className="px-4 py-2 text-right text-white/70 tabular-nums">{b.n_signals}</td>
        <td className="px-4 py-2 text-right">
          <button
            onClick={onToggle}
            className="text-xs text-white/60 underline hover:no-underline"
          >
            {isOpen ? "hide" : "view signals"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={9} className="bg-black/30 px-4 py-3">
            {loading ? (
              <div className="text-xs text-white/60">Loading…</div>
            ) : !modelDetail ? (
              <div className="text-xs text-white/60">No detail available.</div>
            ) : (
              <SignalList detail={modelDetail} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function verdictColor(v: string): string {
  switch (v) {
    case "grounded":
      return "bg-emerald-500/15 text-emerald-300"
    case "speculative":
      return "bg-blue-500/15 text-blue-300"
    case "future":
      return "bg-purple-500/15 text-purple-300"
    case "indicative":
      return "bg-yellow-500/15 text-yellow-300"
    case "dubious":
      return "bg-orange-500/15 text-orange-300"
    case "fabricated":
      return "bg-red-500/20 text-red-300"
    default:
      return "bg-white/10 text-white/70"
  }
}

function SignalList({
  detail,
}: {
  detail: NonNullable<NonNullable<BriefDetail>["byModel"]>[string]
}) {
  if (!detail.signals || detail.signals.length === 0) {
    return <div className="text-xs text-white/60">No signals.</div>
  }
  return (
    <ul className="space-y-3">
      {detail.signals.map((sig, i) => {
        const ev = detail.evaluations?.find((e) => e.signal_index === i)
        return (
          <li key={i} className="rounded-md border border-white/5 bg-black/30 p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-white/40">
                {sig.category}
              </span>
              <h4 className="text-sm font-semibold text-white">{sig.title}</h4>
              {ev && (
                <span
                  className={`ml-auto rounded px-2 py-0.5 text-xs ${verdictColor(
                    ev.verifiability.verdict
                  )}`}
                  title={ev.verifiability.comments}
                >
                  {ev.verifiability.verdict} · {ev.verifiability.score}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-white/70">{sig.summary}</p>
            {ev && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
                <span>spec {ev.specificity.score}</span>
                <span>cur {ev.currency.score}</span>
                {ev.currency.newest_source_date && (
                  <span>newest src: {ev.currency.newest_source_date}</span>
                )}
                {ev.sources && ev.sources.length > 0 && (
                  <details className="ml-auto">
                    <summary className="cursor-pointer text-white/60 hover:text-white">
                      {ev.sources.length} sources
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {ev.sources.map((s, j) => (
                        <li key={j}>
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:no-underline"
                          >
                            {s.title || s.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {ev?.verifiability.comments && (
              <p className="mt-2 text-xs italic text-white/50">
                judge: {ev.verifiability.comments}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
