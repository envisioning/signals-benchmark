#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Selectively invalidate verifier-cache entries that were written
 * before the openrouter.ts annotation-path fix (Nov 2025). Those
 * entries have `value.sources: []` even when the verdict implies
 * the judge cited real sources (`grounded` / `indicative` /
 * `speculative` — verdicts that are only reachable via the
 * web-grounded judge prompt).
 *
 * Deletes the matching JSON files from `cache/verifier/`. The
 * specificity cache is untouched (the specificity judge doesn't
 * surface sources anyway). Next benchmark run will re-fetch only the
 * invalidated verifier calls.
 *
 * Default is a dry-run; pass --apply to actually delete files.
 *
 * Cost implication: each invalidated entry costs ~$0.012 to re-fetch
 * on next run (gemini-2.5-flash:online with web search). On the
 * 2026-05-13 run that's ~4737 × $0.012 ≈ $57 if every entry needs
 * re-fetching. Cheaper than bumping RUBRIC_VERSION (which would also
 * invalidate specificity cache).
 *
 * Run: node --experimental-strip-types scripts/invalidate-empty-sources.mts [--apply]
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { resolve, join } from "node:path"

const CACHE_ROOT = resolve(process.cwd(), "cache", "verifier")
const APPLY = process.argv.includes("--apply")

// Verdicts where the judge would be expected to cite sources. If a
// cached entry has one of these verdicts but `sources: []`, it pre-
// dates the bug fix.
const VERDICTS_WITH_SOURCES = new Set([
  "grounded",
  "indicative",
  "speculative",
])

type CacheEntry = {
  key: { judge_model?: string; brief_id?: string }
  value: { verdict?: string; sources?: unknown[] }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (name.endsWith(".json")) {
      out.push(full)
    }
  }
  return out
}

function main() {
  if (!APPLY) {
    console.log("Dry run — pass --apply to actually delete files.\n")
  }
  const files = walk(CACHE_ROOT)
  let kept = 0
  let toRemove = 0
  let totalBytes = 0
  const byVerdict = new Map<string, number>()
  const byJudge = new Map<string, number>()

  for (const f of files) {
    let entry: CacheEntry
    try {
      entry = JSON.parse(readFileSync(f, "utf-8"))
    } catch {
      console.warn(`  skip unreadable: ${f}`)
      kept++
      continue
    }
    const verdict = entry.value?.verdict ?? "<missing>"
    const sources = Array.isArray(entry.value?.sources)
      ? entry.value!.sources!
      : []
    if (VERDICTS_WITH_SOURCES.has(verdict) && sources.length === 0) {
      toRemove++
      byVerdict.set(verdict, (byVerdict.get(verdict) ?? 0) + 1)
      const judge = entry.key?.judge_model ?? "<unknown>"
      byJudge.set(judge, (byJudge.get(judge) ?? 0) + 1)
      try {
        totalBytes += statSync(f).size
      } catch {}
      if (APPLY) unlinkSync(f)
    } else {
      kept++
    }
  }

  console.log(`Scanned: ${files.length} verifier cache entries`)
  console.log(`Kept:    ${kept}`)
  console.log(`${APPLY ? "Removed" : "Would remove"}: ${toRemove}`)
  console.log(`Bytes ${APPLY ? "freed" : "to free"}: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log("\nBy verdict:")
  for (const [v, n] of [...byVerdict.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.padEnd(14)} ${n}`)
  }
  console.log("\nBy judge_model:")
  for (const [j, n] of [...byJudge.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${j.padEnd(40)} ${n}`)
  }

  if (!APPLY && toRemove > 0) {
    console.log("\nRe-run with --apply to delete these files.")
  }
}

main()
