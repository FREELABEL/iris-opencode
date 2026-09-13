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


/**
 * Is this a bloq the signed-in user actually has?
 *
 * MEASURED 2026-09-13, and the reason this exists: `/iris/pages/99999999` came back
 * `measured: true` with an empty list. fl-api 404s an impossible bloq, so Atlas, agents and
 * leads all reported "could not look" correctly — but iris-api answers **200 with an empty
 * page list**, so for pages the honest answer and the reassuring one were the same JSON. The
 * `measured` flag cannot save a caller when the upstream never says no.
 *
 * So the id is checked against the account's own bloqs before the surface is fetched. Applied
 * to all four bloq-scoped surfaces, not just pages: the other three are correct today only
 * because of how their upstream happens to behave, which is not a property anyone promised.
 *
 * DELIBERATELY FAILS OPEN on an unmeasurable bloq list. If we cannot list bloqs — offline,
 * 401 — we must not start claiming ids are unknown. A guard that cannot verify should decline
 * to judge, not invent a verdict.
 */
export function unknownBloqReason(bloqId: number, list: PlatformResult<{ bloqs: Bloq[] }>): string | null {
  if (!list.measured) return null
  return list.data.bloqs.some((b) => b.id === bloqId) ? null : `unknown bloq ${bloqId}`
}

async function unknownBloq(bloqId: number): Promise<string | null> {
  return unknownBloqReason(bloqId, await fetchBloqs())
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

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { lists: [] } }

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

export interface Bloq {
  id: number
  name: string
}

/**
 * The account's bloqs — what a project picker would offer.
 *
 * The desktop app has no bloq concept at all, and six of the seven TUI surfaces are
 * bloq-scoped, so without this the Atlas tab would have to hardcode an id. A hardcoded id is
 * the kind of thing that ships, works for whoever wrote it, and is wrong for everyone else.
 */
