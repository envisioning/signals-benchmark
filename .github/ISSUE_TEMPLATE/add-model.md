---
name: Add a model
about: Propose adding a new LLM to the benchmark cohort
title: "Add model: <vendor>/<model>"
labels: ["enhancement", "model"]
---

## Model

- **OpenRouter slug:** `<vendor>/<model>`
- **Vendor:** <name>
- **Released:** <YYYY-MM-DD>
- **Tier:** frontier / mid / small / open

## Why add it

<One paragraph: why this model belongs in the cohort. New flagship? Underrepresented vendor? Distinct capability?>

## Verified

- [ ] Slug resolves on OpenRouter (`curl /api/v1/models | jq …`)
- [ ] Ran a smoke test locally (`pnpm bench --models <slug> --briefs healthcare-regulated-ai`)
- [ ] Produced 16 signals end-to-end without structured-output failures

## Optional

- Pricing per call (input + output): <$X / 1M tokens>
- Known caveats:
