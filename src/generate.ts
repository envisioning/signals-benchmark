/**
 * Generation step: ask one model to produce signals for one brief.
 *
 * Mirrors the production signal-generation prompt so the benchmark
 * exercises models under realistic conditions. No web search granted at
 * this step — that would unfairly advantage web-grounded models on the
 * verifiability axis (which is exactly what the *judge* tests later).
 */
import { openrouterChat, extractJson } from "./openrouter.ts"
import type { Brief, ModelRun, GeneratedSignal } from "./types.ts"

const SIGNALS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          category: { type: "string" },
          summary: { type: "string" },
        },
        required: ["title", "category", "summary"],
      },
    },
  },
  required: ["signals"],
}

function buildPrompt(brief: Brief): string {
  const categoriesList = brief.categories.join(", ")
  const total = brief.categories.length * brief.signalsPerCategory
  return `## Prompt
Generate ${brief.signalsPerCategory} signals of change for EACH of the following categories: ${categoriesList}.
A signal of change is a concrete, observable development that has the potential to disrupt the status quo or indicate a larger shift.
Your audience is ${brief.audience}.
Topic / scan focus: ${brief.topic}.

For each signal, provide:
1. A clear, concise title (30-40 characters maximum)
2. A brief but thorough description (2-3 sentences)
3. The category of the signal — MUST be one of these exact categories: ${categoriesList}

## SIGNAL WRITING RULES
- TITLE: 30-40 characters, noun phrase, 3-6 words, no verbs/superlatives.
- SUMMARY: exactly 2 sentences; ≤ 25 words each.
  1. Objective sentence: present-tense, based on available data.
  2. Impact sentence: begins with "Signals" or "Indicates", states immediate relevance; no forecasts.
- LANGUAGE: active voice; ban vague quantifiers (many, several, growing), filler adverbs (very, extremely), first-person pronouns. Avoid hype adjectives (innovative, disruptive, unprecedented, paradigm). No future tense.

## Format
Respond ONLY with a JSON object: { "signals": [ { title, category, summary }, ... ] }.

CRITICAL:
1. You MUST generate exactly ${brief.signalsPerCategory} signals for EACH category, for a total of ${total} signals.
2. You MUST use EXACTLY one of these category labels for each signal: ${categoriesList}.
3. DO NOT include any text before or after the JSON.
4. Be specific, factual, concrete; focus on emerging trends or developments.
`
}

/**
 * Reasoning models burn output tokens on internal CoT *before* writing
 * the visible answer. OpenAI o-series, deepseek-r1, qwen3-max-thinking,
 * etc. need a much higher max_tokens or they truncate mid-response (o3)
 * or return an empty body (o4-mini consumed all tokens reasoning).
 */
export function isReasoningModel(model: string): boolean {
  return (
    /^openai\/o\d/.test(model) || // o1, o3, o4, ...
    model.includes("deepseek-r1") ||
    model.includes("thinking") ||
    model.includes("reasoning") ||
    model.includes("sonar-reasoning") ||
    model.includes("sonar-deep-research")
  )
}

/**
 * OpenAI's o-series doesn't accept OpenRouter's `reasoning` parameter
 * the same way other reasoning models do (they manage reasoning
 * internally + bill it as completion tokens). The Signals production
 * codebase explicitly omits `reasoning` for openai/* — we follow the
 * same pattern. Without this, o3/o4-mini fail with cryptic 400s.
 */
export function shouldPassReasoning(model: string): boolean {
  return isReasoningModel(model) && !model.startsWith("openai/")
}

export async function generateForBrief({
  apiKey,
  brief,
  model,
  timeoutMs,
}: {
  apiKey: string
  brief: Brief
  model: string
  timeoutMs?: number
}): Promise<ModelRun> {
  const started = Date.now()
  const startedIso = new Date(started).toISOString()

  const reasoning = isReasoningModel(model)
  const result = await openrouterChat({
    apiKey,
    model,
    messages: [{ role: "user", content: buildPrompt(brief) }],
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "signals", strict: true, schema: SIGNALS_RESPONSE_SCHEMA },
    },
    temperature: 0.7,
    // 6000 covered most non-reasoning models, but verbose ones (e.g.
    // gemini-3.5-flash) truncate mid-JSON on 16-signal briefs. 12k gives
    // headroom without meaningfully changing cost for terser models.
    // Reasoning models eat 4-10k internal tokens before the answer; 16k
    // covers them with headroom. Empirically: o3 truncated at 6k, fine at 16k.
    maxTokens: reasoning ? 16_000 : 12_000,
    // Cap reasoning effort — we don't need maximum thought for a list
    // generation task, and "minimal" keeps cost reasonable. Without
    // this, o3/o4-mini can burn $0.50+ on internal reasoning per call.
    reasoning: shouldPassReasoning(model) ? { effort: "minimal", exclude: true } : undefined,
    // Reasoning models are inherently slower. Give them more wall time.
    timeoutMs: timeoutMs ?? (reasoning ? 600_000 : 300_000),
  })

  const finishedAt = new Date().toISOString()
  const duration_ms = Date.now() - started

  if (!result.success) {
    return {
      brief_id: brief.id,
      model,
      started_at: startedIso,
      finished_at: finishedAt,
      duration_ms,
      signals: [],
      error: { code: result.code, message: result.message },
    }
  }

  let signals: GeneratedSignal[] = []
  try {
    const parsed = extractJson(result.text)
    const arr = Array.isArray(parsed) ? parsed : parsed?.signals
    if (!Array.isArray(arr)) {
      throw new Error("Response did not contain a signals array")
    }
    signals = arr
      .filter(
        (s: any) =>
          s &&
          typeof s.title === "string" &&
          typeof s.category === "string" &&
          typeof s.summary === "string"
      )
      .map((s: any) => ({
        title: s.title.trim(),
        category: s.category.trim(),
        summary: s.summary.trim(),
      }))
  } catch (e: any) {
    return {
      brief_id: brief.id,
      model,
      started_at: startedIso,
      finished_at: finishedAt,
      duration_ms,
      signals: [],
      error: {
        code: 500,
        message: `Parse error: ${e?.message ?? String(e)}; excerpt: ${result.text.slice(0, 240)}`,
      },
    }
  }

  return {
    brief_id: brief.id,
    model,
    started_at: startedIso,
    finished_at: finishedAt,
    duration_ms,
    cost_usd: result.usage?.cost,
    tokens: result.usage?.total_tokens,
    signals,
  }
}
