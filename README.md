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

Alongside the four axes, a separate probe estimates each model's **[knowledge cutoff](#knowledge-cutoff)** — deliberately *not* folded into the composite, because it's a property of the model, not a quality judgement.

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

## Knowledge cutoff

Currency measures how recent a model's *cited evidence* is. Cutoff measures how recent its *world model* is. A model whose knowledge stops fourteen months ago can't produce a current signal of change no matter how well it writes — so the benchmark measures it, and reports it next to the leaderboard rather than inside it.

The method is adapted from Shrivu Shankar's [Exploring Claude/GPT knowledge cutoffs](https://blog.sshh.io/p/exploring-claudegpt-knowledge-cutoffs). Three probes per model:

| Probe | What it asks | What it gives you |
|---|---|---|
| **Quiz** | 8-way multiple choice: which of these real events happened in *this* month? | Accuracy drops from a plateau to chance past the cutoff. The month of the drop is the estimate. |
| **Self-report** | "What month is it?" / "When does your training data end?" × 5 phrasings | What the model *believes*, and how much that belief moves with the phrasing. |
| **Identity** | "What model are you?" × 5 phrasings | Doesn't date anything alone, but a model that thinks it's its own predecessor tells you what it was trained on. |

### Every wrong answer is a real event

This is the part that took three attempts to get right, and it's the part to preserve if you change anything else.

A quiz item leaks whenever an option can be ruled out **without knowing the month**. Fabricated wrong answers always leak, however carefully they're written:

| Wrong answers are… | gpt-4.1-mini scores on events ~14 months past its cutoff |
|---|---:|
| invented entities ("the *Helioscope* mission") | 40% — it knows which names don't exist |
| real entities, false claims ("the ECB moved to Lisbon") | 72% — it knows which claims are implausible |
| **real events from other months** | **6%** — chance is 12.5% |

So the bank stores **verified real events**, and items are assembled at run time: the true option is this month's event, the other seven are real events from months at least `DEFAULT_MONTH_GAP` (9) away, same domain where possible. Every option really happened; only *when* separates them. That gap is calibrated too — at 2 months even gpt-4.1 couldn't place events it knew (plateau 50%), which flattens the step the estimator looks for; at 9 months the plateau reaches 99% without moving the estimate. The cost is resolution: this can't distinguish cutoffs a month apart, and doesn't claim to.

### Reading the curve

The cutoff is fitted as a **change point** — the split minimising weighted squared error between a "knows it" level and a "doesn't" level — not as a threshold crossing. Both levels are measured; the lower one is usually above chance, and assuming otherwise dates every model years late. Buckets are small, so single-bucket noise would derail a crossing rule; fitting two levels uses every bucket at once, weighted by bucket size.

When the curve can't support an estimate, the runner says why (`no-decline-in-window`, `no-signal`, `too-few-buckets`) instead of guessing.

### Calibration

Against models with published cutoffs, on 146 questions spanning 2023-01 → 2026-07:

| Model | Published | Measured | Error |
|---|---|---|---:|
| `meta-llama/llama-3.3-70b-instruct` | 2023-12 | 2023-11 | −1 mo |
| `openai/gpt-4.1` | 2024-06 | 2024-08 | +2 mo |
| `google/gemini-2.5-flash` | 2025-01 | 2024-08 | −5 mo |

Mean offset −1.3 months, sd 2.9, ordering preserved. Treat a result as ±3 months, and read the ordering rather than the absolute dates.

**One caveat that matters:** the probe conflates knowledge recency with *recall precision*. `gpt-4.1-mini` shares a documented cutoff with `gpt-4.1` but measures 10 months earlier, because it places events it knows far less reliably (plateau 69% vs 99%). A low plateau means a low-confidence estimate — it's reported alongside every result for exactly that reason.

### Build the bank (one-off)

```bash
pnpm cutoff:build --from 2023-01          # ~43 months, 20-40 min
pnpm cutoff:build --top-up 4              # revisit months holding < 4 events
pnpm cutoff:build --no-verify             # half the cost, more noise
pnpm cutoff:build --dry-run
```

