/**
 * Which sites the person has let IRIS use in the Browser pane (#193145, epic #193144 Q1).
 *
 * THE CHECK LIVES HERE, IN THE APP, not in the engine. The agent runs in the engine; the button
 * that grants a site and the code that enforces it are both on the person's side of the line,
 * where no tool call can reach. A grant is per SITE (origin) and lasts until the person revokes
 * it (epic Q2 may narrow that to one chat): Stop in the Browser bar revokes it at once.
 *
 * Plus two pieces of UI state the bar draws: a site the agent ASKED for and was refused (so the
 * bar can offer Allow right there), and what the agent is doing right now (the control strip).
 */
import { createSignal } from "solid-js"

const KEY = "iris.browser.grants.v1"
const MAX = 200

export function originOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined
  } catch {
    return undefined
  }
}

export function hostOf(origin: string | undefined): string {
  if (!origin) return ""
  try {
    return new URL(origin).hostname.replace(/^www\./, "")
  } catch {
    return origin
  }
}

/** Read defensively: storage can be absent, full, or hold something an older build wrote. */
export function parseGrants(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((o): o is string => typeof o === "string" && !!originOf(o)).slice(-MAX) : []
  } catch {
    return []
  }
}

const load = () => {
  try {
    return parseGrants(globalThis.localStorage?.getItem(KEY))
  } catch {
    return []
  }
}

const [grants, setGrantsRaw] = createSignal<string[]>(load())
const save = (next: string[]) => {
  setGrantsRaw(next)
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
  } catch {}
}

export const browserGrants = grants
export function isGranted(origin: string | undefined, list = grants()): boolean {
  return !!origin && list.includes(origin)
}
export function grantSite(origin: string) {
  if (!originOf(origin) || isGranted(origin)) return
  save([...grants(), origin].slice(-MAX))
  if (asked() === origin) setAsked(undefined)
}
export function revokeSite(origin: string) {
  save(grants().filter((o) => o !== origin))
  setActivity(undefined)
}

/** A site the agent asked to use and was refused: the bar offers Allow for it. */
const [asked, setAsked] = createSignal<string>()
export const askedSite = asked
export function noteAsked(origin: string) {
  setAsked(origin)
}
export function dismissAsked() {
  setAsked(undefined)
}

/** What the agent is doing in the pane right now: the control strip's text. Clears itself. */
export type Activity = { origin: string; doing: string; at: number }
const [activity, setActivity] = createSignal<Activity>()
export const browserActivity = activity
let clear: ReturnType<typeof setTimeout> | undefined
export function noteActivity(origin: string, doing: string, holdMs = 2500) {
  setActivity({ origin, doing, at: Date.now() })
  clearTimeout(clear)
  clear = setTimeout(() => setActivity(undefined), holdMs)
}

/**
 * The one decision, pure: may the agent run this page operation now?
 * `act` (click, type, select) is refused outright until B2 ships it.
 */
export function pageRefusal(input: {
  mode: "read" | "act"
  url: string | undefined
  granted: string[]
}): string | undefined {
  if (input.mode === "act") return "acting in the Browser pane (click, type, select) isn't available yet; it can only read"
  const origin = originOf(input.url)
  if (!origin) return "the Browser pane has no web page open: open one first"
  if (!input.granted.includes(origin)) {
    return `the person hasn't let IRIS use ${hostOf(origin)}. Ask them to click "Let IRIS use this page" in the Browser bar (it is showing an Allow button now), then try again`
  }
  return undefined
}
