/**
 * CLI entrypoint.
 *
 * Subcommands:
 *   run     — execute the full benchmark matrix and write a leaderboard.
 *   report  — re-render the leaderboard from an existing run's JSON
 *             (useful when you tweak weights in score.ts).
 *   list    — print available briefs and models, then exit.
 *
 * Flags (run):
 *   --models   a,b,c      comma-separated OpenRouter slugs (overrides curated list)
 *   --vendors  OpenAI,...
 *   --tiers    frontier,mid,small,open
 *   --briefs   id1,id2    subset of briefs
 *   --sectors  Healthcare,...
 *   --judge    openai/gpt-5.4:online
 *   --spec-judge anthropic/claude-sonnet-4.6
 *   --concurrency-gen  4
 *   --concurrency-eval 4
 *   --dry-run             print the plan and exit without spending tokens
 *
 * Output lives under ./results/<run-id>/ — one JSON file per (brief,model)
 * plus a final leaderboard.md + leaderboard.json.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs"
import { resolve, join } from "node:path"
import pc from "picocolors"
import { loadEnv, requireKey, getVercelKey } from "./env.ts"
import {
  filterModels,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_SPECIFICITY_JUDGE,
  MODELS,
} from "./models.ts"
import { BRIEFS, BRIEFS_VERSION, getBriefs } from "./briefs.ts"
import { getPreset, listPresets } from "./presets.ts"
import { generateForBrief } from "./generate.ts"
import { evaluateRun, makeCaches } from "./evaluate.ts"
import { getKeyUsage } from "./openrouter.ts"
import { scoreModels } from "./score.ts"
import { writeReport, renderConsole } from "./report.ts"
import type {
  BenchmarkRun,
  ModelEvaluation,
  ModelRun,
} from "./types.ts"

// --- arg parsing (no dependency on yargs/commander) ------------------------

type Args = Record<string, string | boolean>
function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? "run"
  const args: Args = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return { cmd, args }
}
const list = (v: string | boolean | undefined): string[] | undefined => {
  if (typeof v !== "string") return undefined
  return v.split(",").map((s) => s.trim()).filter(Boolean)
}

// --- subcommands -----------------------------------------------------------

async function cmdRun(args: Args) {
  loadEnv()
  const apiKey = requireKey()

  const judgeModel = (args.judge as string) || DEFAULT_JUDGE_MODEL
  const specJudge = (args["spec-judge"] as string) || DEFAULT_SPECIFICITY_JUDGE
  const concurrencyGen = Number(args["concurrency-gen"] ?? process.env.GENERATE_CONCURRENCY ?? 4)
  const concurrencyEval = Number(args["concurrency-eval"] ?? process.env.EVAL_CONCURRENCY ?? 4)

  const briefs = getBriefs({
    ids: list(args.briefs),
    sectors: list(args.sectors),
  })
  // Resolve model cohort: --models > --preset > --vendors/--tiers > all enabled.
  let modelIdsOverride = list(args.models)
  if (!modelIdsOverride && typeof args.preset === "string") {
    const preset = getPreset(args.preset)
    if (!preset) {
      console.error(
        pc.red(`Unknown preset: ${args.preset}. Available: ${listPresets().join(", ")}`)
      )
      process.exit(1)
    }
    modelIdsOverride = preset
  }
  const models = filterModels({
    ids: modelIdsOverride,
    vendors: list(args.vendors),
    tiers: list(args.tiers) as any,
  })

  // If a preset asked for slugs that aren't in models.ts (yet), fall back
  // to building stub entries so the run still includes them. They appear
  // as `tier: mid` for filtering purposes but the slug is what matters.
  if (modelIdsOverride) {
    const known = new Set(models.map((m) => m.id))
    for (const id of modelIdsOverride) {
      if (!known.has(id)) {
        models.push({ id, vendor: "Unknown", tier: "mid" })
      }
    }
  }

  // Resolve the Vercel AI Gateway key up front if the cohort needs it,
  // so we fail before spending anything on OpenRouter phase-1 calls.
  const needsVercel = models.some((m) => m.provider === "vercel")
  const vercelKey = needsVercel ? getVercelKey() : null
  if (needsVercel && !vercelKey) {
    const vercelModels = models.filter((m) => m.provider === "vercel").map((m) => m.id)
    console.error(
      pc.red(
        `Cohort includes Vercel-only model(s): ${vercelModels.join(", ")}.\n` +
          "Set VERCEL_AI_GATEWAY_KEY in .env (the OPENROUTER_API_KEY does not work against Vercel),\n" +
          "or exclude them, e.g. --vendors OpenAI,Anthropic or an explicit --models list."
      )
    )
    process.exit(1)
  }

  if (briefs.length === 0) {
    console.error(pc.red("No briefs selected."))
    process.exit(1)
  }
  if (models.length === 0) {
    console.error(pc.red("No models selected."))
    process.exit(1)
  }

  /**
   * --into <run-id> extends an existing run rather than starting a new
   * one. Useful when a new model ships and you want it scored on the
   * same briefs with the same judges as the rest of the cohort, without
   * re-running everything ($$$). Pairs that already have output files
   * are skipped; coverage is re-computed across the full updated set
   * so existing models' rankings reflect the new neighborhood.
   */
  const intoExistingRun = typeof args.into === "string"
  const runId = intoExistingRun
    ? (args.into as string)
    : new Date().toISOString().replace(/[:.]/g, "-")
  const runDir = resolve("results", runId)

  let existingMeta: BenchmarkRun | undefined
  if (intoExistingRun) {
    const metaPath = join(runDir, "meta.json")
    if (!existsSync(metaPath)) {
      console.error(pc.red(`No meta.json at ${metaPath} — --into target doesn't exist.`))
      process.exit(1)
    }
    existingMeta = JSON.parse(readFileSync(metaPath, "utf-8")) as BenchmarkRun
    // Reuse the judges from the existing run, so new scores are
    // comparable with what's already there. CLI flags ignored.
    if (
      ((args.judge && args.judge !== existingMeta.judge_model) ||
        (args["spec-judge"] &&
          args["spec-judge"] !== existingMeta.specificity_judge))
    ) {
      console.error(
        pc.red(
          `Cannot override --judge/--spec-judge with --into; would mix incompatible scores. ` +
            `Existing run uses ${existingMeta.judge_model} / ${existingMeta.specificity_judge}.`
        )
      )
      process.exit(1)
    }
  }

  mkdirSync(join(runDir, "runs"), { recursive: true })
  mkdirSync(join(runDir, "evals"), { recursive: true })

  // If extending an existing run, reuse its judges; otherwise use CLI.
  const effectiveJudge = existingMeta?.judge_model ?? judgeModel
  const effectiveSpec = existingMeta?.specificity_judge ?? specJudge

  const meta: BenchmarkRun = existingMeta
    ? {
        ...existingMeta,
        // Merge in any new models so meta.models reflects the full set.
        models: Array.from(
          new Set([...existingMeta.models, ...models.map((m) => m.id)])
        ),
      }
    : {
        run_id: runId,
        started_at: new Date().toISOString(),
        judge_model: judgeModel,
        specificity_judge: specJudge,
        briefs_version: BRIEFS_VERSION,
        models: models.map((m) => m.id),
        brief_ids: briefs.map((b) => b.id),
      }
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2))

  console.log(pc.bold(pc.cyan(`\nSignals Benchmark — ${runId}`)))
  console.log(
    pc.dim(
      `  ${briefs.length} briefs · ${models.length} models · judge: ${judgeModel} · spec: ${specJudge}`
    )
  )
  console.log(pc.dim(`  results → ${runDir}\n`))

  if (args["dry-run"]) {
    console.log(pc.yellow("Dry run — exiting before any API calls."))
    return
  }

  // Snapshot the API key's lifetime usage so we can report the actual
  // OR-billed cost for this run (which includes web-search surcharges
  // not always reflected in per-call usage.cost).
  const usageAtStart = await getKeyUsage(apiKey)

  const { default: pMap } = await import("p-map")

  /**
   * Re-snapshot /auth/key to get an up-to-date lifetime usage figure.
   * Diffed against `usageAtStart` to give the user a running "billed
   * so far" tally that matches the OpenRouter dashboard exactly.
   * Cheap (small GET, no model token cost). Best-effort — if it fails
   * we just skip that one display.
   */
  async function billedSoFar(): Promise<string> {
    const now = await getKeyUsage(apiKey)
    if (now === null || usageAtStart === null) return ""
    const delta = Math.max(0, now - usageAtStart)
    return pc.dim(` · billed-so-far: $${delta.toFixed(4)}`)
  }

  // ── Phase 1: generation ──
  console.log(pc.bold("Phase 1: generation"))
  const generationJobs: { briefIdx: number; modelIdx: number }[] = []
  for (let bi = 0; bi < briefs.length; bi++) {
    for (let mi = 0; mi < models.length; mi++) {
      generationJobs.push({ briefIdx: bi, modelIdx: mi })
    }
  }

  const runs: ModelRun[] = []
  let done = 0
  let skipped = 0
  await pMap(
    generationJobs,
    async ({ briefIdx, modelIdx }) => {
      const brief = briefs[briefIdx]
      const model = models[modelIdx]
      const cachedPath = join(
        runDir,
        "runs",
        `${brief.id}__${model.id.replace(/\//g, "_")}.json`
      )
      // --into reuse: if this pair already has a runs/ file from a
      // prior invocation, load it from disk instead of regenerating.
      // Skips both API cost AND token spend.
      if (intoExistingRun && existsSync(cachedPath)) {
        const cached = JSON.parse(readFileSync(cachedPath, "utf-8")) as ModelRun
        runs.push(cached)
        skipped++
        done++
        return
      }
      const provider = model.provider ?? "openrouter"
      const run = await generateForBrief({
        apiKey: provider === "vercel" ? vercelKey! : apiKey,
        brief,
        model: model.id,
        provider,
      })
      runs.push(run)
      done++
      const status = run.error
        ? pc.red(`✗ ${run.error.message.slice(0, 60)}`)
        : pc.green(`✓ ${run.signals.length} signals · ${(run.duration_ms / 1000).toFixed(1)}s`)
      console.log(
        `  [${done}/${generationJobs.length}] ${pc.cyan(model.id)} × ${brief.id} — ${status}${await billedSoFar()}`
      )
      writeFileSync(
        join(runDir, "runs", `${brief.id}__${model.id.replace(/\//g, "_")}.json`),
        JSON.stringify(run, null, 2)
      )
    },
    { concurrency: concurrencyGen }
  )
  if (intoExistingRun && skipped > 0) {
    console.log(pc.dim(`  (${skipped} pair${skipped === 1 ? "" : "s"} reused from existing run)`))
  }

  // Snapshot after phase 1 so we can report a phase-by-phase tally.
  const usageAfterPhase1 = await getKeyUsage(apiKey)
  if (usageAtStart !== null && usageAfterPhase1 !== null) {
    const phase1Cost = Math.max(0, usageAfterPhase1 - usageAtStart)
    console.log(pc.dim(`  → phase 1 billed: $${phase1Cost.toFixed(4)}`))
  }

  // ── Phase 2: evaluation ──
  const cachesEnabled = !args["no-cache"]
  const { verifierCache, specCache } = makeCaches(cachesEnabled)
  console.log(
    pc.bold("\nPhase 2: evaluation") +
      pc.dim(cachesEnabled ? "  (cache enabled)" : "  (cache disabled)")
  )
  const allEvalCandidates = runs.filter((r) => !r.error && r.signals.length > 0)
  const evaluations: ModelEvaluation[] = []
  let totalJudgeCost = 0
  let evalSkipped = 0

  // --into reuse: load existing eval files (don't re-judge). They were
  // produced with the same judges so the scores are comparable.
  const evalJobs = allEvalCandidates.filter((run) => {
    const evalPath = join(
      runDir,
      "evals",
      `${run.brief_id}__${run.model.replace(/\//g, "_")}.json`
    )
    if (intoExistingRun && existsSync(evalPath)) {
      try {
        evaluations.push(
          JSON.parse(readFileSync(evalPath, "utf-8")) as ModelEvaluation
        )
        evalSkipped++
        return false
      } catch {
        /* if file is corrupt, re-evaluate */
      }
    }
    return true
  })

  if (intoExistingRun && evalSkipped > 0) {
    console.log(
      pc.dim(`  (${evalSkipped} eval${evalSkipped === 1 ? "" : "s"} reused from existing run)`)
    )
  }

  done = 0
  await pMap(
    evalJobs,
    async (run) => {
      const brief = briefs.find((b) => b.id === run.brief_id)!
      const ev = await evaluateRun({
        apiKey,
        brief,
        model: run.model,
        signals: run.signals,
        judgeModel: effectiveJudge,
        specificityJudge: effectiveSpec,
        verifierCache,
        specCache,
        concurrency: concurrencyEval,
      })
      evaluations.push(ev)
      totalJudgeCost += ev.judge_cost_usd ?? 0
      done++
      const avgV = Math.round(
        ev.evaluations.reduce((a, e) => a + e.verifiability.score, 0) /
          Math.max(1, ev.evaluations.length)
      )
      const hits = ev.cache_hits
        ? pc.dim(` · cache v${ev.cache_hits.verifier}/s${ev.cache_hits.specificity}`)
        : ""
      const cost = ev.judge_cost_usd
        ? pc.dim(` · $${ev.judge_cost_usd.toFixed(4)}`)
        : ""
      console.log(
        `  [${done}/${evalJobs.length}] ${pc.cyan(run.model)} × ${run.brief_id} — verif ${avgV}${hits}${cost}${await billedSoFar()}`
      )
      writeFileSync(
        join(runDir, "evals", `${run.brief_id}__${run.model.replace(/\//g, "_")}.json`),
        JSON.stringify(ev, null, 2)
      )
    },
    // 4 (model,brief) pairs in flight, each with concurrencyEval signals
    // concurrent → ~16 simultaneous judge calls. Comfortably below
    // OpenRouter's default per-key limits. Bump higher only if you
    // start seeing 429s in the run.
    { concurrency: 4 }
  )

  if (cachesEnabled) {
    const vs = verifierCache.stats()
    const ss = specCache.stats()
    const tot = (s: typeof vs) => s.exact_hits + s.semantic_hits + s.misses
    console.log(
      pc.dim(
        `  cache → verifier: ${vs.exact_hits} exact + ${vs.semantic_hits} semantic / ${tot(vs)} (${vs.hit_rate}%) · specificity: ${ss.exact_hits} exact + ${ss.semantic_hits} semantic / ${tot(ss)} (${ss.hit_rate}%)`
      )
    )
  }

  // ── Phase 3: score + report ──
  console.log(pc.bold("\nPhase 3: scoring"))

  // In --into mode, `runs` and `evaluations` so far only contain the
  // pairs touched by THIS invocation. To score the full cohort
  // correctly (coverage scores need every model, not just the new one),
  // re-scan the run dir and load everything from disk. The scan is
  // idempotent — pairs already in memory get deduplicated by file name.
  let allRuns = runs
  let allEvaluations = evaluations
  if (intoExistingRun) {
    const diskRuns = readJsonDir<ModelRun>(join(runDir, "runs"))
    const diskEvals = readJsonDir<ModelEvaluation>(join(runDir, "evals"))
    const haveRun = new Set(runs.map((r) => `${r.brief_id}::${r.model}`))
    const haveEval = new Set(
      evaluations.map((e) => `${e.brief_id}::${e.model}`)
    )
    allRuns = [
      ...runs,
      ...diskRuns.filter((r) => !haveRun.has(`${r.brief_id}::${r.model}`)),
    ]
    allEvaluations = [
      ...evaluations,
      ...diskEvals.filter(
        (e) => !haveEval.has(`${e.brief_id}::${e.model}`)
      ),
    ]
    console.log(
      pc.dim(
        `  scoring ${allRuns.length} runs + ${allEvaluations.length} evals (incl. existing run data)`
      )
    )
  }
  // Coverage (and thus composite) is computed across the brief set handed
  // to scoreModels. Generation/eval above are correctly scoped to the
  // `--briefs` subset, but scoring must see the FULL cohort — otherwise a
  // 1-brief `--into` run collapses coverage for every model in the
  // re-rendered leaderboard. In --into mode the full set lives in
  // meta.brief_ids (carried over from the existing run); reconstruct it the
  // same way cmdReport does.
  const scoringBriefs = intoExistingRun
    ? BRIEFS.filter((b) => meta.brief_ids.includes(b.id))
    : briefs
  const scores = scoreModels({
    briefs: scoringBriefs,
    runs: allRuns,
    evaluations: allEvaluations,
  })

  const totalGenCost = allRuns.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0)

  // Snapshot key usage again — diff against start gives the actual
  // billed amount (more reliable than per-call usage.cost summing).
  const usageAtEnd = await getKeyUsage(apiKey)
  const billedActual =
    usageAtStart !== null && usageAtEnd !== null
      ? Math.max(0, usageAtEnd - usageAtStart)
      : null

  // For --into runs, accumulate costs onto whatever the existing meta
  // already had (so the final total reflects everything spent on this
  // benchmark, not just the latest invocation).
  const prevJudgeCost = intoExistingRun ? (existingMeta?.judge_cost_usd ?? 0) : 0
  const prevBilled = intoExistingRun ? (existingMeta?.billed_actual_usd ?? 0) : 0
  const finalMeta: BenchmarkRun = {
    ...meta,
    finished_at: new Date().toISOString(),
    total_cost_usd: totalGenCost, // already includes reused runs' costs
    judge_cost_usd: prevJudgeCost + totalJudgeCost,
    ...(billedActual !== null
      ? { billed_actual_usd: prevBilled + billedActual }
      : {}),
  }
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(finalMeta, null, 2))

  const { mdPath, jsonPath } = writeReport({ run: finalMeta, scores, outDir: runDir })

  console.log(renderConsole({ run: finalMeta, scores }))
  console.log(pc.green(`✓ Wrote ${mdPath}`))
  console.log(pc.green(`✓ Wrote ${jsonPath}`))
  const fmt = (n: number) => `$${n.toFixed(4)}`
  const reportedTotal = totalGenCost + totalJudgeCost
  console.log(
    pc.dim(
      `  Reported (sum of per-call usage.cost) — gen: ${fmt(totalGenCost)} · judge: ${fmt(totalJudgeCost)} · total: ${fmt(reportedTotal)}`
    )
  )
  if (billedActual !== null) {
    const delta = billedActual - reportedTotal
    const deltaStr =
      delta >= 0.001
        ? pc.yellow(` (+${fmt(delta)} unreported — likely web-search surcharge)`)
        : ""
    console.log(
      pc.bold(`  Actually billed by OpenRouter: ${fmt(billedActual)}${deltaStr}`)
    )
  } else {
    console.log(
      pc.dim(`  (Could not fetch /auth/key — check OPENROUTER_API_KEY scopes)`)
    )
  }
}

