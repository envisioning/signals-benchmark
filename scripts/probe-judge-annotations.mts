#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * One-off probe: call each candidate judge model with a real verifier
 * prompt and dump whatever shape they return for citations. Used to
 * figure out why `google/gemini-2.5-flash:online` produced empty
 * `sources` for all 4737 evals in the 2026-05-13 run.
 *
 * Run: OPENROUTER_API_KEY=... node --experimental-strip-types
 *      scripts/probe-judge-annotations.mts
 */

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

const CANDIDATES = [
  "google/gemini-2.5-flash:online",
  "openai/gpt-5.4:online",
  "perplexity/sonar-reasoning-pro",
];

// A real benchmark signal whose verdict came back "grounded" with
// commentary citing multiple sources but no captured URLs.
const PROMPT = `You are evaluating a research signal of change.

Brief: AI infrastructure scaling — compute scaling limits, inference economics, and the post-training tooling stack.

Signal:
- Title: On-package high-bandwidth memory
- Summary: New AI chips embed HBM3E directly on processor packages for tighter memory coupling. Signals alleviation of the memory bandwidth bottleneck in dense compute workloads.

Search the web for the specific claim. Prefer primary/authoritative sources. Then return a JSON object with:
{
  "verdict": "grounded" | "speculative" | "indicative" | "dubious" | "future" | "fabricated",
  "comments": "<short reasoning>",
  "newest_source_date": "YYYY-MM-DD" | null
}

Return only JSON. No markdown fences.`;

type Reply = {
  ok: boolean;
  status?: number;
  responseShape?: string;
  topLevelKeys?: string[];
  choiceKeys?: string[];
  messageKeys?: string[];
  annotationsType?: string;
  annotationsLen?: number;
  annotationsSample?: unknown;
  groundingMetadata?: unknown;
  // any other place citations might live
  extras?: Record<string, unknown>;
};

async function probe(model: string): Promise<Reply> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/envisioning/signals-benchmark",
      "X-Title": "Signals Benchmark (probe)",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: PROMPT }],
      web_search_options: { search_context_size: "high" },
      usage: { include: true },
    }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const json = (await res.json()) as any;
  const choice = json?.choices?.[0];
  const reply: Reply = {
    ok: true,
    status: res.status,
    topLevelKeys: Object.keys(json ?? {}),
    choiceKeys: choice ? Object.keys(choice) : [],
    messageKeys: choice?.message ? Object.keys(choice.message) : [],
  };
  // Check BOTH levels — current code reads choice.annotations but the
  // OpenRouter response puts them on choice.message.annotations.
  const choiceAnns = choice?.annotations;
  const messageAnns = choice?.message?.annotations;
  reply.extras = reply.extras ?? {};
  reply.extras["choice.annotations"] = Array.isArray(choiceAnns)
    ? `[len=${choiceAnns.length}] ${JSON.stringify(choiceAnns.slice(0, 2)).slice(0, 300)}`
    : `<${choiceAnns === undefined ? "undefined" : typeof choiceAnns}>`;
  reply.extras["choice.message.annotations"] = Array.isArray(messageAnns)
    ? `[len=${messageAnns.length}] ${JSON.stringify(messageAnns.slice(0, 2)).slice(0, 600)}`
    : `<${messageAnns === undefined ? "undefined" : typeof messageAnns}>`;
  // Plus content preview to verify the judge actually searched.
  reply.extras["message.content.preview"] = String(
    choice?.message?.content ?? "",
  ).slice(0, 200);
  // Gemini's web-grounded mode historically returns groundingMetadata
  // under message; capture if present.
  reply.groundingMetadata =
    choice?.message?.grounding_metadata ??
    choice?.message?.groundingMetadata ??
    choice?.grounding_metadata ??
    choice?.groundingMetadata ??
    null;
  // Look for any other URL-shaped fields anywhere in the choice payload.
  const extras: Record<string, unknown> = {};
  const walk = (o: any, path: string) => {
    if (path.length > 200) return;
    if (Array.isArray(o)) {
      o.slice(0, 3).forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (/url|citation|source|grounding/i.test(k) && !path.includes("annotations")) {
          extras[`${path}.${k}`] = Array.isArray(v)
            ? `[len=${v.length}] ${JSON.stringify(v).slice(0, 200)}`
            : JSON.stringify(v).slice(0, 200);
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(choice, "");
  if (Object.keys(extras).length > 0) reply.extras = extras;
  return reply;
}

for (const m of CANDIDATES) {
  process.stdout.write(`\n=== ${m} ===\n`);
  try {
    const r = await probe(m);
    console.log(JSON.stringify(r, null, 2));
  } catch (e: any) {
    console.log("ERROR:", e?.message ?? String(e));
  }
}
