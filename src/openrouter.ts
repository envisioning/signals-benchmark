/**
 * Thin OpenRouter caller. Single dependency: fetch.
 *
 * Returns a discriminated `success` union so callers can branch without
 * try/catch. Annotations (url_citation array) are surfaced for the
 * web-grounded verifier path; usage (tokens + cost) is surfaced for
 * the leaderboard's cost columns.
 */

export type ORChatOptions = {
  apiKey: string
  model: string
  messages: { role: "system" | "user" | "assistant"; content: string }[]
  responseFormat?: {
    type: "json_schema"
    json_schema: { name: string; strict: true; schema: Record<string, any> }
  }
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  webSearch?: boolean
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high"
    exclude?: boolean
    enable?: boolean
  }
}

export type ORUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
}

export type ORAnnotation = {
  type: "url_citation"
  url_citation: {
    url: string
    title?: string
    content?: string
    start_index?: number
    end_index?: number
  }
}

export type ORResult =
  | {
      success: true
      text: string
      usage?: ORUsage
      annotations?: ORAnnotation[]
      raw: any
    }
  | {
      success: false
      code: number
      message: string
      raw?: any
    }

export async function openrouterChat(opts: ORChatOptions): Promise<ORResult> {
  const url = "https://openrouter.ai/api/v1/chat/completions"
  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages,
    usage: { include: true },
    user: "signals-benchmark",
  }
  if (opts.responseFormat) body.response_format = opts.responseFormat
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
  if (opts.webSearch) {
    body.web_search_options = { search_context_size: "high" }
  }
  if (opts.reasoning) {
    body.reasoning = opts.reasoning
  }

  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 300_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/envisioning/signals-benchmark",
        "X-Title": "Signals Benchmark",
      },
      body: JSON.stringify(body),
    })
    clearTimeout(timer)

    const text = await response.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      return {
        success: false,
        code: response.status,
        message: `Non-JSON response: ${text.slice(0, 400)}`,
      }
    }

    if (json?.error) {
      // OpenRouter wraps the upstream provider's error in `metadata`.
      // Without surfacing it, every failure looks like "Provider
      // returned error" which is useless for debugging.
      const meta = json.error.metadata
      const upstream =
        meta?.raw ||
        meta?.provider_error?.message ||
        (typeof meta === "string" ? meta : null) ||
        (meta ? JSON.stringify(meta).slice(0, 240) : null)
      const message = upstream
        ? `${json.error.message ?? "Provider error"} — ${upstream}`
        : (json.error.message ?? "Unknown OpenRouter error")
      return {
        success: false,
        code: json.error.code ?? response.status,
        message,
        raw: json,
      }
    }

    const choice = json?.choices?.[0]
    const content: string | undefined = choice?.message?.content ?? choice?.text
    if (!content) {
      return {
        success: false,
        code: 500,
        message: "Empty response (no message content)",
        raw: json,
      }
    }

    return {
      success: true,
      text: content,
      usage: json.usage,
      annotations: choice.annotations,
      raw: json,
    }
  } catch (e: any) {
    clearTimeout(timer)
    return {
      success: false,
      code: 500,
      message:
        e?.name === "AbortError"
          ? `Timed out after ${timeoutMs}ms`
          : `Fetch error: ${e?.message ?? String(e)}`,
    }
  }
}

/**
 * Embedding call. Used by the semantic cache to detect near-duplicate
 * signals across models / runs. text-embedding-3-small is the cheapest
 * adequate option on OpenRouter (~$0.02 / 1M input tokens) — for a
 * ~200-token signal that's ~$0.000004 per call, effectively free.
 */
export async function openrouterEmbed(opts: {
  apiKey: string
  model?: string
  input: string
  timeoutMs?: number
}): Promise<
  | { success: true; embedding: number[]; cost?: number }
  | { success: false; code: number; message: string }
> {
  const model = opts.model ?? "openai/text-embedding-3-small"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: opts.input }),
    })
    clearTimeout(timer)
    const text = await response.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      return { success: false, code: response.status, message: text.slice(0, 240) }
    }
    if (json?.error) {
      return { success: false, code: json.error.code ?? 500, message: json.error.message }
    }
    const embedding = json?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      return { success: false, code: 500, message: "No embedding in response" }
    }
    return { success: true, embedding, cost: json?.usage?.cost }
  } catch (e: any) {
    clearTimeout(timer)
    return {
      success: false,
      code: 500,
      message: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e),
    }
  }
}

/**
 * Returns the lifetime billed amount on the API key (USD). Diffing
 * before/after a run gives the *actual* OR-billed cost — which is
 * more reliable than summing per-call `usage.cost` because:
 *   - The :online web-search surcharge isn't always in usage.cost
 *   - Some providers don't report cost back through the chat response
 *   - Cached prompt tokens may be priced differently than logged
 */
export async function getKeyUsage(apiKey: string): Promise<number | null> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!r.ok) return null
    const j: any = await r.json()
    const usage = j?.data?.usage
    return typeof usage === "number" ? usage : null
  } catch {
    return null
  }
}

/** Best-effort JSON extraction. Handles fenced ```json blocks and partial wraps. */
export function extractJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    /* fall through */
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {
      /* fall through */
    }
  }
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      /* fall through */
    }
  }
  throw new Error("Could not extract JSON from response")
}
