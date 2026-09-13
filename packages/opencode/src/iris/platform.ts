/**
 * The IRIS platform data layer, on the branch the desktop app actually ships from.
 *
 * WHY THIS FILE EXISTS AT ALL. `origin/main` carries 193 `platform-*.ts` command files and
 * `cli/cmd/iris-api.ts`, which between them know how to reach fl-api and iris-api with the
 * user's token. This branch — `iris/1.18.23`, the one that builds `desktop-v*` and therefore
 * `/Applications/IRIS.app` — carries none of it. Asked directly, the shipped sidecar answers:
 *
 *     $ /Applications/IRIS.app/Contents/MacOS/iris-cli --help
 *       opencode completion / acp / mcp / ... / opencode uninstall
 *
 * It calls itself `opencode`, and has zero platform command groups. So the desktop app has
 * a UI and no account data behind it, and that is not a missing feature — it is a missing
 * half of the program. See epic #184872.
 *
 * WHY IT IS NOT A COPY OF `iris-api.ts`. That file is 1,006 lines and most of them are CLI:
 * clack spinners, `UI.empty()`, `--print-logs` tracing, payment-required formatting, JSON
 * output modes. None of it belongs in a server. What a server needs is four sources of a
 * token, a base URL, and fetch. That is what is here.
 *
 * WHY IT READS `auth.json` DIRECTLY. On `main` the resolver calls `Auth.get("iris")`, a
 * promise. On this branch `Auth` is an Effect service requiring a layer and a runtime, which
 * would make every caller of this module Effect-bound for the sake of one file read. The file
 * is the same file, at the same path, written by the same `auth login`. Reading it is the
 * smaller coupling — but it IS a duplication, and if the auth store's shape changes this
 * reader has to change with it. Noted here rather than discovered later.
 */

import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import path from "path"

/**
 * Where `auth.json` lives — derived, not imported.
 *
 * `@opencode-ai/core/global` exports exactly this path, and importing it costs five
 * `fs.mkdir` calls and a `Flock.setGlobal` AT MODULE LOAD. That is the same property that
 * makes `main`'s `iris-api.ts` impossible to import into a webview, and a module whose job
 * is "fetch some JSON" should not create directories to be loaded.
 *
 * This mirrors `xdg-basedir`'s POSIX rule, which is what global.ts uses. On Windows
 * xdg-basedir resolves LOCALAPPDATA instead, so this falls back to it there rather than
 * quietly reading a path that does not exist.
 */
function dataDir(): string {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "opencode")
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return path.join(process.env.LOCALAPPDATA, "opencode")
  return path.join(homedir(), ".local", "share", "opencode")
}

/**
 * The two backends, and the public host that is neither.
 *
 * `flApi` and `irisApi` are different services with different data — bloqs/leads/pages on
 * one, the V6 engine and the node fleet on the other — and a call to the wrong one 404s
 * rather than failing loudly. Kept as named constants for that reason.
 */
export const FL_API = process.env.IRIS_FL_API_URL ?? "https://raichu.heyiris.io"
export const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

// ─────────────────────────────────────────────────────────────────────────────
// Token
// ─────────────────────────────────────────────────────────────────────────────

let _token: string | null | undefined
let _tokenSource = "not resolved"

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (!existsSync(file)) return out
    let raw = readFileSync(file, "utf-8")
    // PowerShell 5.1 writes UTF-8 with a BOM, which otherwise becomes part of the first key.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq <= 0) continue
      let v = t.slice(eq + 1).trim()
      const hash = v.indexOf("#")
      if (hash >= 0) v = v.slice(0, hash).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[t.slice(0, eq).trim()] = v
    }
  } catch {}
  return out
}

/**
 * Four sources, in order of authority — the same order and the same files `main` uses, so a
 * machine signed in for the CLI is signed in for the desktop app without doing anything.
 *
 * The SOURCE is recorded, not just the token. `iris auth whoami` on main once derived its
 * own answer by re-checking the environment in a different order, and reported
 * "IRIS_API_KEY (environment)" for a token that came from `auth login` — read at the worst
 * moment, while something is already refusing you, and it sends you to edit a file nothing
 * is reading.
 */
