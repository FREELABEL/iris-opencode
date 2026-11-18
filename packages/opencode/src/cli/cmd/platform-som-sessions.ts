// Whose Instagram login is in a session file — the checks `iris som push-sessions` and
// `pull-sessions` make before a session moves between this machine and the cloud (#191640).
//
// The cloud used to keep ONE Instagram login per board. @thediscoverpage_ and @freelabelnet both
// run on board 80, so a push overwrote one account's login with the other's and a pull wrote
// @freelabelnet's session into instagram-auth-thediscoverpage_.json (#191635). Sessions are now
// keyed by handle, and a session only moves when it proves it is that handle: the daemon's
// "verified as" stamp (iris-daemon som/helpers/ig-accounts.js writes it after it saw which account
// was logged in), and the session's own ds_user_id still the stamped login. Same rule as the daemon's
// pulledSessionProblem() and the API's ProjectCredential::handleProblem().
//
// Pure apart from the file helpers; nothing here prints or logs a cookie.

import * as fs from "fs"
import * as pathNode from "path"

export const STAMP_KEY = "iris_verified"

export type StorageState = { cookies?: Array<{ name?: string; value?: string; domain?: string }>; [k: string]: unknown }

export function normalizeHandle(h: unknown): string {
  return String(h ?? "").trim().replace(/^@+/, "").trim().toLowerCase()
}

/** The logged-in Instagram user id (ds_user_id cookie on instagram.com), or "". */
export function sessionUserId(state: StorageState | null | undefined): string {
  const c = (state?.cookies ?? []).find(
    (k) => k && k.name === "ds_user_id" && /(^|\.)instagram\.com$/.test(String(k.domain ?? "").replace(/^\./, "")),
  )
  return c?.value ? String(c.value) : ""
}

/** "" when `state` may travel as @handle, else why not. */
export function sessionProblem(handle: string, state: StorageState | null | undefined): string {
  const h = normalizeHandle(handle)
  const userId = sessionUserId(state)
  const stamp = (state as any)?.[STAMP_KEY]
  if (!userId) return `the session for @${h} is not logged in (no ds_user_id cookie)`
  if (!stamp || !normalizeHandle(stamp.handle)) return `the session for @${h} was never verified as @${h} — nothing proves whose login it is`
  const stamped = normalizeHandle(stamp.handle)
  if (stamped !== h) return `the session for @${h} is @${stamped}'s login`
  if (String(stamp.userId ?? "") !== userId) return `the session for @${h} no longer holds the login that was verified as @${h}`
  return ""
}

const AUTH_RE = /^instagram-auth-(.+)\.json$/

/** Another handle whose local auth file (in any of `dirs`) holds the same Instagram login, or null. */
export function otherHandleWithLogin(dirs: string[], handle: string, userId: string): string | null {
  const h = normalizeHandle(handle)
  if (!userId) return null
  for (const dir of dirs) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      const m = AUTH_RE.exec(n)
      if (!m) continue
      const other = normalizeHandle(m[1])
      if (other === h) continue
      let state: StorageState | null = null
      try { state = JSON.parse(fs.readFileSync(pathNode.join(dir, n), "utf8")) } catch { continue }
      if (sessionUserId(state) === userId) return other
    }
  }
  return null
}

/** Atomic, owner-only write of instagram-auth-<handle>.json. */
export function writeSessionFile(dir: string, handle: string, state: StorageState): string {
  const target = pathNode.join(dir, `instagram-auth-${normalizeHandle(handle)}.json`)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
  return target
}

/**
 * Why a local session may NOT be pushed as @handle, or "" when it may.
 * `dirs` are every som dir on this machine (a login held by two handles' files is refused).
 */
export function pushProblem(dirs: string[], handle: string, state: StorageState | null): string {
  const p = sessionProblem(handle, state)
  if (p) return p
  const other = otherHandleWithLogin(dirs, handle, sessionUserId(state))
  if (other) return `instagram-auth-${other}.json holds the same Instagram login — one account's login was copied to the other`
  return ""
}

