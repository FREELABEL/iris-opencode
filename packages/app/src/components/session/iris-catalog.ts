/**
 * How a catalogue row READS (#186542).
 *
 * The registry page at /p/integrations is careful about what each mark claims, and the panel
 * has to be as careful or it will quietly claim more. Two rules carried over from it:
 *
 *   - Health is PLATFORM reachability, measured with no credential attached. "Reachable" means
 *     the provider answers and our endpoint is still right. It does NOT mean your own
 *     connection works, so the label says "provider" and never "connected".
 *   - ABSENT IS NOT DOWN. Some connectors run on your own machine and some point at an endpoint
 *     only you have; nothing has measured those. A UI that draws unmeasured as a red dot invents
 *     an outage.
 *
 * Pure so it can be tested without mounting Solid.
 */

export type HealthTone = "up" | "down" | "unknown"

export interface HealthRead {
  tone: HealthTone
  /** Short enough for a meta line. */
  label: string
  /** What the mark is evidence of — the tooltip, so the claim travels with the dot. */
  basis: string
}

const NOT_MEASURED =
  "Nothing has measured this one. Some run on your own machine, and some point at an endpoint only you have."
const PLATFORM_BASIS =
  "We ask the provider whether it is answering, with no credential attached. It does not mean your own connection works."

export function healthRead(state: string | undefined): HealthRead {
  switch (state) {
    case "operational":
      return { tone: "up", label: "provider reachable", basis: PLATFORM_BASIS }
    case "degraded":
      return { tone: "down", label: "provider down", basis: PLATFORM_BASIS }
    case "not_applicable":
      return { tone: "unknown", label: "nothing to check", basis: NOT_MEASURED }
    // not_checked, undefined, or anything a newer API adds: say we do not know, not that it is down.
    default:
      return { tone: "unknown", label: "not checked", basis: NOT_MEASURED }
  }
}

/**
 * What connecting actually involves, in words a navigator can act on. The modes are genuinely
 * different jobs, which is why the catalogue carries the mode at all.
 */
export function connectsBy(mode: string | undefined, oauthRequired: boolean): string {
  switch (mode) {
    case "oauth":
      return "Sign in — no key to paste"
    case "brokered":
      return "Sign in, via a connector broker"
    case "key":
      return "An API key, once per workspace"
    case "bridge":
      return "A bridge on this machine"
    default:
      return oauthRequired ? "Sign in — no key to paste" : "An API key, once per workspace"
  }
}

/** The meta line under a name: only the parts that are actually known. */
export function metaLine(input: {
  category?: string
  mode?: string
  oauthRequired: boolean
  functionsCount?: number
  usageBand?: string
}): string {
  const parts: string[] = []
  if (input.category) parts.push(input.category)
  parts.push(connectsBy(input.mode, input.oauthRequired))
  // "0 commands" is a real and useful statement; undefined is "we were not told".
  if (typeof input.functionsCount === "number") {
    parts.push(`${input.functionsCount} ${input.functionsCount === 1 ? "command" : "commands"}`)
  }
  if (input.usageBand) parts.push(input.usageBand)
  return parts.join(" · ")
}

/**
 * Usage is published as a SHAPE, never as a volume: each point is relative to the connector's
 * own busiest day. This turns the series into bar heights in percent, and says whether anything
 * was measured at all — an empty chart and "nobody uses this" are different claims.
 */
export function usageBars(series: { v: number }[] | undefined): { heights: number[]; measured: boolean } {
  const points = series ?? []
  const measured = points.some((p) => (p?.v ?? 0) > 0)
  return {
    heights: points.map((p) => Math.max(Math.round(Math.max(p?.v ?? 0, 0) * 100), 4)),
    measured,
  }
}