A web-grounded model drafts each month's events; a second grounded model from a different vendor confirms each one happened **in that month** before it's banked. The month matters in both directions — a wrongly dated event is a wrong answer key in its own month *and* a secretly-correct wrong answer everywhere else.

It's a long run against grounded models, so it's built to be interrupted: each month is drafted, verified and **written to disk before the next one finishes**, and re-running skips months the bank already has. Ctrl-C at minute 30 keeps 30 minutes of work. Progress lines carry a running count, an ETA, and the amount billed so far.

Output is `data/cutoff-quiz.json`, **committed** — every model must answer the same questions for the numbers to mean anything. `auditBank` reports, after every build, how often the true answer is the longest or shortest option; anything much above chance means the events aren't written to one standard and the bank needs work.

Re-running **appends**: months already in the bank are left byte-identical, so the quarterly "extend the tail" refresh and resuming an interrupted build both cost only what's missing, and previously published curves stay valid.

### Run the probe

```bash
pnpm cutoff                               # latest run's cohort
pnpm cutoff --run <run-id>
pnpm cutoff --preset frontier
pnpm cutoff --gap 12                      # wider gap: easier questions, coarser resolution
pnpm cutoff --per-month 3 --no-identity   # cheaper
```

By default it probes exactly the cohort of an existing benchmark run, so cutoff rows line up 1:1 with leaderboard rows. Results land in `results/<run-id>/cutoff.json` (plus one file per model under `cutoff/`, reused on re-runs unless you pass `--refresh`). `bench:publish` picks the report up automatically.

**Cost:** one short call per question per model. Measured: $0.02 for `gpt-4.1-mini` and $0.11 for `gpt-4.1` over 146 questions.

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
3. Copies `results/<run>/cutoff.json` → `<date>-cutoff.json`, when the run has one (skip with `--no-cutoff`)
4. Rewrites `CURRENT_BENCHMARK_FILE` in the consumer's page so the new run goes live on next deploy

Override the target with `--dest /path/to/some/other/repo` if you're publishing elsewhere.

---

## Known limitations

Stated up front because the methodology is opinionated:

- **No accepted market equivalent.** The weights and rubric are ours, derived from Signals' product purpose (foresight → substance > style > recency ≈ breadth). Per-axis sub-scores ship raw so consumers can re-weight.
- **Judges have biases.** Same-vendor models can mildly self-favor. We use different vendors for verifier + specificity, and the judges-used are recorded in every leaderboard.
- **Frozen briefs can be gamed.** Once public, briefs could in principle be tuned to. Versioned via `BRIEFS_VERSION` — cross-version comparisons aren't valid.
- **The `future` verdict is judgement-heavy.** Forward-looking signals can't be web-verified. Dedicated bucket scored mid-range relies on judge plausibility call.
- **Cutoff estimates are curve-fits, not facts.** The quiz bank is model-drafted (and model-verified); a wrong "true" answer or a distractor that's secretly real adds noise. The estimate is a midpoint with a bracket, and it's reported as null rather than guessed when the curve doesn't decline inside the window.
- **Maturation needs volume.** A single run is one data point. Confidence comes from many dated runs across many judges over time.

---

## Architecture (1-pager)

```
src/
├── cli.ts             # run | resume | report | cutoff | list subcommands
├── publish.ts         # bench:publish — copies to a consumer repo
├── briefs.ts          # 12 frozen industry briefs
├── models.ts          # OpenRouter slugs + tier metadata
├── presets.ts         # named cohorts (top25, frontier, smoke)
├── generate.ts        # phase 1 — model produces signals
├── evaluate.ts        # phase 2 — judges score each signal
├── score.ts           # phase 3 — composite + coverage
├── cache.ts           # exact + embedding-based semantic cache
├── cutoff.ts          # knowledge-cutoff probes + curve estimator
├── cutoff-quiz.ts     # quiz-bank types, loader, validator, month math
├── build-quiz.ts      # cutoff:build — drafts + verifies the quiz bank
├── openrouter.ts      # thin caller, embeddings, /auth/key probe
├── env.ts             # .env loader (no dotenv dep)
├── report.ts          # markdown leaderboard renderer
└── types.ts
data/                  # committed — the frozen cutoff quiz bank
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
