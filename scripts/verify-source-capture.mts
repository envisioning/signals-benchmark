#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Verifies the openrouter.ts source-capture fix end-to-end by calling
 * the same code path the verifier uses (openrouterChat with
 * webSearch: true) and asserting that the returned annotations
 * actually map onto url_citation entries.
 *
 * Run: node --experimental-strip-types --env-file=.env
 *      scripts/verify-source-capture.mts
 */
import { openrouterChat } from "../src/openrouter.ts"

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set")
  process.exit(1)
}

const PROMPT = `Search the web for: "TSMC CoWoS packaging capacity 2026".
Then return one short sentence and the publication date of the newest source.`

const judges = [
  "google/gemini-2.5-flash:online",
  "perplexity/sonar-reasoning-pro",
]

let anyFailure = false
for (const model of judges) {
  process.stdout.write(`\n${model}:\n`)
  const r = await openrouterChat({
    apiKey,
    model,
    messages: [{ role: "user", content: PROMPT }],
    webSearch: true,
    timeoutMs: 120_000,
  })
  if (!r.success) {
    console.error(`  ERROR ${r.code}: ${r.message}`)
    anyFailure = true
    continue
  }
  const anns = r.annotations ?? []
  const citations = anns.filter((a) => a.type === "url_citation")
  console.log(`  annotations: ${anns.length} total, ${citations.length} url_citation`)
  if (citations.length === 0) {
    console.error(`  ✗ NO CITATIONS — fix isn't working for this model`)
    anyFailure = true
  } else {
    console.log(`  ✓ captured ${citations.length} URLs:`)
    for (const c of citations.slice(0, 3)) {
      console.log(`      - ${c.url_citation.url}`)
    }
    if (citations.length > 3) console.log(`      … +${citations.length - 3} more`)
  }
}

if (anyFailure) process.exit(1)
console.log("\n✓ All probes captured url_citation annotations.")
