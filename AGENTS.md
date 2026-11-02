# signals-benchmark agent notes

## Traps

- **Judge web search needs the claim alone in the user message.** OpenRouter's
  web search (`:online`, `web_search_options`, the `web` plugin) builds its
  query from the user message. With the whole verifier prompt there, it
  returned the same unrelated pages for every claim (Nov 2026), and the judge
  marked real events `dubious`. Keep the instructions in the system message
  (`verifyInstructions`) and only the signal in the user message
  (`verifySignal`). If you change the verifier prompt, bump
  `VERIFIER_PROMPT_VERSION` so the cache does not serve old verdicts.
- **Check judge drift before you compare runs.** Re-judge a few old pairs with
  `--no-cache` into a scratch run (`bench:resume --run <scratch> --no-cache`)
  and compare verdicts with the original evals. The Nov 2026 check after the
  fix matched May within +0..+4 verifiability.
- **An empty credit balance used to look like bad scores.** A 402 from the
  judge was saved as `dubious`/40 at $0. Judging now throws on a failed call,
  so the run stops. A run that stops on 402 needs credit, then `--into` again:
  finished pairs are kept.
- **`cp` resets file times.** Do not select evals by mtime in a run built by
  copying files from another run.

## Runs

- `results/` is gitignored. The reference 12-brief run is
  `2026-05-13T10-10-56-382Z`. `2026-q4-core` is its 6-brief subset plus the
  `core-2026q4` preset (see the comment in `src/presets.ts` for why 6 briefs
  stay valid).
- Extend a run with `pnpm bench --into <run> --models a,b` or `--preset`.
  `--into` keeps the run's judges and briefs.