/**
 * Resume an existing run by re-doing phase 2+3 on the cached phase 1
 * outputs. Useful when:
 *   - Phase 2 was killed before completion
 *   - You want to evaluate the same signals with different judges
 *
 * Re-runs the FULL phase 2 (deletes any partial evals first) to avoid
 * mixing verdicts from different judges. The runs/ directory is left
 * untouched — that's the generated signals which don't depend on judge.
 */
async function cmdResume(args: Args) {
  loadEnv()
  const apiKey = requireKey()
  const runId = (args.run as string) || pickLatestRunId()
  if (!runId) {
    console.error(pc.red("No --run id given and no results/ dir found."))
    process.exit(1)
  }
  const runDir = resolve("results", runId)
  const metaPath = join(runDir, "meta.json")
  if (!existsSync(metaPath)) {
    console.error(pc.red(`meta.json missing at ${metaPath}`))
    process.exit(1)
  }
  const meta: BenchmarkRun = JSON.parse(readFileSync(metaPath, "utf-8"))

  const newJudge = (args.judge as string) || DEFAULT_JUDGE_MODEL
  const newSpec = (args["spec-judge"] as string) || DEFAULT_SPECIFICITY_JUDGE
  const concurrencyEval = Number(args["concurrency-eval"] ?? process.env.EVAL_CONCURRENCY ?? 4)

  const briefs = BRIEFS.filter((b) => meta.brief_ids.includes(b.id))
  const runs = readJsonDir<ModelRun>(join(runDir, "runs"))
  const evalJobs = runs.filter((r) => !r.error && r.signals.length > 0)

  // Reconstruct phase-1 generation cost from the runs/*.json files so
  // we don't lose it if the prior run was killed before phase 3 (which
  // is where `total_cost_usd` normally gets written to meta).
  const phase1GenCost = runs.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0)

  if (evalJobs.length === 0) {
    console.error(pc.red("No usable runs to evaluate in this dir."))
    process.exit(1)
  }

  console.log(pc.bold(pc.cyan(`\nResuming ${runId}`)))
  console.log(
    pc.dim(
      `  ${evalJobs.length} (model × brief) pairs to evaluate · judge: ${newJudge} · spec: ${newSpec}`
    )
  )

  // Clear any partial evals from the previous attempt — they used the
  // old judge, mixing them with new ones would corrupt the leaderboard.
  const evalsDir = join(runDir, "evals")
  if (existsSync(evalsDir)) {
    const old = readdirSync(evalsDir).filter((f) => f.endsWith(".json"))
    if (old.length > 0) {
      console.log(pc.yellow(`  discarding ${old.length} partial eval(s) from previous attempt`))
      for (const f of old) {
        try {
          unlinkSync(join(evalsDir, f))
        } catch {
          /* ignore */
        }
      }
    }
  }
  mkdirSync(evalsDir, { recursive: true })

  if (args["dry-run"]) {
    console.log(pc.yellow("Dry run — exiting before any API calls."))
    return
  }

  const usageAtStart = await getKeyUsage(apiKey)
  async function billedSoFar(): Promise<string> {
    const now = await getKeyUsage(apiKey)
    if (now === null || usageAtStart === null) return ""
    return pc.dim(` · billed-so-far: $${Math.max(0, now - usageAtStart).toFixed(4)}`)
  }

  const { default: pMap } = await import("p-map")
  const cachesEnabled = !args["no-cache"]
  const { verifierCache, specCache } = makeCaches(cachesEnabled)
  console.log(
    pc.bold("Phase 2: evaluation") +
      pc.dim(cachesEnabled ? "  (cache enabled)" : "  (cache disabled)")
  )
  const evaluations: ModelEvaluation[] = []
  let totalJudgeCost = 0
  let done = 0
  await pMap(
    evalJobs,
    async (run) => {
      const brief = briefs.find((b) => b.id === run.brief_id)!
      const ev = await evaluateRun({
        apiKey,
        brief,
        model: run.model,
        signals: run.signals,
        judgeModel: newJudge,
        specificityJudge: newSpec,
        verifierCache,
        specCache,
        concurrency: concurrencyEval,
      })
      evaluations.push(ev)
      totalJudgeCost += ev.judge_cost_usd ?? 0
      done++
      const avgV = Math.round(
        ev.evaluations.reduce((a, e) => a + e.verifiability.score, 0) /
          Math.max(1, ev.evaluations.length)
      )
      const hits = ev.cache_hits
        ? pc.dim(` · cache v${ev.cache_hits.verifier}/s${ev.cache_hits.specificity}`)
        : ""
      const cost = ev.judge_cost_usd
        ? pc.dim(` · $${ev.judge_cost_usd.toFixed(4)}`)
        : ""
      console.log(
        `  [${done}/${evalJobs.length}] ${pc.cyan(run.model)} × ${run.brief_id} — verif ${avgV}${hits}${cost}${await billedSoFar()}`
      )
      writeFileSync(
        join(evalsDir, `${run.brief_id}__${run.model.replace(/\//g, "_")}.json`),
        JSON.stringify(ev, null, 2)
      )
    },
    { concurrency: 4 }
  )

  if (cachesEnabled) {
    const vs = verifierCache.stats()
    const ss = specCache.stats()
    const tot = (s: typeof vs) => s.exact_hits + s.semantic_hits + s.misses
    console.log(
      pc.dim(
        `  cache → verifier: ${vs.exact_hits} exact + ${vs.semantic_hits} semantic / ${tot(vs)} (${vs.hit_rate}%) · specificity: ${ss.exact_hits} exact + ${ss.semantic_hits} semantic / ${tot(ss)} (${ss.hit_rate}%)`
      )
    )
  }

  // Phase 3: scoring + report.
  console.log(pc.bold("\nPhase 3: scoring"))
  const scores = scoreModels({ briefs, runs, evaluations })
  const usageAtEnd = await getKeyUsage(apiKey)
  const billedActual =
    usageAtStart !== null && usageAtEnd !== null
      ? Math.max(0, usageAtEnd - usageAtStart)
      : null
  // Preserve the original phase-1 generation cost from the prior meta.
  // The ...meta spread keeps `total_cost_usd` if it was set during the
  // initial run; resume only ADDS to billed_actual_usd (which sums
  // generation phase 1 + this resume's eval phase).
  const finalMeta: BenchmarkRun = {
    ...meta,
    judge_model: newJudge,
    specificity_judge: newSpec,
    finished_at: new Date().toISOString(),
    total_cost_usd: meta.total_cost_usd ?? phase1GenCost,
    judge_cost_usd: totalJudgeCost,
    ...(billedActual !== null
      ? { billed_actual_usd: (meta.billed_actual_usd ?? 0) + billedActual }
      : {}),
  }
  writeFileSync(metaPath, JSON.stringify(finalMeta, null, 2))
  const { mdPath, jsonPath } = writeReport({ run: finalMeta, scores, outDir: runDir })
  console.log(renderConsole({ run: finalMeta, scores }))
  console.log(pc.green(`✓ Wrote ${mdPath}`))
  console.log(pc.green(`✓ Wrote ${jsonPath}`))
  if (billedActual !== null) {
    console.log(pc.bold(`  Resume billed: $${billedActual.toFixed(4)}`))
  }
}