export function resolveToken(): string | null {
  if (_token !== undefined) return _token

  try {
    const authFile = path.join(dataDir(), "auth.json")
    if (existsSync(authFile)) {
      const stored = JSON.parse(readFileSync(authFile, "utf-8"))?.iris
      if (stored?.type === "api" && stored.key) {
        _tokenSource = "auth store (iris auth login)"
        return (_token = stored.key)
      }
    }
  } catch {}

  if (process.env.IRIS_API_KEY) {
    _tokenSource = "IRIS_API_KEY (environment)"
    return (_token = process.env.IRIS_API_KEY)
  }

  const sdkEnv = readEnvFile(path.join(homedir(), ".iris", "sdk", ".env"))
  if (sdkEnv["IRIS_API_KEY"]) {
    _tokenSource = "~/.iris/sdk/.env"
    return (_token = sdkEnv["IRIS_API_KEY"])
  }

  try {
    const cfg = path.join(homedir(), ".iris", "config.json")
    if (existsSync(cfg)) {
      const node = JSON.parse(readFileSync(cfg, "utf-8"))?.node_api_key
      if (node) {
        _tokenSource = "~/.iris/config.json (node_api_key)"
        return (_token = node)
      }
    }
  } catch {}

  _tokenSource = "none (not signed in)"
  return (_token = null)
}

export function tokenSource(): string {
  if (_token === undefined) resolveToken()
  return _tokenSource
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────

export async function irisFetch(pathname: string, base: string = FL_API, init: RequestInit = {}): Promise<Response> {
  const token = resolveToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${base}${pathname}`, { ...init, headers })
}

let _userId: number | null | undefined

export async function resolveUserId(): Promise<number | null> {
  if (_userId !== undefined) return _userId

  const fromEnv = process.env.IRIS_USER_ID ?? readEnvFile(path.join(homedir(), ".iris", "sdk", ".env"))["IRIS_USER_ID"]
  if (fromEnv) {
    const n = parseInt(fromEnv, 10)
    if (!Number.isNaN(n)) return (_userId = n)
  }

  // /api/user is the live fl-api route; /api/v1/me is kept for older backends.
  for (const ep of ["/api/user", "/api/v1/me"]) {
    try {
      const res = await irisFetch(ep)
      if (!res.ok) continue
      const data = (await res.json()) as { data?: { id?: number }; id?: number }
      const id = data?.data?.id ?? data?.id
      if (typeof id === "number") return (_userId = id)
    } catch {}
  }
  return (_userId = null)
}

// ─────────────────────────────────────────────────────────────────────────────
// The surfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every reply carries `measured`.
 *
 * An empty Atlas and an unreachable one render identically as `{ lists: [] }`, and the
 * reassuring one is always the wrong guess. The TUI sidebar learned this the expensive way
 * and shows "unreachable" rather than "0 online"; a route that drops the distinction hands
 * the next UI the same bug to rediscover.
 */
export interface PlatformResult<T> {
  measured: boolean
  reason?: string
  data: T
}

export interface AtlasItem {
  id: number
  title: string
  type?: string
  status?: string
  description?: string
}
export interface AtlasList {
  id: number
  name: string
  items: AtlasItem[]
}

export async function fetchAtlas(bloqId: number): Promise<PlatformResult<{ lists: AtlasList[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { lists: [] } }

  try {
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { lists: [] } }
    const json = (await res.json()) as any
    const raw = json?.data ?? json
    const lists: AtlasList[] = (raw?.lists ?? []).map((l: any) => ({
      id: l.id,
      name: l.name,
      items: (l.items ?? []).map((i: any) => ({
        id: i.id,
        title: i.title ?? "Untitled",
        type: i.type ?? undefined,
        status: i.status ?? undefined,
        description: i.description || undefined,
      })),
    }))
    return { measured: true, data: { lists } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { lists: [] } }
  }
}

export interface HiveNode {
  id: string
  name: string
  status: string
  online: boolean
  lastHeartbeat: string | null
  activeTasks: number
  maxConcurrent: number
}

export async function fetchHiveNodes(): Promise<PlatformResult<{ nodes: HiveNode[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { nodes: [] } }

  try {
    const res = await irisFetch(`/api/v6/nodes/?user_id=${userId}`, IRIS_API)
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { nodes: [] } }
    const json = (await res.json()) as any
    const nodes: HiveNode[] = (json?.nodes ?? []).map((n: any) => ({
      id: String(n.id),
      name: String(n.name ?? "unnamed"),
      status: String(n.connection_status ?? "unknown"),
      online: n.connection_status === "online",
      lastHeartbeat: n.last_heartbeat_at ?? null,
      activeTasks: Number(n.active_tasks ?? 0),
      maxConcurrent: Number(n.max_concurrent ?? 0),
    }))
    return { measured: true, data: { nodes } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { nodes: [] } }
  }
}
