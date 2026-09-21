/**
 * Turning a server allowance notice into something a person reads.
 *
 * SEPARATE FROM THE RENDERING ON PURPOSE. Everything that can be wrong here — the percentage,
 * the money, when it resets, whether to show anything at all — is decidable without a browser,
 * and therefore testable without one. The component that calls this has no logic left to get
 * wrong.
 *
 * NOTHING ABOUT THE POLICY IS WRITTEN HERE. Not 90, not $5, not "week". Every number arrives
 * from fl-iris-api's config/allowance.php, because the desktop ships on its own release cadence
 * and a threshold compiled in is a threshold we cannot change without a build. See bloq item
 * #186459 and ticket #186457.
 */

export interface ServerNotice {
  threshold: number
  fraction: number
  spendUsd: number
  capUsd: number
  window: string
  resetsAt: string
  upgradeUrl: string | null
}

export interface NoticeCopy {
  title: string
  description: string
  link: string | null
  label: string
}

const money = (n: number) => `$${n.toFixed(2)}`

/**
 * When the allowance comes back, in words a person can act on.
 *
 * Returns null rather than "soon" when the instant is missing or unparseable. A reset time we
 * cannot state is worse than no reset time: "resets soon" reads as a promise and is not one.
 */
export function resetPhrase(resetsAt: string, now: Date = new Date()): string | null {
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const ms = at - now.getTime()
  if (ms <= 0) return null
  const hours = ms / 3_600_000
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (hours < 24) return `in ${Math.round(hours)}h`
  const days = Math.round(hours / 24)
  // A weekday is more useful than "in 6 days" for a window that resets on a fixed day, and
  // the caller's locale formats it.
  if (days <= 7) return `on ${new Date(at).toLocaleDateString(undefined, { weekday: "long" })}`
  return `in ${days} days`
}

export function noticeCopy(notice: ServerNotice | null | undefined, now: Date = new Date()): NoticeCopy | null {
  if (!notice) return null
  if (!Number.isFinite(notice.capUsd) || notice.capUsd <= 0) return null

  // The percentage is where they ARE, not the rung that fired. Someone at 96% who is told
  // "you have reached 90%" is being given a number that is true and useless.
  const pct = Math.min(100, Math.round(notice.fraction * 100))
  const reset = resetPhrase(notice.resetsAt, now)

  const parts = [`${money(notice.spendUsd)} of ${money(notice.capUsd)} used this ${notice.window}.`]
  if (reset) parts.push(`Resets ${reset}.`)

  return {
    title: `You're at ${pct}% of this ${notice.window}'s allowance`,
    description: parts.join(" "),
    link: notice.upgradeUrl,
    label: "See plans",
  }
}
