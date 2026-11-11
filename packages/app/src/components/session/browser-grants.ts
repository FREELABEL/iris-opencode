/**
 * What the person has let IRIS do in the Browser pane, per site (#193145 read, #193186 act).
 *
 * THE CHECK LIVES HERE, IN THE APP, not in the engine. The agent runs in the engine; the buttons
 * that grant a site and the code that enforces them are both on the person's side of the line,
 * where no tool call can reach.
 *
 * Two levels per site (origin): READ (B1) and ACT (B2: click, type, select). The person's one
 * Allow grants both (one click, not three: people asked IRIS to do something there). The levels
 * stay separate in storage so grants from the read-only build (v1, a list of origins) come back
 * read-only: a site allowed before clicking existed never becomes clickable by itself.
 *
 * Plus the person's controls while the agent works:
 *  - Take over: the agent's next act on that site is refused until Hand back. Reading continues.
 *  - Stop: the site's grant is revoked, read and act.
 *  - Confirm: an irreversible click (Book, Pay, Send…) waits for the person's Allow once. The
 *    tool's own `confirm: true` is the agent vouching for itself; in the person's signed-in pane
 *    the person decides.
 */
import { createSignal } from "solid-js"

const KEY_V1 = "iris.browser.grants.v1"
const KEY = "iris.browser.grants.v2"
const MAX = 200

export type Grant = { origin: string; act: boolean }
export type PageMode = "read" | "act"

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

/** v1 was a list of origins (read-only); v2 is {origin, act}. Defensive: storage may hold junk. */
export function parseGrants(raw: string | null | undefined, legacy?: string | null): Grant[] {
  const out: Grant[] = []
  const add = (g: Grant) => {
    if (!originOf(g.origin) || out.some((x) => x.origin === g.origin)) return
    out.push(g)
  }
  try {
    const v = raw ? JSON.parse(raw) : undefined
    if (Array.isArray(v)) {
      for (const g of v) if (g && typeof g.origin === "string") add({ origin: g.origin, act: g.act === true })
    }
  } catch {}
  try {
    const v1 = legacy ? JSON.parse(legacy) : undefined
    if (Array.isArray(v1)) for (const o of v1) if (typeof o === "string") add({ origin: o, act: false })
  } catch {}
  return out.slice(-MAX)
}

const load = () => {
  try {
    return parseGrants(globalThis.localStorage?.getItem(KEY), globalThis.localStorage?.getItem(KEY_V1))
  } catch {
    return []
  }
}

const [grants, setGrantsRaw] = createSignal<Grant[]>(load())
const save = (next: Grant[]) => {
  setGrantsRaw(next)
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
  } catch {}
}

export const browserGrants = grants

export function isGranted(origin: string | undefined, mode: PageMode = "read", list = grants()): boolean {
  if (!origin) return false
  const g = list.find((x) => x.origin === origin)
  return !!g && (mode === "read" || g.act)
}

/** Allow a site. `act` adds clicking/typing; it never removes it (Stop does). */
export function grantSite(origin: string, act = false) {
  if (!originOf(origin)) return
  const cur = grants().find((x) => x.origin === origin)
  if (declined?.origin === origin) declined = undefined
  if (cur && (cur.act || !act)) return clearAsked(origin)
  save([...grants().filter((x) => x.origin !== origin), { origin, act: act || !!cur?.act }].slice(-MAX))
  clearAsked(origin)
}

/** Stop: the site's grant goes, read and act, and any take-over or prompt for it ends. */
export function revokeSite(origin: string) {
  save(grants().filter((x) => x.origin !== origin))
  handBack(origin)
  const a = asked()
  if (a?.origin === origin) {
    a.resolve?.(false)
    setAsked(undefined)
  }
  setActivity(undefined)
}

// ── Take over ────────────────────────────────────────────────────────────────────────────────
const [takenOver, setTakenOver] = createSignal<string[]>([])
export const takenOverSites = takenOver
export function takeOver(origin: string) {
  if (!takenOver().includes(origin)) setTakenOver([...takenOver(), origin])
  setActivity(undefined)
}
export function handBack(origin: string) {
  setTakenOver(takenOver().filter((o) => o !== origin))
}

// ── What the agent asked for, shown in the strip ─────────────────────────────────────────────
export type Ask =
  | { origin: string; kind: "read" | "act"; resolve?: undefined; label?: undefined }
  | { origin: string; kind: "confirm"; label: string; resolve: (ok: boolean) => void }
