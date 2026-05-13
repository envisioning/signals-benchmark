import Link from "next/link"
import { listRuns, loadMeta } from "@/lib/results"

export default function RunsIndex() {
  const runs = listRuns()
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-white/80">
        No runs in <code>../results</code>.
      </div>
    )
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold text-white">All runs</h1>
      <p className="mt-1 text-sm text-white/60">
        Newest first. Click a row to open its leaderboard.
      </p>
      <div className="mt-6 overflow-hidden rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-white/60">
            <tr>
              <th className="px-4 py-2 font-medium">Run ID</th>
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium">Models</th>
              <th className="px-4 py-2 font-medium">Briefs</th>
              <th className="px-4 py-2 font-medium">Cost</th>
              <th className="px-4 py-2 font-medium">Leaderboard</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {runs.map((r) => {
              const meta = loadMeta(r.run_id)
              return (
                <tr key={r.run_id} className="hover:bg-white/5">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/runs/${r.run_id}`} className="underline hover:no-underline">
                      {r.run_id}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-white/70">
                    {meta?.started_at ? new Date(meta.started_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-white/70">{meta?.models?.length ?? "—"}</td>
                  <td className="px-4 py-2 text-white/70">{meta?.brief_ids?.length ?? "—"}</td>
                  <td className="px-4 py-2 text-white/70">
                    {meta?.total_cost_usd !== undefined
                      ? `$${meta.total_cost_usd.toFixed(4)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {r.hasLeaderboard ? (
                      <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                        ready
                      </span>
                    ) : (
                      <span className="rounded bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-300">
                        partial
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
