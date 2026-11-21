/**
 * Currency — how recent a signal's supporting evidence is, measured
 * against the day the leaderboard is scored (today), not the day the
 * model wrote the signal.
 *
 * Why today: the leaderboard answers "which model gives a buyer current
 * signals now". A run generated in May keeps May's evidence, so its
 * currency falls as the months pass. The fix for a stale row is a new
 * generation (`pnpm bench:refresh`), not a kinder baseline.
 *
 * Sources dated after the generation are clamped to the generation
 * time. The judge searches the web at judging time and can find
 * articles the model could not have seen. Without the clamp, a model
 * judged later gets credit for that evidence.
 *
 * Kept dependency-free: score.ts, evaluate.ts and publish.ts all use it.
 */

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44

/** A generation older than this is flagged as stale in the report. */
export const STALE_AFTER_DAYS = 90

export function currencyScore(
  newestDateIso: string | undefined,
  {
    asOf = Date.now(),
    generatedAt,
  }: {
    /** The scoring day. Default: now. */
    asOf?: number
    /** When the model generated the signal. Sources after it are clamped. */
    generatedAt?: number
  } = {}
): number {
  if (!newestDateIso) return 0
  let t = Date.parse(newestDateIso)
  if (Number.isNaN(t)) return 0
  if (generatedAt !== undefined && !Number.isNaN(generatedAt) && t > generatedAt) {
    t = generatedAt
  }
  const monthsAgo = (asOf - t) / MS_PER_MONTH
  if (monthsAgo <= 3) return 100
  if (monthsAgo <= 6) return 85
  if (monthsAgo <= 12) return 70
  if (monthsAgo <= 18) return 50
  if (monthsAgo <= 24) return 30
  return 10
}

export function ageDays(iso: string, asOf: number = Date.now()): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return Number.NaN
  return Math.floor((asOf - t) / (1000 * 60 * 60 * 24))
}
