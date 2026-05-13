# Security

## Reporting a vulnerability

Found a security issue? **Please don't open a public issue.** Email **security@envisioning.com** with:

- A description of the issue
- Steps to reproduce (if applicable)
- Your assessment of severity

We'll acknowledge within 3 business days and aim to resolve critical issues within 30 days. Responsible disclosure is appreciated.

## What this project handles

The runner exists to call third-party LLM APIs via OpenRouter. It:

- **Reads** your `OPENROUTER_API_KEY` from `.env` at runtime
- **Sends** prompts to OpenRouter; the response is written to local disk
- **Writes** results to `results/` and `cache/` (both gitignored)
- **Does not** call home, telemetry, analytics, or any third-party service other than OpenRouter (and embedding provider via OpenRouter)

## Key handling

- `.env` is gitignored in this repo's `.gitignore`. Verify before committing if you fork.
- The runner never logs the key. Errors that include the key would be a bug — report it.
- `.env.example` ships with a clearly-marked placeholder (`sk-or-v1-...`).
- If you publish a leaderboard from a CI environment, use OpenRouter's rotatable keys and short-lived secrets.

## SVG safety (provider logos)

If you contribute additional provider logos to the consumer repo:

- Run a basic scan: `grep -lE "(<script|onload=|onerror=|onclick=|javascript:|<iframe|<foreignObject)" *.svg` should return nothing.
- Logos must be loaded via `<img src>` (not inline `<svg>` or `<object>`) so the browser doesn't execute embedded markup.
- The consumer (`signals-strict`) follows these rules; mirror them if you fork.

## Out of scope

- Risks from running a benchmark on a paid OpenRouter account. Cost discipline is on the operator. The runner reports actual billed cost in real time but does not enforce a budget cap (yet).
- Security of OpenRouter itself, or any model provider behind it.
