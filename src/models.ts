/**
 * Curated set of OpenRouter models to benchmark.
 *
 * Maintained by hand rather than auto-pulled from /api/v1/models — the
 * benchmark needs a fixed, comparable cohort, and the OpenRouter catalog
 * includes hundreds of fine-tunes/aliases we don't want to test. Add new
 * flagships as they ship; mark deprecated ones with `disabled: true`
 * rather than deleting (so historical leaderboards still resolve).
 *
 * IDs follow OpenRouter's `<vendor>/<model>` slug convention. If a slug
 * doesn't resolve at runtime, the run keeps going and the failure shows
 * up in the leaderboard as an error column.
 *
 * Providers retire slugs faster than you'd think — 15 entries here went
 * dead between May and September 2026, including two that are still on
 * the published leaderboard. Check the live catalog against this list
 * before a paid run, or you'll buy a column of errors:
 *   curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id'

 */

export type BenchmarkModel = {
  id: string
  vendor: string
  tier: "frontier" | "mid" | "small" | "open"
  /**
   * Which gateway serves this model. Defaults to "openrouter". Overridable
   * per run with `--provider vercel` or per model with `slug@vercel` in
   * --models / a preset. Vercel is billed on its own VERCEL_AI_GATEWAY_KEY;
   * the OpenRouter key does not work against it. The judges always run on
   * OpenRouter (`:online` is an OpenRouter feature).
   */
  provider?: "openrouter" | "vercel"
  disabled?: boolean
  notes?: string
}

