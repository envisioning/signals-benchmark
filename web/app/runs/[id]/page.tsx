import Link from "next/link"
import { notFound } from "next/navigation"
import { loadLeaderboard, loadMeta } from "@/lib/results"
import { Leaderboard } from "./leaderboard"
import { PerBrief } from "./per-brief"
import { PerIndustry } from "./per-industry"

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = loadLeaderboard(id)
  const meta = loadMeta(id)
  if (!data || !meta) {
    notFound()
  }
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Leaderboard</h1>
          <p className="mt-1 font-mono text-xs text-white/50">{id}</p>
        </div>
        <Link href="/runs" className="text-sm text-white/60 underline hover:no-underline">
          ← all runs
        </Link>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-white/70 md:grid-cols-4">
        <Field label="Started" value={new Date(meta.started_at).toLocaleString()} />
        <Field
          label="Finished"
          value={meta.finished_at ? new Date(meta.finished_at).toLocaleString() : "—"}
        />
        <Field label="Briefs" value={String(meta.brief_ids.length)} />
        <Field label="Models" value={String(meta.models.length)} />
        <Field label="Verif. judge" value={meta.judge_model} mono />
        <Field label="Spec. judge" value={meta.specificity_judge} mono />
        <Field label="Briefs version" value={meta.briefs_version} mono />
      </dl>

      {/* Cost panel — break out gen / judge / actually billed so the
          discrepancy between OR's per-call sums and the auth/key debit
          is visible. The billed number is the one that matches the
          OpenRouter dashboard. */}
      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs uppercase tracking-wide text-white/40">Cost</div>
        <div className="mt-2 grid grid-cols-3 gap-x-6">
          <CostCell
            label="Generation (phase 1)"
            value={meta.total_cost_usd}
            hint="Sum of per-call usage.cost"
          />
          <CostCell
            label="Judging (phase 2)"
            value={meta.judge_cost_usd}
            hint="Sum of per-call usage.cost"
          />
          <CostCell
            label="Actually billed"
            value={meta.billed_actual_usd}
            hint="OpenRouter /auth/key delta — matches dashboard"
            emphasis
          />
        </div>
      </div>

      <Leaderboard scores={data.scores} />

      <PerIndustry scores={data.scores} briefIds={meta.brief_ids} />

      <PerBrief runId={id} scores={data.scores} briefIds={meta.brief_ids} />
    </div>
  )
}

function CostCell({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string
  value: number | undefined
  hint: string
  emphasis?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-white/50">{label}</div>
      <div
        className={
          emphasis
            ? "text-lg font-semibold text-emerald-300 tabular-nums"
            : "text-base text-white/80 tabular-nums"
        }
      >
        {value !== undefined ? `$${value.toFixed(4)}` : "—"}
      </div>
      <div className="mt-0.5 text-[10px] text-white/35">{hint}</div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-white/40">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "text-sm"}>{value}</dd>
    </div>
  )
}