/** The per-handle pull URL. bloq_id is kept so an API without per-handle keys still answers (and is then checked). */
export function pullSessionPath(handle: string, boardId: string | number, userId: number | string): string {
  const q = new URLSearchParams({ platform: "instagram", account_handle: normalizeHandle(handle), bloq_id: String(boardId), user_id: String(userId) })
  return `/api/v1/project-credentials/session?${q}`
}

export type PulledBody = { credentials?: StorageState; account_handle?: string | null } | null | undefined

/**
 * Why a pulled session may NOT be written as @handle, or "".
 * Refuses an answer for a different handle, an unproven session, and a login another local file holds.
 */
export function pullProblem(dirs: string[], handle: string, body: PulledBody): string {
  const h = normalizeHandle(handle)
  if (!body?.credentials) return "empty session"
  if (body.account_handle != null && normalizeHandle(body.account_handle) !== h) {
    return `the cloud answered with @${normalizeHandle(body.account_handle)}'s session`
  }
  return pushProblem(dirs, h, body.credentials)
}

// ── The push / pull loops, with the network injected so they can be tested without one ──

export type SomCampaign = { id: string; boardId: string; igAccount: string }
export type SessionResult = { account: string; board: string; status: string }
type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

async function errorMessage(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => null)) as { message?: string } | null)?.message
}

function localSessionFile(dirs: string[], handle: string): string | null {
  for (const dir of dirs) {
    const f = pathNode.join(dir, `instagram-auth-${handle}.json`)
    if (fs.existsSync(f)) return f
  }
  return null
}

/** Upload each campaign account's local session — only one that proves it is that account. */
export async function pushSessions(campaigns: SomCampaign[], userId: number, dirs: string[], doFetch: Fetcher): Promise<SessionResult[]> {
  const results: SessionResult[] = []
  for (const c of campaigns) {
    const r = (status: string) => results.push({ account: c.igAccount, board: c.boardId, status })
    const file = localSessionFile(dirs, c.igAccount)
    if (!file) { r("no local session"); continue }
    let storageState: StorageState
    try { storageState = JSON.parse(fs.readFileSync(file, "utf8")) } catch { r("unreadable file"); continue }
    const problem = pushProblem(dirs, c.igAccount, storageState)
    if (problem) { r(`refused — ${problem}`); continue }
    const res = await doFetch(`/api/v1/project-credentials`, {
      method: "POST",
      body: JSON.stringify({
        bloq_id: Number(c.boardId), user_id: userId, platform: "instagram", credential_type: "browser_session",
        account_handle: normalizeHandle(c.igAccount), credentials: storageState,
      }),
    })
    if (res.ok) { r("uploaded"); continue }
    const msg = await errorMessage(res)
    r(msg ? `refused (${res.status}) — ${msg}` : `failed (${res.status})`)
  }
  return results
}

/**
 * Download each campaign account's own session and write instagram-auth-<handle>.json — only one
 * that proves it is that account. `dirs[0]` is created when missing; the others only if present.
 */
export async function pullSessions(campaigns: SomCampaign[], userId: number, dirs: string[], doFetch: Fetcher): Promise<SessionResult[]> {
  const results: SessionResult[] = []
  for (const c of campaigns) {
    const r = (status: string) => results.push({ account: c.igAccount, board: c.boardId, status })
    const res = await doFetch(pullSessionPath(c.igAccount, c.boardId, userId))
    if (res.status === 404) { r("no cloud session — run: iris som push-sessions"); continue }
    if (res.status === 410) { r("expired — re-authenticate"); continue }
    if (!res.ok) {
      const msg = await errorMessage(res)
      r(msg ? `refused (${res.status}) — ${msg}` : `failed (${res.status})`)
      continue
    }
    const body = (await res.json()) as PulledBody
    const problem = pullProblem(dirs, c.igAccount, body)
    if (problem) { r(`refused — ${problem}`); continue }
    let wrote = false
    dirs.forEach((dir, i) => {
      if (i > 0 && !fs.existsSync(dir)) return
      writeSessionFile(dir, c.igAccount, body!.credentials!)
      wrote = true
    })
    r(wrote ? "pulled" : "no writable som dir")
  }
  return results
}
