/**
 * Evaluation step: per-signal scoring across three axes (coverage is
 * brief-level, computed in score.ts).
 *
 *   1. Verifiability — web-grounded judge classifies the claim using a
 *      6-bucket rubric: grounded / speculative / future / indicative /
 *      dubious / fabricated. The "future" bucket is the key innovation:
 *      genuinely forward-looking claims can't have web evidence yet,
 *      so they're neither punished nor inflated.
 *   2. Currency — newest source date from the judge's annotations,
 *      mapped through a decay curve.
 *   3. Specificity — a separate, non-grounded judge against the
 *      writing rubric (no vague quantifiers, named actors, etc.).
 *
 * Why two different judges: avoid the same family judging both substance
 * and form — reduces judge-family bias.
 */
import { openrouterChat, openrouterEmbed, extractJson } from "./openrouter.ts"
import { JudgeCache, NullCache, type CacheKey } from "./cache.ts"
import type {
  Brief,
  GeneratedSignal,
  SignalEvaluation,
  ModelEvaluation,
  VerificationVerdict,
} from "./types.ts"

/**
 * Bump this when you materially change the verifier or specificity
 * rubrics. Old cache entries become unreachable (they hash differently)
 * — no need to wipe `cache/` manually.
 */
export const RUBRIC_VERSION = "2026-05-v1"

/** What we persist per verifier cache entry. */
type VerifierCacheValue = {
  verdict: VerificationVerdict
  newest_source_date?: string
  comments?: string
  sources: { url: string; title?: string }[]
}

/** What we persist per specificity cache entry. */
type SpecCacheValue = {
  score: number
  comments?: string
}

const VERDICT_SCORE: Record<VerificationVerdict, number> = {
  grounded: 100,
  speculative: 80,
  future: 75, // forward-looking + plausible; we don't punish foresight
  indicative: 60,
  dubious: 40,
  fabricated: 20,
}

const VERIFIABILITY_RUBRIC = `
Definitions (pick ONE):
- grounded: Specific claim verified by 2+ independent reputable sources; details/dates align.
- speculative: Plausible; at least one credible mention, specifics not confirmed.
- future: Genuinely forward-looking claim about something that has not happened yet — assess plausibility only, do not penalize for lack of evidence.
- indicative: Instance unverified, but the broader trend is well-documented.
- dubious: Instance unverified and broader trend lacks support.
- fabricated: Contradicted by strong evidence; demonstrably false.
`.trim()

function verifyPrompt(brief: Brief, signal: GeneratedSignal): string {
  return `You are a Signal Verification Assistant.
Evaluate the signal in the context of: ${brief.topic}.

${VERIFIABILITY_RUBRIC}

Method:
1. Search the web for the specific claim. Prefer primary/authoritative sources (press releases, filings, standards, peer-reviewed research), then tier-1 media. Note publication dates.
2. Decide which definition applies. If the claim is about something that has not happened yet (a forecast, an "X will Y" statement), choose "future" and judge plausibility.
3. Return the most recent source date you found, in YYYY-MM-DD (omit if none).

Output STRICTLY as JSON with this shape (no markdown, no prose):
{"verdict":"grounded|speculative|future|indicative|dubious|fabricated","newest_source_date":"YYYY-MM-DD|null","comments":"<=40 words"}

Signal:
Title: ${signal.title}
Summary: ${signal.summary}
`
}

const SPECIFICITY_RUBRIC = `
Score the SIGNAL on a 0-100 specificity scale based on this rubric. Do NOT search the web; judge purely on writing quality.

Award points for:
- Names a concrete actor (company, agency, person, project, standard).
- Names a concrete event, product, filing, or measurable shift.
- Includes a quantitative or temporal anchor.
- Uses active voice; present tense for the objective sentence.

Deduct points for:
- Vague quantifiers (many, several, growing, rising, increasing).
- Hype adjectives (innovative, disruptive, unprecedented, transformative, paradigm).
- Generic forecasts with no concrete anchor.
- Future-tense claims with no observable basis.
- Filler adverbs (very, extremely), passive voice, first-person.

A score of 100 = a sharp, named, anchored observation. A score of 0 = pure hype with no specifics.
`.trim()

