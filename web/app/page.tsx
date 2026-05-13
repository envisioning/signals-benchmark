/**
 * Landing page: redirect to the latest run, or show an empty-state if
 * the user hasn't run a benchmark yet.
 */
import Link from "next/link"
import { redirect } from "next/navigation"
import { getLatestRunId, listRuns, resultsDirExists } from "@/lib/results"

export default function Home() {
  if (!resultsDirExists()) {
    return <EmptyState reason="missing-dir" />
  }
  const latest = getLatestRunId()
  if (latest) {
    redirect(`/runs/${latest}`)
  }
  const runs = listRuns()
  if (runs.length === 0) {
    return <EmptyState reason="no-runs" />
  }
  return <EmptyState reason="no-leaderboard" />
}

function EmptyState({ reason }: { reason: "missing-dir" | "no-runs" | "no-leaderboard" }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-white/80">
      <h1 className="text-xl font-semibold text-white">No leaderboard yet</h1>
      <p className="mt-2 text-sm">
        {reason === "missing-dir"
          ? "The ../results directory doesn't exist. Run the benchmark CLI first."
          : reason === "no-runs"
            ? "No benchmark runs found in ../results."
            : "Found a run but no leaderboard.json — make sure the CLI finished cleanly, or re-render with `npm run bench:report`."}
      </p>
      <pre className="mt-4 rounded bg-black/40 p-4 text-xs text-emerald-300/90 overflow-x-auto">
        <code>{`cd ..
npm install
cp .env.example .env  # paste your OPENROUTER_API_KEY
npm run bench -- --models openai/gpt-4.1-mini --briefs healthcare-regulated-ai`}</code>
      </pre>
      <div className="mt-4 text-sm">
        <Link href="/runs" className="underline hover:no-underline">
          See all runs →
        </Link>
      </div>
    </div>
  )
}
