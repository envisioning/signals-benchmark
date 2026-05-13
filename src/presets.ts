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
