# signals-benchmark

> **An open leaderboard for the task that matters to a foresight product: generating good "signals of change."**

Plug in one OpenRouter key. Get a ranked, four-axis leaderboard across 25+ frontier models, scored over a frozen suite of multi-sector briefs. Re-runnable when new models ship — add the slug, run with `--into`, publish.

**Status**: alpha. The methodology is opinionated and intentionally open about its limitations — see [Known limitations](#known-limitations). Feedback, model additions, and methodology critiques welcome via [issues](https://github.com/envisioning/signals-benchmark/issues) and PRs.

**Public leaderboard**: [signals-strict consumes this data at /benchmark](https://github.com/envisioning/signals-strict).

---

## What it measures

Each model is run against a frozen suite of **12 briefs** spanning healthcare, fintech, defense, climate, retail, biotech, energy, education, geopolitics, AI infra, mobility, food. Every signal it produces is scored on **four orthogonal axes**:

| Axis | Weight | What it checks | Method |
|---|---:|---|---|
| **Verifiability** | 0.40 | Is the underlying *evidence* claim real? | Web-grounded judge classifies into one of 6 buckets: grounded / speculative / future / indicative / dubious / fabricated. The `future` bucket protects forward-looking foresight from being marked as hallucination. |
| **Specificity** | 0.30 | Named actors? Concrete events? No hype adjectives? | Separate non-grounded judge against an explicit writing rubric — different vendor from the verifier to reduce judge-family bias. |
| **Currency** | 0.15 | How recent is the supporting evidence? | Newest source date from the verifier's annotations, passed through a decay curve. |
| **Coverage** | 0.15 | Breadth across the brief's categories + uniqueness vs. the cohort | Mean of category-balance and unique-share (token-Jaccard < 0.3 vs. every other model's signals on the same brief). |

The composite is a weighted mean. **Per-axis sub-scores are emitted alongside** — if you weight things differently, re-compute from the raw JSON without re-running anything.

---

## Quickstart

Requires **Node 22.6+** (uses `--experimental-strip-types`, no build step).

```bash
pnpm install
cp .env.example .env       # paste your OpenRouter key
```

Get a key at <https://openrouter.ai/keys>. ~$5 of credit is plenty to try things out.

```bash
# Tiny smoke run — 2 cheap models × 1 brief, ~$0.20, ~1 min
pnpm bench --preset smoke --briefs healthcare-regulated-ai

# Frontier-only on one brief (~$5, ~5 min)
pnpm bench --tiers frontier --briefs healthcare-regulated-ai

# Full top-25 cohort × all 12 briefs (~$15–25, ~60 min)
pnpm bench --preset top25
```

Output lands in `results/<run-id>/`:

- `meta.json` — run config + cost
- `runs/<brief>__<model>.json` — raw generations
- `evals/<brief>__<model>.json` — per-signal verdicts + citations
- `leaderboard.md` / `leaderboard.json` — final ranking

---

## Common workflows

### Add a new model to an existing run (cheap!)

When a new model ships:

```bash
pnpm bench --models newprovider/new-model --into <existing-run-id>
```

Reuses every cached run/eval from the existing leaderboard, only generates + judges the new model. Typical cost: $3–5 (vs. $15–25 for a fresh full run).

### Resume an interrupted run

Killed phase 2? Switch judges mid-run? Use `bench:resume`:

```bash
pnpm bench:resume --run <id> \
  --judge google/gemini-2.5-flash:online \
  --spec-judge google/gemini-2.5-flash
```

Skips already-completed (model × brief) pairs. Picks up where it left off.

### Re-render after tuning the composite

If you change the weights in `src/score.ts`, re-score from existing evals — no API calls:

```bash
pnpm bench:report --run <id>
```

### Inspect the catalog

```bash
pnpm bench:list
```

Shows all 12 briefs + every model the runner knows about.

---

## Web viewer (optional, local)

A small Next.js app under `web/` renders an interactive leaderboard locally — sortable axes, per-brief drill-down, per-signal verdicts + citations. Useful while iterating.

```bash
cd web && npm install && npm run dev      # http://localhost:3030
```

Reads from `../results/` directly. Zero API calls of its own. Public consumers (e.g. signals-strict) generally consume the published JSON instead.

---

## Cost discipline

The dominant cost is the **web-grounded verifier**. Empirical pricing across providers (per call):

| Verifier | $/call | Notes |
|---|---:|---|
| `openai/gpt-5.4:online` | ~$0.040 | Most expensive; highest quality |
| `google/gemini-2.5-pro:online` | ~$0.015 | |
| `google/gemini-2.5-flash:online` | ~$0.005 | **Default**; reliable JSON, good cost/quality |
| `perplexity/sonar-pro` | ~$0.008 | Web-grounded by design |
| `perplexity/sonar` | ~$0.003 | Cheapest, smaller model |

Each (model × brief) pair runs ~16 signals × 2 judge calls. **Estimate:** top-25 × 12 briefs with Gemini Flash judges ≈ **$15–25 actual billed**. Same run with gpt-5.4:online verifier would be 4× more.

The runner prints **`billed-so-far: $X.XX`** on every progress line — read from OpenRouter's `/auth/key` usage delta, so it matches your dashboard exactly. Trust that number over the per-call `usage.cost` sums.

---

## Publishing results

To ship a run to a public site (e.g. the signals-strict `/benchmark` page):

```bash
pnpm bench:publish                  # latest run, today's date
pnpm bench:publish --dry-run        # see what it would do
pnpm bench:publish --date 2026-08-15 # custom date for the filename
```

The publisher:
1. Copies `results/<run>/leaderboard.json` → `../signals-strict/public/benchmark/<date>.json`
2. Writes per-model detail files (signals + verdicts + citations) → `../signals-strict/public/benchmark/<date>/<vendor>_<model>.json`
3. Rewrites `CURRENT_BENCHMARK_FILE` in the consumer's page so the new run goes live on next deploy

Override the target with `--dest /path/to/some/other/repo` if you're publishing elsewhere.

---

## Known limitations

Stated up front because the methodology is opinionated:

- **No accepted market equivalent.** The weights and rubric are ours, derived from Signals' product purpose (foresight → substance > style > recency ≈ breadth). Per-axis sub-scores ship raw so consumers can re-weight.
- **Judges have biases.** Same-vendor models can mildly self-favor. We use different vendors for verifier + specificity, and the judges-used are recorded in every leaderboard.
- **Frozen briefs can be gamed.** Once public, briefs could in principle be tuned to. Versioned via `BRIEFS_VERSION` — cross-version comparisons aren't valid.
- **The `future` verdict is judgement-heavy.** Forward-looking signals can't be web-verified. Dedicated bucket scored mid-range relies on judge plausibility call.
- **Maturation needs volume.** A single run is one data point. Confidence comes from many dated runs across many judges over time.

---

## Architecture (1-pager)

```
src/
├── cli.ts             # run | resume | report | list subcommands
├── publish.ts         # bench:publish — copies to a consumer repo
├── briefs.ts          # 12 frozen industry briefs
├── models.ts          # OpenRouter slugs + tier metadata
├── presets.ts         # named cohorts (top25, frontier, smoke)
├── generate.ts        # phase 1 — model produces signals
├── evaluate.ts        # phase 2 — judges score each signal
├── score.ts           # phase 3 — composite + coverage
├── cache.ts           # exact + embedding-based semantic cache
├── openrouter.ts      # thin caller, embeddings, /auth/key probe
├── env.ts             # .env loader (no dotenv dep)
├── report.ts          # markdown leaderboard renderer
└── types.ts
results/               # gitignored — raw per-run outputs
cache/                 # gitignored — semantic eval cache
web/                   # optional local Next.js viewer
```

Two clean dependencies: `p-map` (concurrency) and `picocolors` (CLI output). Everything else is standard Node 22.

---

## Contributing

Adding a new model, proposing a new brief, or critiquing the methodology — see **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

Briefly: the most common contribution is dropping a new model slug into `src/models.ts` and `src/presets.ts`, then running `pnpm bench --into <latest-run>` to add it to the existing leaderboard cheaply.

---

## License

[MIT](./LICENSE) — © Envisioning. Use, fork, re-rubric, run on your own briefs. If you publish a derivative leaderboard we'd appreciate a citation back to this repo, but it's not required.
