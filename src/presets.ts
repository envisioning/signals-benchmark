/**
 * Named model presets for common cohorts.
 *
 * Curated by hand. Maintained alongside src/models.ts — if you add a
 * model there and want it in a preset, add the slug here too.
 *
 * Naming: kebab-case. Append the curation date when the cohort would
 * shift (e.g. "top25-2026q2") so historic runs stay reproducible — the
 * preset slug is recorded in the run's meta.json.
 */

export const PRESETS: Record<string, string[]> = {
  /**
   * top25 — a hand-picked spread of 25 high-signal models across all
   * major vendors, weighted toward current flagships + best-of-tier
   * efficient siblings. Not OpenRouter's by-usage ranking (no public
   * API for that), but the cohort most foresight buyers would care
   * about when comparing.
   */
  top25: [
    // OpenAI
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-4.1-mini",
    "openai/o3",
    "openai/o4-mini",
    // Anthropic
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-haiku-4.5",
    // Google
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    // xAI
    "x-ai/grok-4",
    "x-ai/grok-4.1-fast",
    // Mistral
    "mistralai/mistral-large-2512",
    // DeepSeek
    "deepseek/deepseek-v3.2",
    // Qwen
    "qwen/qwen3-max",
    // Moonshot
    "moonshotai/kimi-k2.5",
    // Perplexity (web-grounded — interesting on this benchmark)
    "perplexity/sonar-reasoning-pro",
    "perplexity/sonar-deep-research",
    // Amazon
    "amazon/nova-pro-v1",
    // Cohere
    "cohere/command-a",
    // Reka (note: vendor prefix is `rekaai/`, not `reka/`)
    "rekaai/reka-flash-3",
    // Microsoft (for vendor diversity at the small-model end)
    "microsoft/phi-4",
    // Z.AI
    "z-ai/glm-4.6",
    // Meta (open-weights flagship)
    "meta-llama/llama-4-maverick",
    // NVIDIA (latest Nemotron-tuned Llama on OpenRouter)
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  ],

  /**
   * Flagships that shipped after the 2026-05 cohort was frozen, plus the
   * models already on the leaderboard that main's catalog was missing.
   * Dated because the cohort will shift — see the naming note above.
   *
   * Intended use is the cheap paths: `pnpm cutoff --preset new-2026q3`
   * adds them to the cutoff chart for cents, and
   * `pnpm bench --into <run> --preset new-2026q3` adds them to the
   * leaderboard at $3-5 each.
   */
  "new-2026q3": [
    // Flagships released since the cohort was frozen
    "anthropic/claude-opus-5",
    "openai/gpt-5.6-luna-pro",
    "google/gemini-3.7-flash",
    "x-ai/grok-4.6",
    "qwen/qwen3.8-max",
    "z-ai/glm-5.3",
    "moonshotai/kimi-k3",
    "deepseek/deepseek-v4-pro-0813",
  ],

  /**
   * Everything big that shipped on OpenRouter after the 2026-05 run's
   * last top-up (2026-07-11), checked against the live catalog on
   * 2026-10-01. Supersedes new-2026q3 for gpt-6, grok-4.7, gemini-3.8
   * and the Qwen/GLM snapshots.
   *
   * Use: `pnpm bench --into <run> --preset new-2026q4`. --into pins the
   * run's judges, so the scores stay comparable. ~$4/model.
   */
  "new-2026q4": [
    "openai/gpt-6.1-sol",
    "openai/gpt-6-astra",
    "openai/gpt-6-luna",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5.5",
    "google/gemini-3.8-flash",
    "x-ai/grok-4.7",
    "qwen/qwen3.8-max-0902",
    "z-ai/glm-5.3",
    "moonshotai/kimi-k3",
    "deepseek/deepseek-v4-pro-0813",
    "meta/muse-spark-1.3",
    "xiaomi/mimo-v2.6-pro",
    "cohere/command-a-plus",
    // shipped 2026-10-01..2026-11-01, added 2026-11-01
    "openai/gpt-6.1-terra",
    "anthropic/claude-haiku-5.5",
    "google/gemini-4-argon",
    "mistralai/mistral-large-4-0",
    "moonshotai/kimi-k3.1-pro",
    "meta/muse-wonder",
    "stepfun/step-5-preview",
  ],

  /**
   * The lean cut of new-2026q4: the flagship and the workhorse of each
   * lab. Run on the six briefs of results/2026-q4-core (healthcare,
   * fintech, energy, geopolitics, ai-infra, retail). On the 2026-05 run
   * those six rank the 30 full-coverage models like all twelve do
   * (Spearman 0.992, mean composite shift 0.7, no model moves more than
   * three places) at half the judging cost.
   *
   * Use: `pnpm bench --into 2026-q4-core --preset core-2026q4`.
   */
  "core-2026q4": [
    "openai/gpt-6.1-sol",
    "openai/gpt-6-luna",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
    "google/gemini-4-argon",
    "google/gemini-3.8-flash",
    "x-ai/grok-4.7",
    "moonshotai/kimi-k3.1-pro",
    "deepseek/deepseek-v4-pro-0813",
    "qwen/qwen3.8-max-0902",
    "z-ai/glm-5.3",
  ],

  /** Tiny smoke set — runs in ~30 seconds, costs cents. */
  smoke: ["openai/gpt-4.1-mini", "anthropic/claude-haiku-4.5"],

  /** Current frontier-only set — flagships across vendors. */
  frontier: [
    "openai/gpt-5.4",
    "openai/o3",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-2.5-pro",
    "x-ai/grok-4",
    "mistralai/mistral-large-2512",
    "deepseek/deepseek-v3.2",
    "qwen/qwen-max",
    "moonshotai/kimi-k2.5",
  ],
}

export function getPreset(name: string): string[] | undefined {
  return PRESETS[name]
}

export function listPresets(): string[] {
  return Object.keys(PRESETS)
}
