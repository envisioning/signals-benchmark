## Summary

<1-3 sentence description of the change.>

## Type

- [ ] Adding a model
- [ ] Bug fix
- [ ] Methodology change (briefs, weights, judges, score logic)
- [ ] Tooling / docs / DX

## Verified

- [ ] `pnpm typecheck` passes
- [ ] If you added a model: ran `pnpm bench --models <slug> --briefs healthcare-regulated-ai` and got 16 signals end-to-end
- [ ] If you changed scoring/judging: re-ran a small cohort (3–5 models × 1 brief) and inspected the leaderboard diff
- [ ] No secrets in the diff (`.env` should never appear; double-check)
- [ ] Updated README / CONTRIBUTING if you added a flag, command, or preset

## Cost

<Approximate $ spent on test runs for this PR.>

## Notes for reviewers

<Anything non-obvious. Tradeoffs you considered and rejected. Future follow-ups.>
