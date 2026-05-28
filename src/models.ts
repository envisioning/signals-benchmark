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
 */

export type BenchmarkModel = {
  id: string
  vendor: string
  tier: "frontier" | "mid" | "small" | "open"
  disabled?: boolean
  notes?: string
}

export const MODELS: BenchmarkModel[] = [
  // ─── OpenAI ───
  { id: "openai/gpt-5.4", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/gpt-5.4-mini", vendor: "OpenAI", tier: "mid" },
  { id: "openai/gpt-4.1", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/gpt-4.1-mini", vendor: "OpenAI", tier: "mid" },
  { id: "openai/o3", vendor: "OpenAI", tier: "frontier" },
  { id: "openai/o4-mini", vendor: "OpenAI", tier: "mid" },

  // ─── Anthropic ───
  { id: "anthropic/claude-opus-4.8", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-opus-4.7", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-opus-4.6", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-sonnet-4.6", vendor: "Anthropic", tier: "frontier" },
  { id: "anthropic/claude-haiku-4.5", vendor: "Anthropic", tier: "small" },
  { id: "anthropic/claude-sonnet-4", vendor: "Anthropic", tier: "frontier" },

  // ─── Google ───
  { id: "google/gemini-2.5-pro", vendor: "Google", tier: "frontier" },
  { id: "google/gemini-2.5-flash", vendor: "Google", tier: "mid" },

  // ─── xAI ───
  { id: "x-ai/grok-4", vendor: "xAI", tier: "frontier" },
  { id: "x-ai/grok-4.1-fast", vendor: "xAI", tier: "mid" },

  // ─── Meta (open weights) ───
  { id: "meta-llama/llama-4-maverick", vendor: "Meta", tier: "open" },
  { id: "meta-llama/llama-4-scout", vendor: "Meta", tier: "open" },
  { id: "meta-llama/llama-3.3-70b-instruct", vendor: "Meta", tier: "open" },

  // ─── Mistral ───
  { id: "mistralai/mistral-large-2512", vendor: "Mistral", tier: "frontier" },
  { id: "mistralai/mistral-medium", vendor: "Mistral", tier: "mid" },
  { id: "mistralai/codestral-2501", vendor: "Mistral", tier: "mid" },

  // ─── DeepSeek ───
  { id: "deepseek/deepseek-v3.2", vendor: "DeepSeek", tier: "frontier" },
  { id: "deepseek/deepseek-r1", vendor: "DeepSeek", tier: "frontier" },
  { id: "deepseek/deepseek-chat", vendor: "DeepSeek", tier: "mid" },

  // ─── Qwen (Alibaba) ───
  { id: "qwen/qwen-plus", vendor: "Alibaba", tier: "mid" },
  { id: "qwen/qwen-max", vendor: "Alibaba", tier: "frontier" },
  { id: "qwen/qwen3-235b-a22b", vendor: "Alibaba", tier: "open" },
  { id: "qwen/qwq-32b", vendor: "Alibaba", tier: "open" },

  // ─── Moonshot ───
  { id: "moonshotai/kimi-k2.5", vendor: "Moonshot", tier: "frontier" },
  { id: "moonshotai/kimi-k2", vendor: "Moonshot", tier: "open" },

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
  { id: "cohere/command-r-plus", vendor: "Cohere", tier: "mid" },

  // ─── Microsoft ───
  { id: "microsoft/phi-4", vendor: "Microsoft", tier: "small" },
  { id: "microsoft/phi-4-multimodal-instruct", vendor: "Microsoft", tier: "small" },

  // ─── NVIDIA ───
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", vendor: "NVIDIA", tier: "open" },

  // ─── Inflection ───
  { id: "inflection/inflection-3-productivity", vendor: "Inflection", tier: "mid" },

  // ─── 01.AI ───
  { id: "01-ai/yi-large", vendor: "01.AI", tier: "mid" },

  // ─── AI21 ───
  { id: "ai21/jamba-1.6-large", vendor: "AI21", tier: "mid" },

  // ─── Databricks ───
  { id: "databricks/dbrx-instruct", vendor: "Databricks", tier: "open" },

  // ─── Reka ───
  { id: "reka/reka-flash-3", vendor: "Reka", tier: "mid" },
  { id: "reka/reka-core", vendor: "Reka", tier: "frontier" },

  // ─── Liquid ───
  { id: "liquid/lfm-40b", vendor: "Liquid", tier: "open" },

  // ─── Z.AI (GLM) ───
  { id: "z-ai/glm-4.6", vendor: "Z.AI", tier: "frontier" },
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
