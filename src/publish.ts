/**
 * bench:publish — copies a run's data into the signals-strict repo as:
 *
 *   public/benchmark/<YYYY-MM-DD>.json            ← overview (leaderboard)
 *   public/benchmark/<YYYY-MM-DD>/<model>.json    ← per-model detail (signals + judge verdicts)
 *
 * Also rewrites the public page's `CURRENT_BENCHMARK_FILE` constant
 * to point at the new date.
 *
 * Usage:
 *   pnpm bench:publish                            (latest run, today's date)
 *   pnpm bench:publish --run <run-id>
 *   pnpm bench:publish --date 2026-08-15
 *   pnpm bench:publish --dest ../signals-strict   (override the target repo)
 *   pnpm bench:publish --no-detail                (only publish the overview)
 *   pnpm bench:publish --dry-run
 *
 * Why per-model detail: the overview JSON is small (one row per model)
 * and good for the leaderboard table. But for "click a model, see its
 * 192 signals with verdicts and citations" we need the underlying data.
 * Splitting per-model keeps each fetch small (≈ 50KB) and lets the
 * future per-model page load on demand.
 *
 * Designed to be the *only* link between the benchmark runner and the
 * public-page repo. No symlinks, no shared deps — just an explicit
 * copy operation that shows up in a git diff before deploy.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import pc from "picocolors"

// ── Types (kept narrow; mirror the runner's outputs) ─────────────────

type ModelScoreOverall = {
  verifiability: number
  specificity: number
  currency: number
  coverage: number
  composite: number
  n_signals_total: number
  n_briefs: number
}
type ModelScore = {
  model: string
  per_brief: Record<
    string,
    {
      verifiability: number
      specificity: number
      currency: number
      coverage: number
      composite: number
      n_signals: number
    }
  >
  overall: ModelScoreOverall
}
type Leaderboard = {
  run: {
    run_id: string
    started_at: string
    finished_at?: string
    judge_model: string
    specificity_judge: string
    briefs_version: string
    brief_ids: string[]
    models: string[]
    total_cost_usd?: number
    judge_cost_usd?: number
    billed_actual_usd?: number
  }
  scores: ModelScore[]
}

type GeneratedSignal = {
  title: string
  category: string
  summary: string
}
type ModelRun = {
  brief_id: string
  model: string
  signals: GeneratedSignal[]
  error?: { code: number; message: string }
}
type SignalEvaluation = {
  signal_index: number
  verifiability: { verdict: string; score: number; comments?: string }
  currency: { score: number; newest_source_date?: string }
  specificity: { score: number; comments?: string }
  sources: { url: string; title?: string }[]
}
type ModelEvaluation = {
  brief_id: string
  model: string
  judge_model: string
  evaluations: SignalEvaluation[]
}

// ── Per-model detail shape (committed to public/benchmark/<date>/) ────

type ModelDetailSignal = {
  index: number
  category: string
  title: string
  summary: string
  verdict: string
  verifiability_score: number
  specificity_score: number
  currency_score: number
  newest_source_date?: string
  judge_comments?: string
  spec_comments?: string
  sources: { url: string; title?: string }[]
}

type ModelDetail = {
  /** Slug as it appears on OpenRouter / Vercel AI Gateway. */
  model: string
  /** Date label for this benchmark run, matches overview filename. */
  date: string
  /** Internal run ID for tracing back to the source run dir. */
  run_id: string
  /** Judge models used — important so consumers can interpret scores. */
  judge_model: string
  specificity_judge: string
  /** Same shape as `overview.scores[i]`, repeated here for convenience. */
  overall: ModelScoreOverall
  /**
   * One entry per brief. `signals` is the per-signal drill-down: title,
   * verdict, judge's plain-language comment, and the URL citations the
   * verifier actually consulted.
   */
  briefs: Array<{
    brief_id: string
    scores?: ModelScore["per_brief"][string]
    signals: ModelDetailSignal[]
    error?: { code: number; message: string }
  }>
}

