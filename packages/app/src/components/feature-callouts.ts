/**
 * "New" callouts (#193866): a small card that points at the control it announces.
 *
 * The list lives here for now. Its shape is the one a published feed will use, so moving it
 * to a feed later is a fetch, not a rewrite:
 *   id         stable, never reused; it is what "seen" remembers
 *   targets    data-callout ids, first one on screen wins (a fallback for when the control
 *              itself is hidden, e.g. the + inside a closed panel)
 *   minVersion never shown on an app older than this, so it cannot point at a control the
 *              installed app does not have
 *   until      stop showing after this date (ISO), so old news retires itself
 */
export type Callout = {
  id: string
  title: string
  body: string
  targets: string[]
  minVersion?: string
  until?: string
}

export const CALLOUTS: Callout[] = [
  {
    id: "2026-11-model-details",
    title: "See what each model is good at",
    body: "Open the model menu and point at a model: what it's good for, what it costs, how fast it is, its public score and how people use it on IRIS.",
    targets: ["model-picker"],
    minVersion: "1.18.231",
    until: "2027-03-01",
  },
  {
    id: "2026-11-tab-search",
    title: "Find any tab by typing",
    body: "Open + in the IRIS panel and start typing. Terminal, MCP, Drives and every other tab are a few letters away.",
    targets: ["add-tab", "iris-panel"],
    minVersion: "1.18.211",
    until: "2027-02-01",
  },
  {
    id: "2026-11-terminal",
    title: "A terminal, right beside your chat",
    body: "Add the Terminal tab from + to run commands next to IRIS. It works from Home too, no project needed.",
    targets: ["add-tab", "iris-panel"],
    minVersion: "1.18.211",
    until: "2027-02-01",
  },
]

/** -1, 0 or 1. Missing parts count as 0; a non-numeric part (a dev build) compares as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(/[.+-]/)
  const pb = b.replace(/^v/i, "").split(/[.+-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = Number.parseInt(pa[i] ?? "0", 10) || 0
    const y = Number.parseInt(pb[i] ?? "0", 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * The callout to show now, and the control to point at — or undefined.
 * `version` undefined means a dev or browser build: version gates do not apply there.
 */
export function pickCallout(input: {
  callouts: Callout[]
  seen: string[]
  version?: string
  now: Date
  onScreen: (target: string) => boolean
}): { callout: Callout; target: string } | undefined {
  const seen = new Set(input.seen)
  for (const callout of input.callouts) {
    if (seen.has(callout.id)) continue
    if (callout.until && input.now >= new Date(callout.until)) continue
    if (callout.minVersion && input.version && compareVersions(input.version, callout.minVersion) < 0) continue
    const target = callout.targets.find(input.onScreen)
    if (target) return { callout, target }
  }
  return undefined
}

export type Rect = { top: number; left: number; width: number; height: number }

/**
 * Where the card goes: below the control, kept inside the window with a margin, with the
 * arrow's x measured from the card's left edge so it still points at the control when the
 * card had to slide. Flips above when there is no room below.
 */
export function placeCallout(input: {
  target: Rect
  card: { width: number; height: number }
  viewport: { width: number; height: number }
  gap?: number
  margin?: number
}) {
  const gap = input.gap ?? 10
  const margin = input.margin ?? 12
  const { target, card, viewport } = input
  const centre = target.left + target.width / 2
  const maxLeft = Math.max(margin, viewport.width - card.width - margin)
  const left = Math.min(Math.max(centre - card.width / 2, margin), maxLeft)
  const below = target.top + target.height + gap
  const above = target.top - gap - card.height
  const side: "below" | "above" = below + card.height + margin <= viewport.height || above < margin ? "below" : "above"
  const top = side === "below" ? below : above
  const arrow = Math.min(Math.max(centre - left, 16), card.width - 16)
  return { top, left, arrow, side }
}
