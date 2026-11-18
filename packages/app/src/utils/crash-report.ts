/**
 * The crash screen reports itself (#191430).
 *
 * Desktop 1.18.24 → 1.18.152 opened to "Something went wrong" on every Mac with Safari < 17.4
 * (#191428) for two months and nobody told us: the screen offered a Discord link and sent
 * nothing. The engine kept running throughout, so when the top-level error boundary renders,
 * the window posts ONE `app.crash_screen` to the engine's onboarding pipe
 * (/iris/onboarding/track), which adds the install id and the OS facts and forwards it.
 *
 * What travels: app version, OS name, the webview's user agent, the error's name and message,
 * the first 20 stack frames, and the route as a pattern (/:id/session/:id — a directory route is
 * a base64 path, so the real segments never leave). Paths, emails and URL queries are scrubbed
 * here and again in the engine. Never prompts, user content, or the person's account.
 *
 * Rules: at most once per app version + error message per install (localStorage); never throws;
 * never waits — fire and forget with a short timeout. The telemetry off switch is the engine's
 * to read (`iris telemetry off`, IRIS_TELEMETRY=0, DO_NOT_TRACK=1, IRIS_NO_TELEMETRY=1).
 *
 * The request shape is `{ event, props }` so the boot funnel (#191431) can send its own events
 * the same way.
 */
export const CRASH_EVENT = "app.crash_screen"
export const TRACK_PATH = "/iris/onboarding/track"
export const MAX_FRAMES = 20
export const SENT_KEY = "iris.crash-report.sent"
const TIMEOUT_MS = 2500

export type CrashProps = {
  app_version?: string
  os?: string
  webview?: string
  error_name?: string
  message?: string
  stack: string[]
  route: string
  boundary: "app"
}

export type CrashReport = { event: typeof CRASH_EVENT; props: CrashProps }

/** The engine's scrub, mirrored so nothing sensitive is even sent to localhost. */
export function scrub(text: string): string {
  return text
    .replace(/file:\/\/[^\s)'"]*/gi, "<path>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]*)[?#][^\s:)'"]*/gi, "$1")
    .replace(/[A-Za-z]:\\[^\s:)'"]*/g, "<path>")
    .replace(/(^|[\s('"=@])~\/[^\s:)'"]*/g, "$1<path>")
    .replace(/(^|[\s('"=@])\/(?:Users|home|root|var|private|tmp|Volumes|opt|etc|mnt|media|Applications|Library)\/[^\s:)'"]*/g, "$1<path>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
}

// Route segments that are the app's own words. Everything else (a base64 directory, a session
// id, a server key) is an identifier and becomes ":id".
const ROUTE_WORDS = new Set(["session", "server", "new-session", "settings"])

export function routePattern(pathname: string | undefined): string {
  if (!pathname) return "/"
  const parts = pathname.split(/[?#]/)[0].split("/").filter(Boolean)
  return "/" + parts.map((p) => (ROUTE_WORDS.has(p) ? p : ":id")).join("/")
}

export function stackFrames(stack: unknown, max = MAX_FRAMES): string[] {
  if (typeof stack !== "string") return []
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && (l.startsWith("at ") || l.includes("@") || /:\d+:\d+\)?$/.test(l)))
    .slice(0, max)
    .map((l) => scrub(l).slice(0, 200))
}

function errorParts(error: unknown): { name?: string; message?: string; stack?: unknown } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  if (typeof error === "string") return { message: error }
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>
    // An InitError's `data` can hold config paths and provider responses: send its name only.
    const message = typeof e.message === "string" ? e.message : undefined
    return { name: typeof e.name === "string" ? e.name : undefined, message, stack: e.stack }
  }
  return { message: String(error) }
}

export function buildCrashReport(
  error: unknown,
  ctx: { version?: string; os?: string; userAgent?: string; pathname?: string },
): CrashReport {
  const e = errorParts(error)
  const props: CrashProps = {
    app_version: ctx.version?.slice(0, 32),
    os: ctx.os?.slice(0, 16),
    webview: ctx.userAgent ? scrub(ctx.userAgent).slice(0, 256) : undefined,
    error_name: e.name?.slice(0, 64),
    message: e.message ? scrub(e.message).slice(0, 300) : undefined,
    stack: stackFrames(e.stack),
    route: routePattern(ctx.pathname),
    boundary: "app",
  }
  for (const k of Object.keys(props) as (keyof CrashProps)[]) if (props[k] === undefined) delete props[k]
  return { event: CRASH_EVENT, props }
}

/** FNV-1a: the dedupe key without keeping the message text in storage. */
export function crashKey(version: string | undefined, message: string | undefined): string {
  let h = 0x811c9dc5
  for (const c of `${version ?? ""}\u0000${message ?? ""}`) {
    h ^= c.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

/** Records the key and says whether it was new. Storage that throws counts as new (report once more, never zero). */
function firstTime(storage: Storage | undefined, key: string): boolean {
  try {
    if (!storage) return true
    const seen: unknown = JSON.parse(storage.getItem(SENT_KEY) ?? "[]")
    const list = Array.isArray(seen) ? seen.filter((x): x is string => typeof x === "string") : []
    if (list.includes(key)) return false
    storage.setItem(SENT_KEY, JSON.stringify([...list, key].slice(-50)))
    return true
  } catch {
    return true
  }
}

export type ReportOptions = {
  engineUrl?: string
  fetch?: typeof globalThis.fetch
  storage?: Storage
  version?: string
  os?: string
  userAgent?: string
  pathname?: string
  timeoutMs?: number
}

export type ReportResult = "sent" | "duplicate" | "no-engine" | "failed"

/**
 * Report the crash screen once. Never throws, never rejects; resolves when the engine answered
 * or the timeout passed. The caller should not await it.
 */
export async function reportCrashOnce(error: unknown, opts: ReportOptions): Promise<ReportResult> {
  try {
    if (!opts.engineUrl) return "no-engine"
    const report = buildCrashReport(error, opts)
    if (!firstTime(opts.storage, crashKey(opts.version, report.props.message))) return "duplicate"
    // AbortSignal.timeout is Safari 16+; the crash screen must work on anything older.
    const controller = typeof AbortController === "function" ? new AbortController() : undefined
    const timer = setTimeout(() => controller?.abort(), opts.timeoutMs ?? TIMEOUT_MS)
    try {
      const res = await (opts.fetch ?? globalThis.fetch)(`${opts.engineUrl.replace(/\/$/, "")}${TRACK_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
        signal: controller?.signal,
      })
      return res.ok ? "sent" : "failed"
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return "failed"
  }
}