function specificityPrompt(signal: GeneratedSignal): string {
  return `${SPECIFICITY_RUBRIC}

Output STRICTLY as JSON: {"score": <0-100 integer>, "comments": "<=30 words"}

Signal:
Title: ${signal.title}
Summary: ${signal.summary}
`
}

function currencyScore(newestDateIso?: string): number {
  if (!newestDateIso) return 0
  const t = Date.parse(newestDateIso)
  if (Number.isNaN(t)) return 0
  const monthsAgo = (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.44)
  if (monthsAgo <= 3) return 100
  if (monthsAgo <= 6) return 85
  if (monthsAgo <= 12) return 70
  if (monthsAgo <= 18) return 50
  if (monthsAgo <= 24) return 30
  return 10
}

async function evaluateSignal({
  apiKey,
  brief,
  signal,
  judgeModel,
  specificityJudge,
  verifierCache,
  specCache,
}: {
  apiKey: string
  brief: Brief
  signal: GeneratedSignal
  judgeModel: string
  specificityJudge: string
  verifierCache: JudgeCache<VerifierCacheValue>
  specCache: JudgeCache<SpecCacheValue>
}): Promise<{
  result: Omit<SignalEvaluation, "signal_index">
  cost_usd: number
  cache_hits: {
    verifier: "exact" | "semantic" | null
    specificity: "exact" | "semantic" | null
  }
}> {
  const verifierKey: CacheKey = {
    namespace: "verifier",
    rubric_version: RUBRIC_VERSION,
    judge_model: judgeModel,
    brief_id: brief.id,
    title: signal.title,
    summary: signal.summary,
  }
  const specKey: CacheKey = {
    namespace: "specificity",
    rubric_version: RUBRIC_VERSION,
    judge_model: specificityJudge,
    title: signal.title,
    summary: signal.summary,
  }

  // Embed once per signal — used for both verifier and specificity
  // semantic cache lookups. Cheap (<$0.000005/call). On embedding
  // failure we proceed without semantic matching (exact-only).
  const embedRes = await openrouterEmbed({
    apiKey,
    input: `${signal.title}. ${signal.summary}`,
    timeoutMs: 15_000,
  })
  const embedding = embedRes.success ? embedRes.embedding : null

  const verifyLookup = verifierCache.getOrSemantic(verifierKey, embedding)
  const specLookup = specCache.getOrSemantic(specKey, embedding)
  const cachedVerify = verifyLookup?.value ?? null
  const cachedSpec = specLookup?.value ?? null

  // Two independent API calls — issue concurrently. If one is cached we
  // skip its call; if both are cached we make zero API calls.
  let cost = embedRes.success ? embedRes.cost ?? 0 : 0
  const verifyCacheKind = verifyLookup?.kind ?? null
  const specCacheKind = specLookup?.kind ?? null

  const [verifyOutput, specOutput] = await Promise.all([
    cachedVerify
      ? Promise.resolve({ value: cachedVerify, cost: 0, fromCache: true })
      : (async () => {
          const r = await openrouterChat({
            apiKey,
            model: judgeModel,
            messages: [{ role: "user", content: verifyPrompt(brief, signal) }],
            webSearch: true,
            timeoutMs: 120_000,
          })
          const value: VerifierCacheValue = {
            verdict: "dubious",
            sources: [],
          }
          let usageCost = 0
          if (r.success) {
            usageCost = r.usage?.cost ?? 0
            try {
              const parsed = extractJson(r.text)
              const v = String(parsed.verdict ?? "").toLowerCase() as VerificationVerdict
              if (v in VERDICT_SCORE) value.verdict = v
              value.comments = parsed.comments
              if (parsed.newest_source_date && parsed.newest_source_date !== "null") {
                value.newest_source_date = parsed.newest_source_date
              }
            } catch {
              /* keep "dubious" default */
            }
            value.sources =
              r.annotations
                ?.filter((a) => a.type === "url_citation")
                .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title })) ?? []
            verifierCache.set(verifierKey, value, embedding ?? undefined)
          }
          return { value, cost: usageCost, fromCache: false }
        })(),
    cachedSpec
      ? Promise.resolve({ value: cachedSpec, cost: 0, fromCache: true })
      : (async () => {
          const r = await openrouterChat({
            apiKey,
            model: specificityJudge,
            messages: [{ role: "user", content: specificityPrompt(signal) }],
            timeoutMs: 60_000,
          })
          const value: SpecCacheValue = { score: 50 }
          let usageCost = 0
          if (r.success) {
            usageCost = r.usage?.cost ?? 0
            try {
              const parsed = extractJson(r.text)
              if (typeof parsed.score === "number") {
                value.score = Math.max(0, Math.min(100, Math.round(parsed.score)))
              }
              value.comments = parsed.comments
            } catch {
              /* keep default */
            }
            specCache.set(specKey, value, embedding ?? undefined)
          }
          return { value, cost: usageCost, fromCache: false }
        })(),
  ])

  cost += verifyOutput.cost + specOutput.cost

  return {
    result: {
      verifiability: {
        verdict: verifyOutput.value.verdict,
        score: VERDICT_SCORE[verifyOutput.value.verdict],
        comments: verifyOutput.value.comments,
      },
      currency: {
        score: currencyScore(verifyOutput.value.newest_source_date),
        newest_source_date: verifyOutput.value.newest_source_date,
      },
      specificity: { score: specOutput.value.score, comments: specOutput.value.comments },
      sources: verifyOutput.value.sources,
    },
    cost_usd: cost,
    cache_hits: {
      verifier: verifyCacheKind,
      specificity: specCacheKind,
    },
  }
}