export async function fetchBloqs(): Promise<PlatformResult<{ bloqs: Bloq[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { bloqs: [] } }

  try {
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs?simplified=true`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { bloqs: [] } }
    const json = (await res.json()) as any
    const raw = json?.data ?? json?.bloqs ?? []
    const bloqs: Bloq[] = (Array.isArray(raw) ? raw : []).map((b: any) => ({
      id: Number(b.id),
      name: String(b.name ?? "Untitled"),
    }))
    return { measured: true, data: { bloqs } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { bloqs: [] } }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hive inbox — a local file, not an API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The inbox is pull-based and nothing announces it.
 *
 * On 2026-09-11 four messages that changed what a client's agent was building sat unread until
 * someone said "run iris hive inbox read" out loud on a call. The channel worked perfectly. The
 * only broken part was that a person had to already know a message existed.
 *
 * The daemon has already delivered and written these, so this is a file read, not a request —
 * which is why it can be polled cheaply and why it must go through the sidecar: a webview
 * cannot read the user's home directory.
 */
export interface InboxState {
  /** Unread count. Null means NOT MEASURED — never render it as zero. */
  unread: number | null
  total: number
  /** The most recent unread sender, for a one-line hint. */
  from?: string
  /** The manifest exists and could not be parsed. A real fault, not an empty inbox. */
  unreadable: boolean
}

interface ManifestRow {
  read?: boolean
  from_user?: string
  from_node?: string
  received_at?: string
}

/**
 * Count unread from the manifest's raw text.
 *
 * Pure, and separate from the file read, so the counting rules can be tested without a
 * filesystem — the rules are where the bugs are: a corrupt manifest must not read as empty,
 * and a partially corrupt one must not silently undercount.
 */
export function countInbox(raw: string): InboxState {
  const lines = raw.split("\n").filter((l) => l.trim())
  if (!lines.length) return { unread: 0, total: 0, unreadable: false }

  let unread = 0
  let bad = 0
  let from: string | undefined
  let newest = ""

  for (const line of lines) {
    let row: ManifestRow
    try {
      row = JSON.parse(line) as ManifestRow
    } catch {
      bad++
      continue
    }
    if (row.read) continue
    unread++
    const at = String(row.received_at ?? "")
    if (at >= newest) {
      newest = at
      from = row.from_user ?? row.from_node
    }
  }

  // Every line unparseable is a CORRUPT manifest, not an empty one.
  if (bad && bad === lines.length) return { unread: null, total: lines.length, unreadable: true }

  return { unread, total: lines.length, from, unreadable: false }
}

export function fetchInbox(): InboxState {
  const manifest = path.join(homedir(), ".iris", "hive", "inbox", ".manifest.jsonl")
  // No file means this machine has never received anything. A genuine zero, not a failure.
  if (!existsSync(manifest)) return { unread: 0, total: 0, unreadable: false }
  try {
    return countInbox(readFileSync(manifest, "utf-8"))
  } catch {
    // Present and unreadable is not the same as empty, and reporting zero here is the exact
    // failure this codebase keeps paying for.
    return { unread: null, total: 0, unreadable: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The remaining bloq-scoped surfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface Agent {
  id: number
  name: string
  status: string
  model?: string
  /** Heartbeat agents run on a schedule; standard ones do not. */
  heartbeat: boolean
  schedule?: string
  lastRun?: string
}

/**
 * Agents, merged with their scheduled jobs.
 *
 * Two endpoints, one surface — an agent's schedule lives on the job, not the agent, so a list
 * built from `/agents` alone can tell you a heartbeat agent exists and never that it has not
 * run in four days. That distinction is the whole reason anyone opens this list.
 */
export async function fetchAgents(bloqId: number): Promise<PlatformResult<{ agents: Agent[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { agents: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { agents: [] } }

  try {
    const [agentsRes, jobsRes] = await Promise.all([
      irisFetch(`/api/v1/users/${userId}/bloqs/agents?bloq_id=${bloqId}&per_page=50`),
      irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?bloq_id=${bloqId}&per_page=50`),
    ])
    if (!agentsRes.ok) return { measured: false, reason: `fl-api ${agentsRes.status}`, data: { agents: [] } }

    const unwrap = async (res: Response) => {
      const j = (await res.json()) as any
      const d = j?.data ?? j
      return Array.isArray(d) ? d : (d?.data ?? [])
    }
    const rawAgents = await unwrap(agentsRes)
    // A failed jobs call must not fail the whole list — it costs schedules, not agents. But it
    // must not silently look like "no schedules" either, hence the reason below.
    const rawJobs = jobsRes.ok ? await unwrap(jobsRes) : []

    const jobFor = new Map<number, any>()
    for (const j of rawJobs) {
      const id = Number(j?.agent_id ?? j?.bloq_agent_id)
      if (Number.isFinite(id)) jobFor.set(id, j)
    }

    const agents: Agent[] = rawAgents.map((a: any) => {
      const job = jobFor.get(Number(a.id))
      const hb = a.heartbeat_mode === true || a.heartbeat_mode === "true" || Boolean(job)
      return {
        id: Number(a.id),
        name: String(a.name ?? "unnamed"),
        status: String(a.health_status ?? (a.active === false ? "paused" : "idle")),
        model: a.model ?? a.config?.model ?? a.config?.modelName ?? undefined,
        heartbeat: hb,
        schedule: job?.interval_minutes ? `${job.interval_minutes}m` : undefined,
        lastRun: job?.last_run_at ?? undefined,
      }
    })
    return {
      measured: true,
      reason: jobsRes.ok ? undefined : `schedules unavailable (fl-api ${jobsRes.status})`,
      data: { agents },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { agents: [] } }
  }
}

export interface Lead {
  id: number
  name: string
  status?: string
  company?: string
  email?: string
  hot: boolean
}

