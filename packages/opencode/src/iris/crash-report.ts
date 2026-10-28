import { arch as osArch, release as osRelease } from "node:os"

/**
 * The desktop crash screen, reported (#191430).
 *
 * Desktop 1.18.24 → 1.18.152 opened to "Something went wrong" on every Mac with Safari < 17.4
 * (#191428) for two months, and nobody told us: the crash screen sent nothing. The engine kept
 * running the whole time, so the window posts one `app.crash_screen` to /iris/onboarding/track
 * and the engine forwards it on the same pipe as the onboarding funnel.
 *
 * This file is the engine's half: it does not trust the window. Only the keys below are kept,
 * every string is clipped and scrubbed again (paths, emails, URL queries), and the machine facts
 * the window cannot see (OS release, arch) are added here. The result must fit fl-iris-api's
 * `props` bag (≤ 20 keys, ≤ 2000 bytes of JSON — anything larger is stored as NULL), so stack
 * frames are dropped from the end until it fits.
 *
 * The props shape is per event so the boot funnel (#191431) can add its own list next to this.
 */
export const CRASH_EVENT = "app.crash_screen"

/** fl-iris-api stores props as NULL when the JSON is longer than this. Leave headroom for attr_source. */
export const PROPS_MAX_BYTES = 1900
export const MAX_FRAMES = 20

const LIMITS = {
  app_version: 32,
  os: 16,
  webview: 256,
  error_name: 64,
  message: 300,
  route: 120,
  boundary: 16,
} as const

export type CrashProps = {
  app_version?: string
  os?: string
  webview?: string
  error_name?: string
  message?: string
  route?: string
  boundary?: string
  stack: string[]
  os_release: string
  os_version?: string
  arch: string
}

/**
 * Paths, emails and URL queries out. A bundle asset URL (tauri://localhost/assets/index-x.js:1:2)
 * survives; a file:// URL, /Users/…, /home/…, C:\… or ~/… does not.
 */
export function scrub(text: string): string {
  return text
    .replace(/file:\/\/[^\s)'"]*/gi, "<path>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]*)[?#][^\s:)'"]*/gi, "$1")
    .replace(/[A-Za-z]:\\[^\s:)'"]*/g, "<path>")
    .replace(/(^|[\s('"=@])~\/[^\s:)'"]*/g, "$1<path>")
    .replace(/(^|[\s('"=@])\/(?:Users|home|root|var|private|tmp|Volumes|opt|etc|mnt|media|Applications|Library)\/[^\s:)'"]*/g, "$1<path>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const s = scrub(value).trim()
  return s ? s.slice(0, max) : undefined
}

/** "22.6.0" (Darwin) → "13". Darwin 20+ is macOS (major − 9); older Darwin is 10.(major − 4). */
export function macosVersion(release: string): string | undefined {
  const major = Number.parseInt(release, 10)
  if (!Number.isFinite(major) || major < 9) return undefined
  return major >= 20 ? String(major - 9) : `10.${major - 4}`
}

export function crashProps(
  raw: unknown,
  sys: { platform: string; release: string; arch: string } = {
    platform: process.platform,
    release: osRelease(),
    arch: osArch(),
  },
): CrashProps {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const stack = (Array.isArray(r.stack) ? r.stack : [])
    .filter((f): f is string => typeof f === "string")
    .slice(0, MAX_FRAMES)
    .map((f) => scrub(f).trim().slice(0, 200))
    .filter(Boolean)

  const props: CrashProps = {
    app_version: clip(r.app_version, LIMITS.app_version),
    os: clip(r.os, LIMITS.os),
    webview: clip(r.webview, LIMITS.webview),
    error_name: clip(r.error_name, LIMITS.error_name),
    message: clip(r.message, LIMITS.message),
    route: clip(r.route, LIMITS.route),
    boundary: clip(r.boundary, LIMITS.boundary),
    stack,
    os_release: sys.release.slice(0, 32),
    os_version: sys.platform === "darwin" ? macosVersion(sys.release) : undefined,
    arch: sys.arch.slice(0, 16),
  }
  for (const k of Object.keys(props) as (keyof CrashProps)[]) if (props[k] === undefined) delete props[k]

  // Fit the server's bag: the oldest frames (the top of the stack) are the ones worth keeping.
  while (JSON.stringify(props).length > PROPS_MAX_BYTES && props.stack.length > 0) props.stack.pop()
  if (JSON.stringify(props).length > PROPS_MAX_BYTES && props.webview) props.webview = props.webview.slice(0, 64)
  return props
}