export async function evaluateRun({
  apiKey,
  brief,
  model,
  signals,
  judgeModel,
  specificityJudge,
  verifierCache,
  specCache,
  concurrency = 4,
}: {
  apiKey: string
  brief: Brief
  model: string
  signals: GeneratedSignal[]
  judgeModel: string
  specificityJudge: string
  verifierCache: JudgeCache<VerifierCacheValue>
  specCache: JudgeCache<SpecCacheValue>
  concurrency?: number
}): Promise<ModelEvaluation> {
  const { default: pMap } = await import("p-map")
  let totalCost = 0
  let vHits = 0
  let sHits = 0
  const evaluations = await pMap(
    signals.map((s, i) => ({ s, i })),
    async ({ s, i }) => {
      const { result, cost_usd, cache_hits } = await evaluateSignal({
        apiKey,
        brief,
        signal: s,
        judgeModel,
        specificityJudge,
        verifierCache,
        specCache,
      })
      totalCost += cost_usd
      if (cache_hits.verifier !== null) vHits++
      if (cache_hits.specificity !== null) sHits++
      return { signal_index: i, ...result } satisfies SignalEvaluation
    },
    { concurrency }
  )

  return {
    brief_id: brief.id,
    model,
    judge_model: judgeModel,
    evaluations,
    coverage: { score: 0, category_balance: 0, unique_share: 0 }, // filled by score.ts
    judge_cost_usd: totalCost,
    cache_hits: { verifier: vHits, specificity: sHits },
  }
}

/** Factory: returns either real or null caches based on the flag. */
export function makeCaches(enabled: boolean) {
  if (!enabled) {
    return {
      verifierCache: new NullCache<VerifierCacheValue>("verifier"),
      specCache: new NullCache<SpecCacheValue>("specificity"),
    }
  }
  return {
    verifierCache: new JudgeCache<VerifierCacheValue>("verifier"),
    specCache: new JudgeCache<SpecCacheValue>("specificity"),
  }
}