const [asked, setAsked] = createSignal<Ask>()
export const askedSite = asked
export function noteAsked(origin: string, kind: "read" | "act") {
  const a = asked()
  if (a?.kind === "confirm") return // a pending confirm outranks a refused ask
  setAsked({ origin, kind })
}
function clearAsked(origin: string) {
  const a = asked()
  if (a && a.origin === origin && a.kind !== "confirm") setAsked(undefined)
}
export function dismissAsked() {
  const a = asked()
  a?.resolve?.(false)
  if (a && a.kind !== "confirm") declined = { origin: a.origin, at: Date.now() }
  setAsked(undefined)
}

/** "Not now" is an answer: the agent waiting for Allow stops instead of asking again for a minute. */
let declined: { origin: string; at: number } | undefined
export function recentlyDeclined(origin: string | undefined, now = Date.now()): boolean {
  return !!origin && declined?.origin === origin && now - declined.at < 60_000
}

/**
 * Ask the person to allow ONE irreversible click. Resolves false on Deny, on Stop, on another
 * confirm replacing it, or after `timeoutMs` with no answer: silence is a no.
 */
export function confirmAct(origin: string, label: string, timeoutMs = 60_000): Promise<boolean> {
  asked()?.resolve?.(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (asked()?.kind === "confirm" && asked()?.label === label) setAsked(undefined)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    setAsked({ origin, kind: "confirm", label, resolve: finish })
  })
}
export function answerConfirm(ok: boolean) {
  const a = asked()
  if (a?.kind === "confirm") a.resolve(ok)
}

// ── What the agent is doing right now: the control strip's text. Clears itself. ──────────────
export type Activity = { origin: string; doing: string; mode: PageMode; at: number }
const [activity, setActivity] = createSignal<Activity>()
export const browserActivity = activity
let clear: ReturnType<typeof setTimeout> | undefined
export function noteActivity(origin: string, doing: string, mode: PageMode = "read") {
  setActivity({ origin, doing, mode, at: Date.now() })
  clearTimeout(clear)
  clear = setTimeout(() => setActivity(undefined), mode === "act" ? 6000 : 2500)
}

/** The one decision, pure: may the agent run this page operation now? */
export function pageRefusal(input: {
  mode: PageMode
  url: string | undefined
  grants: Grant[]
  takenOver?: string[]
}): string | undefined {
  const origin = originOf(input.url)
  if (!origin) return "the Browser pane has no web page open: open one first"
  const host = hostOf(origin)
  if (!isGranted(origin, "read", input.grants)) {
    return `the person hasn't let IRIS use ${host} yet. Ask them to click Allow in the Browser bar (it is showing now), then try again`
  }
  if (input.mode === "act") {
    if (!isGranted(origin, "act", input.grants)) {
      return `the person allowed IRIS to READ ${host}, not to click or type there. Ask them to click Allow in the Browser bar (it is showing now), then try again`
    }
    if (input.takenOver?.includes(origin)) {
      return `the person took over on ${host}: wait until they hand back before clicking or typing there`
    }
  }
  return undefined
}

/** What the strip under the Browser bar shows for the page on screen, most urgent first. */
export type StripState =
  | "confirm" // an irreversible click is waiting for Allow once
  | "ask-read" // the agent was refused: offer Allow
  | "ask-act" // the agent may read but was refused a click: offer Allow clicking
  | "taken" // the person has the wheel: offer Hand back
  | "acting" // the agent is clicking/typing right now: Take over · Stop
  | "reading" // the agent is reading right now
  | "can-act" // idle, allowed to read and act
  | "can-read" // idle, allowed to read
  | "off" // nothing allowed: offer Let IRIS use this page

export function stripState(input: {
  origin: string | undefined
  grants: Grant[]
  asked?: Ask
  takenOver?: string[]
  activity?: Activity
}): StripState | undefined {
  const o = input.origin
  if (!o) return undefined
  const a = input.asked?.origin === o ? input.asked : undefined
  if (a?.kind === "confirm") return "confirm"
  if (input.takenOver?.includes(o)) return "taken"
  if (a?.kind === "read" && !isGranted(o, "read", input.grants)) return "ask-read"
  if (a?.kind === "act" && !isGranted(o, "act", input.grants)) return "ask-act"
  if (!isGranted(o, "read", input.grants)) return "off"
  const busy = input.activity?.origin === o ? input.activity : undefined
  if (busy) return busy.mode === "act" ? "acting" : "reading"
  return isGranted(o, "act", input.grants) ? "can-act" : "can-read"
}