// ── Arg parsing ──────────────────────────────────────────────────────

type Args = Record<string, string | boolean>
function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function latestRunId(resultsDir: string): string | undefined {
  if (!existsSync(resultsDir)) return undefined
  const dirs = readdirSync(resultsDir).filter((d) =>
    existsSync(join(resultsDir, d, "leaderboard.json"))
  )
  if (dirs.length === 0) return undefined
  dirs.sort()
  return dirs[dirs.length - 1]
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * OpenRouter slugs contain "/" which can't go in a file name. Replace
 * with "_" — matches the runner's run/eval file naming convention so
 * consumers can map back if needed.
 */
function modelSlugToFilename(slug: string): string {
  return `${slug.replace(/\//g, "_")}.json`
}

// ── Per-model detail builder ─────────────────────────────────────────

function buildModelDetail({
  modelScore,
  meta,
  date,
  runs,
  evals,
}: {
  modelScore: ModelScore
  meta: Leaderboard["run"]
  date: string
  /** Index keyed by `${brief_id}::${model}` → ModelRun. */
  runs: Map<string, ModelRun>
  /** Same shape, → ModelEvaluation. */
  evals: Map<string, ModelEvaluation>
}): ModelDetail {
  const briefs: ModelDetail["briefs"] = meta.brief_ids.map((bid) => {
    const key = `${bid}::${modelScore.model}`
    const run = runs.get(key)
    const ev = evals.get(key)
    if (!run || run.error) {
      return {
        brief_id: bid,
        scores: modelScore.per_brief[bid],
        signals: [],
        error: run?.error,
      }
    }
    const signals: ModelDetailSignal[] = run.signals.map((sig, i) => {
      const evalRow = ev?.evaluations.find((e) => e.signal_index === i)
      return {
        index: i,
        category: sig.category,
        title: sig.title,
        summary: sig.summary,
        verdict: evalRow?.verifiability.verdict ?? "unknown",
        verifiability_score: evalRow?.verifiability.score ?? 0,
        specificity_score: evalRow?.specificity.score ?? 0,
        currency_score: evalRow?.currency.score ?? 0,
        newest_source_date: evalRow?.currency.newest_source_date,
        judge_comments: evalRow?.verifiability.comments,
        spec_comments: evalRow?.specificity.comments,
        sources: evalRow?.sources ?? [],
      }
    })
    return {
      brief_id: bid,
      scores: modelScore.per_brief[bid],
      signals,
    }
  })

  return {
    model: modelScore.model,
    date,
    run_id: meta.run_id,
    judge_model: meta.judge_model,
    specificity_judge: meta.specificity_judge,
    overall: modelScore.overall,
    briefs,
  }
}

function indexBy<T extends { brief_id: string; model: string }>(
  arr: T[]
): Map<string, T> {
  const m = new Map<string, T>()
  for (const x of arr) m.set(`${x.brief_id}::${x.model}`, x)
  return m
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as T)
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dryRun = Boolean(args["dry-run"])
  const skipDetail = Boolean(args["no-detail"])
  const dest = resolve(
    (args.dest as string) ?? resolve(process.cwd(), "..", "signals-strict")
  )
  const resultsDir = resolve(process.cwd(), "results")
  const runId = (args.run as string) || latestRunId(resultsDir)

  if (!runId) {
    console.error(pc.red("No run id and no leaderboards in results/"))
    process.exit(1)
  }

  const runDir = join(resultsDir, runId)
  const overviewSrc = join(runDir, "leaderboard.json")
  if (!existsSync(overviewSrc)) {
    console.error(pc.red(`Source leaderboard missing: ${overviewSrc}`))
    process.exit(1)
  }

  const date = (args.date as string) || todayIso()
  const destBenchDir = join(dest, "public", "benchmark")
  const overviewDest = join(destBenchDir, `${date}.json`)
  const detailDir = join(destBenchDir, date)
  // The CURRENT_BENCHMARK_FILE constant moved to _shared.ts so client
  // components could import it (they can't pull from a Server-Component
  // page.tsx). Update there.
  const pagePath = join(
    dest,
    "src",
    "app",
    "(public)",
    "benchmark",
    "_shared.ts"
  )

  if (!existsSync(destBenchDir)) {
    console.error(
      pc.red(`Destination dir missing: ${destBenchDir} — is --dest correct?`)
    )
    process.exit(1)
  }
  if (!existsSync(pagePath)) {
    console.error(pc.red(`Page file missing: ${pagePath}`))
    process.exit(1)
  }

  // Validate + load overview.
  let overview: Leaderboard
  try {
    overview = JSON.parse(readFileSync(overviewSrc, "utf-8")) as Leaderboard
    if (!overview.scores?.length) throw new Error("leaderboard.json has no scores[]")
  } catch (e: any) {
    console.error(pc.red(`Source overview invalid: ${e?.message ?? e}`))
    process.exit(1)
  }

  // Filter models we'll write detail for: drop any that produced
  // no signals (nemotron returned 0 across all briefs → noise on the
  // public page).
  const publishableScores = overview.scores.filter(
    (s) => s.overall.n_signals_total > 0
  )

  console.log(pc.bold("Publish plan"))
  console.log(`  source:        ${pc.cyan(overviewSrc)}`)
  console.log(`  overview dest: ${pc.cyan(overviewDest)}`)
  console.log(`  detail dest:   ${pc.cyan(detailDir + "/")}`)
  console.log(`  page:          ${pc.cyan(pagePath)}`)
  console.log(
    `  scores:        ${overview.scores.length} total · ${publishableScores.length} with signals`
  )
  console.log()

  if (dryRun) {
    console.log(pc.yellow("Dry run — exiting without writing."))
    return
  }

  // ── Overview ──
  copyFileSync(overviewSrc, overviewDest)
  console.log(pc.green(`✓ Wrote overview → ${overviewDest}`))

  // ── Per-model detail ──
  if (!skipDetail) {
    mkdirSync(detailDir, { recursive: true })
    const runs = indexBy(readJsonDir<ModelRun>(join(runDir, "runs")))
    const evals = indexBy(readJsonDir<ModelEvaluation>(join(runDir, "evals")))
    for (const modelScore of publishableScores) {
      const detail = buildModelDetail({
        modelScore,
        meta: overview.run,
        date,
        runs,
        evals,
      })
      const path = join(detailDir, modelSlugToFilename(modelScore.model))
      writeFileSync(path, JSON.stringify(detail, null, 2))
    }
    console.log(
      pc.green(
        `✓ Wrote ${publishableScores.length} per-model detail files → ${detailDir}/`
      )
    )
  } else {
    console.log(pc.dim(`  Skipped per-model detail (--no-detail)`))
  }

  // ── Page constant ──
  const page = readFileSync(pagePath, "utf-8")
  const re = /const\s+CURRENT_BENCHMARK_FILE\s*=\s*"[^"]+";/
  if (!re.test(page)) {
    console.error(
      pc.red(`Could not find CURRENT_BENCHMARK_FILE assignment in page.tsx`)
    )
    process.exit(1)
  }
  const updated = page.replace(
    re,
    `const CURRENT_BENCHMARK_FILE = "${date}.json";`
  )
  if (updated === page) {
    console.log(pc.dim(`  CURRENT_BENCHMARK_FILE already points to ${date}.json`))
  } else {
    writeFileSync(pagePath, updated, "utf-8")
    console.log(
      pc.green(`✓ Updated CURRENT_BENCHMARK_FILE = "${date}.json" in page.tsx`)
    )
  }

  console.log()
  console.log(pc.bold("Next:"))
  console.log(`  cd ${dest}`)
  console.log(
    "  git diff public/benchmark src/app/\\(public\\)/benchmark/page.tsx"
  )
  console.log(`  git add -A && git commit -m "benchmark: publish ${date}"`)
}

main()