async function cmdReport(args: Args) {
  const runId = (args.run as string) || pickLatestRunId()
  if (!runId) {
    console.error(pc.red("No run id given and no results/ directory found."))
    process.exit(1)
  }
  const runDir = resolve("results", runId)
  const metaPath = join(runDir, "meta.json")
  if (!existsSync(metaPath)) {
    console.error(pc.red(`No meta.json at ${metaPath}`))
    process.exit(1)
  }
  const meta: BenchmarkRun = JSON.parse(readFileSync(metaPath, "utf-8"))
  const runs = readJsonDir<ModelRun>(join(runDir, "runs"))
  const evaluations = readJsonDir<ModelEvaluation>(join(runDir, "evals"))
  const briefs = BRIEFS.filter((b) => meta.brief_ids.includes(b.id))
  const scores = scoreModels({ briefs, runs, evaluations })
  const { mdPath, jsonPath } = writeReport({ run: meta, scores, outDir: runDir })
  console.log(renderConsole({ run: meta, scores }))
  console.log(pc.green(`✓ Re-rendered ${mdPath}`))
  console.log(pc.green(`✓ Re-rendered ${jsonPath}`))
}

function pickLatestRunId(): string | undefined {
  const base = resolve("results")
  if (!existsSync(base)) return undefined
  const dirs = readdirSync(base).filter((d) => existsSync(join(base, d, "meta.json")))
  if (dirs.length === 0) return undefined
  dirs.sort()
  return dirs[dirs.length - 1]
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as T)
}

