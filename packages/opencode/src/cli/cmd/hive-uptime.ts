/**
 * Reading a node's liveness out of its heartbeat (#182434 — Gap 1).
 *
 * `hive nodes list` showed ONLINE for a machine that was crash-looping every thirty seconds,
 * because the cloud marks a node offline only when it MISSES heartbeats and a looping daemon
 * heartbeats once per restart — it never misses one. Work kept being dispatched there, landed
 * mid-crash, and hung to timeout, which reads as a broken transport rather than a machine that
 * went away.
 *
 * Two rules run through everything here:
 *
 *  1. A RESET is the signal, not the number. One reading of "up 12s" cannot separate a
 *     legitimate fresh restart from a loop. The hub sees the sequence of beats and records the
 *     restarts it observed; this renders them.
 *  2. NOT MEASURED must never render as a measurement. An older daemon sends no uptime at all,
 *     and showing that as "up 0s" would be a fresh instance of the exact bug being closed.
 *     `describeUptime` returns a distinct `unknown` state, never a zero.
 */

/** What the fleet view can say about a node's liveness. */
export type UptimeState =
  | { kind: "unknown"; reason: string }
  | { kind: "stable"; label: string }
  | { kind: "looping"; label: string; restarts: number; windowLabel: string }

/** Restarts within this window make a node "looping" rather than merely recently restarted. */
export const LOOP_WINDOW_MS = 15 * 60 * 1000

/**
 * Two restarts inside the window. One restart is a deploy, an update, a laptop lid.
 * Two or more in fifteen minutes is a machine that is not staying up.
 */
export const LOOP_THRESHOLD = 2

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?"
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** How many of these observed-restart timestamps fall inside the window ending at `now`. */
export function restartsInWindow(
  recent: unknown,
  now: number,
  windowMs: number = LOOP_WINDOW_MS,
): number {
  if (!Array.isArray(recent)) return 0
  let n = 0
  for (const entry of recent) {
    if (typeof entry !== "string") continue
    const t = Date.parse(entry)
    // An unparseable entry is not counted. Guessing at it would manufacture a crash report.
    if (Number.isNaN(t)) continue
    if (now - t <= windowMs && now - t >= 0) n++
  }
  return n
}

/**
 * Turn a node's heartbeat metadata into something a person can act on.
 *
 * `online` matters because absence means different things either side of it: a node we cannot
 * reach at all is not "an old daemon", it is a node that is not talking.
 */
export function describeUptime(
  node: { uptime_seconds?: unknown; started_at?: unknown; recent_restarts?: unknown; connection_status?: unknown },
  now: number,
): UptimeState {
  const restarts = restartsInWindow(node.recent_restarts, now)
  const windowLabel = formatDuration(LOOP_WINDOW_MS / 1000)

  const raw = node.uptime_seconds
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN

  if (!Number.isFinite(seconds) || seconds < 0) {
    // Say WHICH kind of not-knowing this is. "No data" and "old daemon" send a reader to
    // different places, and collapsing them is how months of false "bridge is offline" happened.
    return {
      kind: "unknown",
      reason:
        node.connection_status === "online"
          ? "daemon predates uptime reporting — cannot tell a crash loop from a healthy node; update it"
          : "not reporting",
    }
  }

  const label = `up ${formatDuration(seconds)}`

  if (restarts >= LOOP_THRESHOLD) {
    return { kind: "looping", label, restarts, windowLabel }
  }
  return { kind: "stable", label }
}
