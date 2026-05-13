# Contributing

Thanks for considering a contribution. This repo is small and the surface is well-defined — most contributions fit one of three buckets:

1. **Add a new model** (most common — when a new flagship ships)
2. **Propose a new brief or category** (rare — briefs are frozen between versions)
3. **Critique the methodology** (high-leverage — open an issue, we'll engage)

If you're unsure, [open an issue](https://github.com/envisioning/signals-benchmark/issues/new) before writing code.

## Setup

```bash
git clone https://github.com/envisioning/signals-benchmark
cd signals-benchmark
pnpm install
cp .env.example .env       # paste your OpenRouter key
pnpm bench:list            # sanity-check the catalog renders
```

Requires Node **22.6+** (uses `--experimental-strip-types`, no build step). The runner has two runtime deps total (`p-map`, `picocolors`) — intentional, keeps cold-install fast.

## Adding a new model

1. Look up the model's OpenRouter slug. Quickest way:
   ```bash
   source .env && curl -s https://openrouter.ai/api/v1/models \
     -H "Authorization: Bearer $OPENROUTER_API_KEY" \
     | jq '.data[] | select(.id | contains("<vendor>")) | .id'
   ```
2. Add it to **`src/models.ts`** with `vendor`, `tier` (`frontier` / `mid` / `small` / `open`).
3. If it should be part of the public top-25 cohort, also add it to **`src/presets.ts`**.
4. Run it against the latest leaderboard:
   ```bash
   pnpm bench --models <vendor>/<slug> --into <latest-run-id>
   ```
   Typical cost: $3–5 (12 briefs × ~$0.30 per pair with Gemini Flash judges).
5. Inspect `results/<run>/runs/...` and `evals/...` — the model should produce all 16 signals per brief with reasonable verdicts. Failures show up in the per-run JSON.
6. If you have publish access (Envisioning team): `pnpm bench:publish` to push to the consumer site.
7. Otherwise: open a PR with just the `models.ts` / `presets.ts` edit + your local screenshot of the new run's output.

### What if the model fails to follow the structured-output instruction?

Some smaller models can't produce the strict-JSON schema we ask for. You'll see "Parse error" or "0 signals" in the run output. Options:
- Try with `maxTokens: 16000` (already auto-applied for reasoning models)
- Mark it `disabled: true` in `src/models.ts` with a note explaining the failure mode
- Leave it in — failed models appear at the bottom of the leaderboard, which is honest information about model quality

## Adding or changing a brief

Briefs are **frozen** to keep cross-run comparisons valid. We bump `BRIEFS_VERSION` when the set materially changes (anything that affects the rubric or the topics).

To propose:
1. Open an issue describing the brief — topic, audience, 4 categories, why it adds signal over the existing 12.
2. If accepted, the PR adds to `src/briefs.ts` and bumps `BRIEFS_VERSION` (e.g. `"2026-05-v1"` → `"2026-08-v1"`).
3. All existing leaderboards must be regenerated against the new version. Old dated runs stay reachable at their permalinks but get a "previous brief version" tag.

If you're tempted to just edit a brief's wording inline — don't. Open an issue first so we can decide whether it's a version bump or a non-meaningful edit.

## Critiquing the methodology

These are the highest-value contributions. We're explicit about [known limitations](./README.md#known-limitations) but there are real arguments to be had:

- **Are the composite weights right?** (Currently 0.40 / 0.30 / 0.15 / 0.15)
- **Should the `future` verdict be re-thought?**
- **Are 12 briefs enough? Too many?**
- **Judge-model selection** — the cost-quality tradeoff
- **Self-judgment** — Google models judging Google models, etc.

Open an issue with your argument. We'll engage. Even if we disagree, the public-page methodology card should reflect the live debate.

## Code conventions

- **TypeScript strict.** No `any` without a good reason and a comment.
- **Conventional commits.** `feat(scope): description`, `fix(scope): description`, etc. Lowercase.
- **One module per concern.** Don't bloat `cli.ts` — generation, evaluation, scoring, report should each stay in their own file.
- **Comment the "why," not the "what."** The runner has tricky moments (reasoning-model token budgets, judge-model contamination, cache-scope boundaries) — explain them inline.
- **Honest cost reporting.** Anything that prints "$X.XX" must match the OpenRouter dashboard. The `/auth/key` delta is the source of truth.
- **No telemetry, no analytics.** This tool runs on a contributor's machine with their key. No call-home.

## Type-checking & tests

```bash
pnpm typecheck       # tsc --noEmit, expected to pass clean
```

There are no unit tests yet — the runner is largely glue code over OpenRouter calls, and the right kind of test is full-pipeline runs against known fixtures. PRs that add a small fixture suite (mocked OpenRouter responses) are very welcome.

## Pull request checklist

Before opening a PR:

- [ ] `pnpm typecheck` passes
- [ ] If you added a model: `pnpm bench --models <slug> --briefs healthcare-regulated-ai` succeeds end-to-end
- [ ] If you changed scoring/judging: re-run the full top-25 × 1 brief and include before/after leaderboard.md in the PR
- [ ] Commit messages follow conventional commits
- [ ] No secrets in the diff (`.env` is gitignored; double-check anyway)
- [ ] Updated README if you added a flag, command, or preset

## Code of conduct

We follow the [Contributor Covenant](./CODE_OF_CONDUCT.md). Be kind, be specific, assume good faith.

## License

By contributing you agree your work will be released under the project's [MIT license](./LICENSE).