export const MODELS: BenchmarkModel[] = [
  // ─── OpenAI ───
  { id: "openai/gpt-5.4", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/gpt-5.6-luna-pro", vendor: "OpenAI", tier: "mid", notes: "gpt-5.6 efficient edition" },
  { id: "openai/gpt-5.6-sol", vendor: "OpenAI", tier: "frontier", notes: "gpt-5.6 flagship edition" },
  { id: "openai/gpt-5.6-terra", vendor: "OpenAI", tier: "mid", notes: "gpt-5.6 mid edition" },
  { id: "openai/gpt-6.1-sol", vendor: "OpenAI", tier: "frontier", notes: "gpt-6.1 flagship edition" },
  { id: "openai/gpt-6.1-terra", vendor: "OpenAI", tier: "mid", notes: "gpt-6.1 mid edition" },
  { id: "openai/gpt-6-astra", vendor: "OpenAI", tier: "frontier", notes: "gpt-6 top edition, $10/$50" },
  { id: "openai/gpt-6-luna", vendor: "OpenAI", tier: "mid", notes: "gpt-6 efficient edition" },
  { id: "openai/gpt-5.5", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/gpt-5.4-mini", vendor: "OpenAI", tier: "mid" },
  { id: "openai/gpt-4.1", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/gpt-4.1-mini", vendor: "OpenAI", tier: "mid" },
  { id: "openai/o3", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/o4-mini", vendor: "OpenAI", tier: "mid" },

  // ─── Anthropic ───
  { id: "anthropic/claude-haiku-5.5", vendor: "Anthropic", tier: "small" },
  { id: "anthropic/claude-opus-4.7", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-opus-5", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-opus-4.8", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-fable-5.1", vendor: "Anthropic", tier: "frontier", notes: "$10/$50" },
  { id: "anthropic/claude-opus-5.5", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-sonnet-5.5", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-opus-4.6", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-sonnet-4.6", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-haiku-4.5", vendor: "Anthropic", tier: "small" },
  { id: "anthropic/claude-sonnet-4", vendor: "Anthropic", tier: "frontier" },

  // ─── Google ───
  { id: "google/gemini-4-argon", vendor: "Google", tier: "frontier" },
  { id: "google/gemini-2.5-pro", vendor: "Google", tier: "frontier" },
  { id: "google/gemini-3.7-flash", vendor: "Google", tier: "mid" },
  { id: "google/gemini-3.8-flash", vendor: "Google", tier: "mid" },
  { id: "google/gemini-3.5-flash", vendor: "Google", tier: "mid" },
  { id: "google/gemini-3.1-pro-preview", vendor: "Google", tier: "frontier" },
  { id: "google/gemini-3.1-flash-lite", vendor: "Google", tier: "small" },
  { id: "google/gemini-2.5-flash", vendor: "Google", tier: "mid" },

  // ─── xAI ───
  { id: "x-ai/grok-4", vendor: "xAI", tier: "frontier" , disabled: true, notes: "retired from OpenRouter 2026-09" },
  { id: "x-ai/grok-4.6", vendor: "xAI", tier: "frontier" },
  { id: "x-ai/grok-4.7", vendor: "xAI", tier: "frontier" },
  { id: "x-ai/grok-4.1-fast", vendor: "xAI", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Meta (open weights) ───
  { id: "meta-llama/llama-4-maverick", vendor: "Meta", tier: "open" },
  { id: "meta-llama/llama-4-scout", vendor: "Meta", tier: "open" },
  { id: "meta-llama/llama-3.3-70b-instruct", vendor: "Meta", tier: "open" },

  // ─── Mistral ───
  { id: "mistralai/mistral-large-2512", vendor: "Mistral", tier: "frontier" },
  { id: "mistralai/mistral-large-4-0", vendor: "Mistral", tier: "frontier" },
  { id: "mistralai/mistral-medium", vendor: "Mistral", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },
  { id: "mistralai/codestral-2501", vendor: "Mistral", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── DeepSeek ───
  { id: "deepseek/deepseek-v3.2", vendor: "DeepSeek", tier: "frontier" },
  { id: "deepseek/deepseek-v4-pro-0813", vendor: "DeepSeek", tier: "frontier", notes: "dated snapshot" },
  { id: "deepseek/deepseek-v4-pro", vendor: "DeepSeek", tier: "frontier" },
  { id: "deepseek/deepseek-r1", vendor: "DeepSeek", tier: "frontier" },
  { id: "deepseek/deepseek-chat", vendor: "DeepSeek", tier: "mid" },

  // ─── Qwen (Alibaba) ───
  { id: "qwen/qwen-plus", vendor: "Alibaba", tier: "mid" },
  { id: "qwen/qwen-max", vendor: "Alibaba", tier: "frontier" , disabled: true, notes: "retired from OpenRouter 2026-09" },
  { id: "qwen/qwen3.8-max", vendor: "Alibaba", tier: "frontier" },
  { id: "qwen/qwen3.8-max-0902", vendor: "Alibaba", tier: "frontier", notes: "dated snapshot" },
  { id: "qwen/qwen3-max", vendor: "Alibaba", tier: "frontier" },
  { id: "qwen/qwen3-235b-a22b", vendor: "Alibaba", tier: "open" },
  { id: "qwen/qwq-32b", vendor: "Alibaba", tier: "open" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Moonshot ───
  { id: "moonshotai/kimi-k2.5", vendor: "Moonshot", tier: "frontier" },
  { id: "moonshotai/kimi-k3", vendor: "Moonshot", tier: "frontier" },
  { id: "moonshotai/kimi-k3.1-pro", vendor: "Moonshot", tier: "frontier" },
  { id: "moonshotai/kimi-k2", vendor: "Moonshot", tier: "open" },

  // ─── Meta (Muse) ───
  { id: "meta/muse-spark-1.3", vendor: "Meta", tier: "frontier" },
  { id: "meta/muse-wonder", vendor: "Meta", tier: "frontier", notes: "$4/$20" },

  // ─── StepFun ───
  { id: "stepfun/step-5-preview", vendor: "StepFun", tier: "frontier" },

  // ─── Xiaomi ───
  { id: "xiaomi/mimo-v2.6-pro", vendor: "Xiaomi", tier: "frontier" },

  // ─── Perplexity (web-grounded) ───
  { id: "perplexity/sonar-pro", vendor: "Perplexity", tier: "mid", notes: "web-grounded" },
  { id: "perplexity/sonar", vendor: "Perplexity", tier: "small", notes: "web-grounded" },
  { id: "perplexity/sonar-reasoning-pro", vendor: "Perplexity", tier: "frontier", notes: "web-grounded" },
  { id: "perplexity/sonar-deep-research", vendor: "Perplexity", tier: "frontier", notes: "web-grounded" },

  // ─── Amazon ───
  { id: "amazon/nova-pro-v1", vendor: "Amazon", tier: "frontier" },
  { id: "amazon/nova-2-lite-v1", vendor: "Amazon", tier: "mid" },
  { id: "amazon/nova-micro-v1", vendor: "Amazon", tier: "small" },

  // ─── Cohere ───
  { id: "cohere/command-a", vendor: "Cohere", tier: "frontier" },
  { id: "cohere/command-a-plus", vendor: "Cohere", tier: "mid" },
  { id: "cohere/command-r-plus", vendor: "Cohere", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Microsoft ───
  { id: "microsoft/phi-4", vendor: "Microsoft", tier: "small" },
  { id: "microsoft/phi-4-multimodal-instruct", vendor: "Microsoft", tier: "small" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── NVIDIA ───
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", vendor: "NVIDIA", tier: "open" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Inflection ───
  { id: "inflection/inflection-3-productivity", vendor: "Inflection", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── 01.AI ───
  { id: "01-ai/yi-large", vendor: "01.AI", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── AI21 ───
  { id: "ai21/jamba-1.6-large", vendor: "AI21", tier: "mid" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Databricks ───
  { id: "databricks/dbrx-instruct", vendor: "Databricks", tier: "open" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Reka ───
  { id: "rekaai/reka-flash-3", vendor: "Reka", tier: "mid" },
  { id: "reka/reka-core", vendor: "Reka", tier: "frontier" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Liquid ───
  { id: "liquid/lfm-40b", vendor: "Liquid", tier: "open" , disabled: true, notes: "retired from OpenRouter 2026-09" },

  // ─── Z.AI (GLM) ───
  { id: "z-ai/glm-4.6", vendor: "Z.AI", tier: "frontier" },
  { id: "z-ai/glm-5.3", vendor: "Z.AI", tier: "frontier" },
  { id: "z-ai/glm-5.1", vendor: "Z.AI", tier: "frontier" },
]

export const DEFAULT_JUDGE_MODEL = "openai/gpt-5.4:online"
export const DEFAULT_SPECIFICITY_JUDGE = "anthropic/claude-sonnet-4.6"

export function getEnabledModels(): BenchmarkModel[] {
  return MODELS.filter((m) => !m.disabled)
}

export function filterModels(filter?: {
  ids?: string[]
  vendors?: string[]
  tiers?: BenchmarkModel["tier"][]
}): BenchmarkModel[] {
  const base = getEnabledModels()
  if (!filter) return base
  return base.filter((m) => {
    if (filter.ids && !filter.ids.includes(m.id)) return false
    if (filter.vendors && !filter.vendors.includes(m.vendor)) return false
    if (filter.tiers && !filter.tiers.includes(m.tier)) return false
    return true
  })
}