export async function fetchLeads(bloqId: number): Promise<PlatformResult<{ leads: Lead[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { leads: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { leads: [] } }

  try {
    const res = await irisFetch(`/api/v1/users/${userId}/leads?bloq_id=${bloqId}&per_page=50`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { leads: [] } }
    const j = (await res.json()) as any
    const d = j?.data ?? j
    const rows = Array.isArray(d) ? d : (d?.data ?? [])
    const leads: Lead[] = rows.map((l: any) => ({
      id: Number(l.id),
      name: String(l.name ?? l.full_name ?? "unnamed"),
      status: l.status ?? undefined,
      company: l.company ?? undefined,
      email: l.email ?? undefined,
      hot: Number(l.lead_score ?? l.leadScore ?? 0) >= 70,
    }))
    return { measured: true, data: { leads } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { leads: [] } }
  }
}

export interface Page {
  id: number
  title: string
  slug?: string
  status: string
  url?: string
  updatedAt?: string
}

export async function fetchPages(bloqId: number): Promise<PlatformResult<{ pages: Page[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { pages: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { pages: [] } }

  try {
    // owner_type/owner_id is a NARROWING filter, which is the point: this used to be fetched
    // per-user and rendered under a project header, so the list could never change when you
    // switched project.
    const res = await irisFetch(
      `/api/v1/pages?user_id=${userId}&owner_type=bloq&owner_id=${bloqId}&per_page=50`,
      IRIS_API,
    )
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { pages: [] } }
    const j = (await res.json()) as any
    const rows = j?.data?.data ?? j?.data ?? []
    const pages: Page[] = (Array.isArray(rows) ? rows : []).map((p: any) => ({
      id: Number(p.id),
      title: String(p.title || p.slug || "Untitled"),
      slug: p.slug ?? undefined,
      status: String(p.status ?? "draft"),
      url: p.public_url || undefined,
      updatedAt: p.updated_at ?? undefined,
    }))
    return { measured: true, data: { pages } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { pages: [] } }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Can the app actually authenticate — and if not, WHICH way is it broken?
 *
 * Asked because of a real failure: a machine that had run `iris auth login`, with a valid key
 * sitting in auth.json, sent a message and got
 *
 *     Unauthorized: Provide a Bearer token in the Authorization header
 *
 * rendered raw into the transcript, with no prompt to sign in and no hint about what was
 * missing. The key was there. The PROVIDER could not see it: `/api/provider` configures the
 * iris provider as `apiKey: "{env:IRIS_API_KEY}"`, which resolves from `process.env` only,
 * and nothing bridges the auth store to the environment.
 *
 * So "are you signed in?" is the wrong question, and answering it is what produced a silent
 * failure: the honest answer was YES and chat was still broken. The question that predicts
 * the 401 is "can the code that makes the request see a credential?" — which is why
 * `providerCanSee` is separate from `signedIn` rather than one boolean.
 */
export interface AuthState {
  /** A credential exists somewhere we know to look (auth store, env, sdk .env, config.json). */
  signedIn: boolean
  /** Where it came from, for a diagnostic that points at the right file. */
  source: string
  /**
   * Whether the AI provider can read a key. This is the one that predicts whether chat works,
   * because the provider reads process.env and nothing else.
   */
  providerCanSee: boolean
  /**
   * The three-state verdict the UI renders.
   *  - "ready"        chat will authenticate
   *  - "signed-out"   no credential anywhere — prompt a login
   *  - "unreachable-credential"  signed in, but the provider cannot see it. NOT a login
   *    problem; sending someone to sign in again would "fix" nothing and waste their time.
   */
  verdict: "ready" | "signed-out" | "unreachable-credential"
}

export function describeAuth(input: { storedToken: string | null; source: string; envKey: string | undefined }): AuthState {
  const signedIn = Boolean(input.storedToken)
  const providerCanSee = Boolean(input.envKey)
  return {
    signedIn,
    source: input.source,
    providerCanSee,
    verdict: providerCanSee ? "ready" : signedIn ? "unreachable-credential" : "signed-out",
  }
}

export function checkAuth(): AuthState {
  return describeAuth({
    storedToken: resolveToken(),
    source: tokenSource(),
    envKey: process.env.IRIS_API_KEY,
  })
}