function cmdList() {
  console.log(pc.bold("\nBriefs:"))
  for (const b of BRIEFS) {
    console.log(`  ${pc.cyan(b.id.padEnd(32))} ${pc.dim(b.sector)}  ${b.topic}`)
  }
  console.log(pc.bold(`\nModels (${MODELS.length}):`))
  const byVendor = new Map<string, typeof MODELS>()
  for (const m of MODELS) {
    const arr = byVendor.get(m.vendor) ?? []
    arr.push(m)
    byVendor.set(m.vendor, arr)
  }
  for (const [vendor, list] of byVendor) {
    console.log(`  ${pc.yellow(vendor)}`)
    for (const m of list) {
      const note = m.notes ? pc.dim(` — ${m.notes}`) : ""
      console.log(`    ${pc.cyan(m.id.padEnd(48))} ${m.tier}${note}`)
    }
  }
  console.log()
}

// --- main ------------------------------------------------------------------

const { cmd, args } = parseArgs(process.argv.slice(2))
if (cmd === "run") {
  await cmdRun(args)
} else if (cmd === "resume") {
  await cmdResume(args)
} else if (cmd === "report") {
  await cmdReport(args)
} else if (cmd === "list") {
  cmdList()
} else {
  console.error(`Unknown command: ${cmd}. Try: run | resume | report | list`)
  process.exit(1)
}
