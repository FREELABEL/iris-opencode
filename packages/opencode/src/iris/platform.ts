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
import { clampPaging, DEFAULT_PER_PAGE } from "./pagination"

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
  /** The item's body. This is the thing a person actually opens an item to read. */
  content?: string
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
        content: i.content || undefined,
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
  /**
   * The machine itself. All of this was already in the payload and being thrown away — "I
   * should be able to see stats, RAM, what's installed" needed no new endpoint, only for the
   * mapper to stop dropping the fields.
   */
  os?: string
  cpu?: string
  cores?: number
  memoryGb?: number
  diskTotalGb?: number
  diskFreeGb?: number
  daemonVersion?: string
  uptimeSeconds?: number
  tasksCompleted?: number
  /** Which things this node can actually do — bash, docker, browser, python3, bridge_call. */
  capabilities?: string[]
  /** A machine that heartbeats once per restart looks healthy while crash-looping (#182434). */
  recentRestarts?: number
  transport?: string
  tailscaleIp?: string
  /**
   * When the hardware profile was captured — NOT when the node last heartbeat.
   *
   * Measured 2026-09-13: a node reported `disk.available_gb: 0.1` from a profile detected at
   * 00:45 while heartbeating at 20:46, twenty hours later, with 1.5 GB actually free. The
   * heartbeat is live; the hardware snapshot is not, and rendering the two together with no
   * timestamp turns a day-old reading into a current fact. Disk especially: "0.1 GB free" is
   * an emergency if true now and noise if it is yesterday's.
   */
  hardwareDetectedAt?: string
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
      os: n.hardware_profile?.os?.label ?? n.hardware_profile?.os?.platform ?? undefined,
      cpu: n.hardware_profile?.cpu?.model ?? undefined,
      cores: n.hardware_profile?.cpu?.cores ?? undefined,
      memoryGb: n.hardware_profile?.memory?.total_gb ?? undefined,
      diskTotalGb: n.hardware_profile?.disk?.total_gb ?? undefined,
      diskFreeGb: n.hardware_profile?.disk?.available_gb ?? undefined,
      daemonVersion: n.daemon_version ?? undefined,
      uptimeSeconds: typeof n.uptime_seconds === "number" ? n.uptime_seconds : undefined,
      tasksCompleted: typeof n.total_tasks_completed === "number" ? n.total_tasks_completed : undefined,
      capabilities: Object.entries(n.capabilities ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k),
      recentRestarts: Array.isArray(n.recent_restarts) ? n.recent_restarts.length : undefined,
      transport: n.transport?.default_rail ?? undefined,
      tailscaleIp: n.tailscale_ip ?? undefined,
      hardwareDetectedAt: n.hardware_profile?.detected_at ?? undefined,
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
export interface InboxItem {
  /** 1-based manifest position — the number `iris hive inbox read <n>` takes. */
  index: number
  read: boolean
  type: string
  from: string
  receivedAt?: string
  label: string
}

export interface InboxState {
  /** Unread count. Null means NOT MEASURED — never render it as zero. */
  unread: number | null
  total: number
  /** The most recent unread sender, for a one-line hint. */
  from?: string
  /** The manifest exists and could not be parsed. A real fault, not an empty inbox. */
  unreadable: boolean
  /** Unread first, then newest first. Empty when unreadable — the flag says which. */
  items: InboxItem[]
  /**
   * Manifest lines we could not parse and therefore are NOT in `items`.
   *
   * A partially corrupt manifest used to undercount in silence: the rows simply were not
   * there and the panel looked like a shorter, healthy inbox. Non-zero here means the list
   * you are reading is incomplete, and the UI says so out loud.
   */
  unparsed: number
}

interface ManifestRow {
  read?: boolean
  from_user?: string
  from_node?: string
  received_at?: string
  type?: string
  message?: string
  original_name?: string
  file?: string
  item?: string | null
  status?: string | null
}

/**
 * Count unread from the manifest's raw text.
 *
 * Pure, and separate from the file read, so the counting rules can be tested without a
 * filesystem — the rules are where the bugs are: a corrupt manifest must not read as empty,
 * and a partially corrupt one must not silently undercount.
 */
/** What the row shows: the work item for a handoff, the text for a message, else the filename. */
function describeInbox(row: Record<string, any>): string {
  const type = row.type ?? "file"
  if (type === "handoff" || type === "job") return `${row.item ?? "?"}${row.status ? ` [${row.status}]` : ""}`
  if (type === "message") return row.message ?? "(no text)"
  return row.original_name ?? row.file ?? "?"
}

export function countInbox(raw: string): InboxState {
  const lines = raw.split("\n").filter((l) => l.trim())
  if (!lines.length) return { unread: 0, total: 0, unreadable: false, items: [], unparsed: 0 }

  let unread = 0
  let bad = 0
  let from: string | undefined
  let newest = ""
  const items: InboxItem[] = []

  for (let i = 0; i < lines.length; i++) {
    let row: ManifestRow
    try {
      row = JSON.parse(lines[i]) as ManifestRow
    } catch {
      bad++
      continue
    }
    // The index is the MANIFEST position, not the position in this array — it is what
    // `iris hive inbox read <n>` takes, and renumbering the rows we kept would print a number
    // that opens a different message.
    items.push({
      index: i + 1,
      read: Boolean(row.read),
      type: row.type ?? "file",
      from: row.from_node ?? row.from_user ?? "a peer",
      receivedAt: row.received_at,
      label: describeInbox(row),
    })
    if (row.read) continue
    unread++
    const at = String(row.received_at ?? "")
    if (at >= newest) {
      newest = at
      from = row.from_user ?? row.from_node
    }
  }

  // Every line unparseable is a CORRUPT manifest, not an empty one.
  if (bad && bad === lines.length)
    return { unread: null, total: lines.length, unreadable: true, items: [], unparsed: bad }

  // Unread first, then newest first: what is waiting on you outranks what you have seen.
  items.sort((a, b) => (a.read === b.read ? b.index - a.index : a.read ? 1 : -1))

  return { unread, total: lines.length, from, unreadable: false, items, unparsed: bad }
}

export function fetchInbox(): InboxState {
  const manifest = path.join(homedir(), ".iris", "hive", "inbox", ".manifest.jsonl")
  // No file means this machine has never received anything. A genuine zero, not a failure.
  if (!existsSync(manifest)) return { unread: 0, total: 0, unreadable: false, items: [], unparsed: 0 }
  try {
    return countInbox(readFileSync(manifest, "utf-8"))
  } catch {
    // Present and unreadable is not the same as empty, and reporting zero here is the exact
    // failure this codebase keeps paying for.
    return { unread: null, total: 0, unreadable: true, items: [], unparsed: 0 }
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
  description?: string
  active?: boolean
  failures?: number
  createdAt?: string
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
        description: a.description || undefined,
        active: typeof a.active === "boolean" ? a.active : undefined,
        failures: typeof a.consecutive_failures === "number" ? a.consecutive_failures : undefined,
        createdAt: a.created_at ?? undefined,
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
  /** Everything the detail view shows. Optional throughout — fl-api omits empties. */
  score?: number
  type?: string
  city?: string
  country?: string
  createdAt?: string
  repliedAt?: boolean
  keywords?: string
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
      score: typeof l.lead_score === "number" ? l.lead_score : undefined,
      type: l.lead_type ?? undefined,
      city: l.city ?? undefined,
      country: l.country ?? undefined,
      createdAt: l.created_at ?? undefined,
      repliedAt: typeof l.has_replied === "boolean" ? l.has_replied : undefined,
      keywords: Array.isArray(l.keywords) ? l.keywords.join(", ") : (l.keywords ?? undefined),
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
  version?: number
  publishedAt?: string
  visibility?: string
  requiresAuth?: boolean
  category?: string
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
      version: typeof p.current_version === "number" ? p.current_version : undefined,
      publishedAt: p.published_at ?? undefined,
      visibility: p.visibility ?? undefined,
      requiresAuth: typeof p.requires_auth === "boolean" ? p.requires_auth : undefined,
      category: p.category ?? undefined,
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


export interface SchemaField {
  /** The key in a record's `data` map — what a table column reads. */
  key: string
  /** The human label, when the schema gives one. Falls back to the key. */
  label: string
  type: string
  sortable?: boolean
  filterable?: boolean
  /**
   * "phi" marks a field the platform treats as protected health information.
   *
   * Carried through so a table can LABEL it rather than rendering PHI in a column that looks
   * like any other. Filtering happens upstream against the caller's token; this flag is about
   * telling the person what they are looking at.
   */
  visibility?: string
}

export interface Schema {
  id: number
  name: string
  slug: string
  version?: number
  isSystem: boolean
  /** board = defined on this board · account = available everywhere. */
  scope: "board" | "account"
  fields: SchemaField[]
  /** The field a record is named by, when the schema nominates one. */
  displayField?: string
}

/**
 * The Atlas dataset schemas for one board.
 *
 * The endpoint returns every schema on the account (76 of them here) with no server-side board
 * filter, so the narrowing happens here. That is worth stating out loud: a "schemas for this
 * board" view built on an unfiltered list is one forgotten filter away from showing someone
 * every schema they own under a board heading — the same shape as the Pages bug this panel
 * already fixed once.
 */
/**
 * The field list out of a schema's `fields` blob.
 *
 * Two shapes in the wild and both have to work: the current one nests the array under
 * `fields.fields`, and older rows are a flat key->definition map. Guessing one would have been
 * fine until the day it met the other.
 */
export function readSchemaFields(blob: unknown): SchemaField[] {
  const b = blob as any
  const arr = Array.isArray(b?.fields) ? b.fields : Array.isArray(b) ? b : null
  if (arr) {
    return arr
      .filter((f: any) => f && (f.key ?? f.name))
      .map((f: any) => ({
        key: String(f.key ?? f.name),
        label: String(f.label ?? f.key ?? f.name),
        type: String(f.type ?? "string"),
        sortable: f.sortable === true ? true : undefined,
        filterable: f.filterable === true ? true : undefined,
        visibility: typeof f.visibility === "string" ? f.visibility : undefined,
      }))
  }
  // The legacy map. `display_field` is metadata about the schema, not a field of it.
  return Object.entries(b ?? {})
    .filter(([name]) => name !== "display_field")
    .map(([name, def]: [string, any]) => ({
      key: name,
      label: name,
      type: String(def?.type ?? (typeof def === "string" ? def : "?")),
    }))
}

export async function fetchSchemas(bloqId: number): Promise<PlatformResult<{ schemas: Schema[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { schemas: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { schemas: [] } }

  try {
    const res = await irisFetch(`/api/v1/atlas/schemas`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { schemas: [] } }
    const json = (await res.json()) as any
    const raw = json?.schemas ?? json?.data ?? json
    const rows = Array.isArray(raw) ? raw : []
    // Board schemas AND account-level ones (bloq_id null). 40 of the 76 on this account have no
    // board, so filtering strictly by board hid more than half of a person's data sources and
    // showed an empty panel on most boards. They are flagged so the scope is still visible.
    // THIS BOARD ONLY.
    //
    // It used to include account-level schemas (bloq_id null) because filtering strictly by
    // board hid 40 of 76 and most boards looked empty. That was a correct diagnosis and the
    // wrong remedy: the answer to "the board filter returns little" is not "show everything".
    // Every board rendered the same 40 account schemas under its own heading, which is both a
    // lie about where the data lives and an exposure of records that board has no claim to.
    // An empty board is an honest answer.
    const schemas: Schema[] = rows
      .filter((r: any) => Number(r.bloq_id) === bloqId)
      .map((r: any) => ({
        id: Number(r.id),
        name: String(r.name ?? r.slug ?? "unnamed"),
        slug: String(r.slug ?? ""),
        version: typeof r.version === "number" ? r.version : undefined,
        isSystem: Boolean(r.is_system),
        scope: r.bloq_id == null ? ("account" as const) : ("board" as const),
        // `r.fields` is a WRAPPER — `{ fields: [...], display_field: "subject" }` — not a
        // key->type map. Reading it as one produced a column literally named "fields" whose
        // type was every field object stringified: "[object Object],[object Object],…". It
        // rendered, so nothing failed; it was simply nonsense on screen for every schema.
        fields: readSchemaFields(r.fields),
        displayField: typeof r.fields?.display_field === "string" ? r.fields.display_field : undefined,
      }))
    return { measured: true, data: { schemas } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { schemas: [] } }
  }
}


export interface RecordRow {
  id: number
  externalId?: string
  status?: string
  updatedAt?: string
  /** The record's own field map, keyed the same way the schema's `key`s are. */
  data: Record<string, unknown>
}

export interface RecordPage {
  schema: { id: number; slug: string; name: string; version?: number }
  columns: SchemaField[]
  rows: RecordRow[]
  page: number
  perPage: number
  total: number | null
  totalIsExact: boolean
  hasMore: boolean
}

/**
 * One page of a dataset's RECORDS — the table behind a schema.
 *
 * PAGED UPSTREAM, not here. fl-api's `atlas/datasets/{slug}` is Laravel-paginated, so this asks
 * for the page the caller wants and passes the meta back. Fetching everything and slicing it
 * locally would pull a 19,000-row dataset through the sidecar to show twenty-five lines.
 *
 * The COLUMNS come from the schema, not from the first row's keys. Inferring them from data is
 * the version that looks right until it meets a record with a null field, at which point the
 * column silently disappears for the whole table.
 */
export async function fetchRecords(
  slug: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<PlatformResult<RecordPage>> {
  const empty: RecordPage = {
    schema: { id: 0, slug, name: slug },
    columns: [],
    rows: [],
    page: 1,
    perPage: DEFAULT_PER_PAGE,
    total: null,
    totalIsExact: false,
    hasMore: false,
  }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }

  const { page, perPage } = clampPaging(opts)
  try {
    const res = await irisFetch(`/api/v1/atlas/datasets/${encodeURIComponent(slug)}?page=${page}&per_page=${perPage}`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { ...empty, page, perPage } }
    const json = (await res.json()) as any
    const d = json?.data ?? json
    const recs = d?.records ?? {}
    const list: any[] = Array.isArray(recs?.data) ? recs.data : Array.isArray(recs) ? recs : []

    // The schema definition travels with the records on this endpoint, but only as a stub —
    // id/slug/name/version, no fields. The columns come from the schema list instead.
    const stub = d?.schema ?? {}
    const total = typeof recs?.total === "number" ? recs.total : null

    const rows: RecordRow[] = list.map((r: any) => ({
      id: Number(r?.id),
      externalId: typeof r?.external_id === "string" ? r.external_id : undefined,
      status: typeof r?.status === "string" ? r.status : undefined,
      updatedAt: typeof r?.updated_at === "string" ? r.updated_at : undefined,
      data: r?.data && typeof r.data === "object" ? r.data : {},
    }))

    return {
      measured: true,
      data: {
        schema: {
          id: Number(stub?.id ?? 0),
          slug: String(stub?.slug ?? slug),
          name: String(stub?.name ?? slug),
          version: typeof stub?.version === "number" ? stub.version : undefined,
        },
        columns: await columnsFor(slug),
        rows,
        page,
        perPage,
        total,
        // Laravel gives a real total, so it is exact whenever present.
        totalIsExact: total != null,
        hasMore: total != null ? page * perPage < total : rows.length >= perPage,
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { ...empty, page, perPage } }
  }
}

/**
 * The column definitions for one dataset.
 *
 * Read from the schema list because the records endpoint's schema stub carries no fields. A
 * miss returns an empty list rather than throwing: a table with no declared columns falls back
 * to the keys it can see, which is worse than the schema but better than no table.
 */
async function columnsFor(slug: string): Promise<SchemaField[]> {
  try {
    const res = await irisFetch(`/api/v1/atlas/schemas`)
    if (!res.ok) return []
    const json = (await res.json()) as any
    const raw = json?.schemas ?? json?.data ?? json
    const row = (Array.isArray(raw) ? raw : []).find((r: any) => String(r?.slug) === slug)
    return row ? readSchemaFields(row.fields) : []
  } catch {
    return []
  }
}

export interface SiteNavItem {
  label: string
  url: string
}

export interface Site {
  id: number
  name: string
  slug: string
  status: string
  /** How many pages are attached. The whole point of a site is that it has more than one. */
  pagesCount: number
  homePageId?: number
  requiresAuth: boolean
  /** "bloq 174" / "user 193" — sites are owned by either, and the list mixes both. */
  owner?: string
  description?: string
  updatedAt?: string
  navItems: SiteNavItem[]
}

/**
 * The account's SITES — the other half of what the Pages surface was showing as one thing.
 *
 * A site is not a page. It groups pages under shared navigation and a theme, and it owns things
 * a page does not have at all: attached pages in an order, settings, a contact-form inbox and a
 * comms thread. Listing only pages made every one of those invisible, and made a nine-page site
 * look like nine unrelated rows.
 *
 * NOT filtered to the current board. Sites are owned by a user OR a bloq and the endpoint mixes
 * both, so filtering by board would hide every account-level site behind an empty panel — the
 * same mistake the schemas list already made once. The owner is labelled instead.
 */
export async function fetchSites(bloqId: number): Promise<PlatformResult<{ sites: Site[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { sites: [] } }

  try {
    const res = await irisFetch(`/api/v1/sites`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { sites: [] } }
    const json = (await res.json()) as any
    const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []

    // THIS BOARD ONLY.
    //
    // Shipped account-wide with a laboured justification — sites are owned by a user OR a bloq
    // and the endpoint mixes both, so I showed all 13 and labelled the owner. That renders one
    // board's heading over another board's sites, which is the same defect as the schemas list
    // and the one Pages already avoids by asking the API to narrow.
    //
    // A site belongs to this board when the board OWNS it, or when it is filed against the
    // board as a project. Both are checked: owner_type/owner_id is the older relation and
    // projects_bloq_id the newer one, and rows in the wild carry one or the other.
    const mine = rows.filter(
      (r: any) =>
        (String(r.owner_type) === "bloq" && Number(r.owner_id) === bloqId) ||
        Number(r.projects_bloq_id) === bloqId,
    )

    const sites: Site[] = mine.map((r: any) => ({
      id: Number(r.id),
      name: String(r.name ?? r.slug ?? "unnamed"),
      slug: String(r.slug ?? ""),
      status: String(r.status ?? "unknown"),
      pagesCount: Number(r.pages_count ?? 0),
      homePageId: typeof r.home_page_id === "number" ? r.home_page_id : undefined,
      requiresAuth: Boolean(r.requires_auth),
      owner:
        r.owner_type && r.owner_id != null
          ? `${r.owner_type} ${r.owner_id}`
          : r.projects_bloq_id != null
            ? `bloq ${r.projects_bloq_id}`
            : undefined,
      description: typeof r.description === "string" && r.description ? r.description : undefined,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
      navItems: (Array.isArray(r.nav_items) ? r.nav_items : [])
        .filter((n: any) => n && typeof n.url === "string")
        .map((n: any) => ({ label: String(n.label ?? n.url), url: String(n.url) })),
    }))

    // Published first, then the biggest. A draft with one page is the least useful row here.
    sites.sort((a, b) =>
      a.status === b.status ? b.pagesCount - a.pagesCount : a.status === "published" ? -1 : b.status === "published" ? 1 : 0,
    )
    return { measured: true, data: { sites } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { sites: [] } }
  }
}

export interface AgentTask {
  /** Which kind of work this is. The four sources answer different questions. */
  source: "bloq_item_task" | "lead_task" | "scheduled_job" | "heartbeat_bloq"
  id: number
  title: string
  status?: string
  done: boolean
  dueDate?: string
  /** Where it lives, when it lives somewhere. */
  itemId?: number
  itemTitle?: string
  bloqId?: number
  listId?: number
  leadId?: number
  nextRunAt?: string
  frequency?: string
}

export interface AgentTaskState {
  counts: { itemTasks: number; leadTasks: number; scheduledJobs: number; heartbeatBloqs: number; total: number }
  tasks: AgentTask[]
}

/**
 * What an agent has actually been given.
 *
 * ATTACHMENT IS NOT ASSIGNMENT. `bloq_agents.bloq_id` says which agent belongs to a board;
 * this says what it is supposed to do. An agent attached to a 400-item board is attached to all
 * of it and assigned none of it, and from every surface we had, those two states looked the
 * same.
 *
 * FOUR SOURCES, one list. An agent can hold a task on a bloq item, a task on a lead, a
 * scheduled job, or a whole board it heartbeats. The last is the one most likely to be
 * forgotten, because nothing about the board mentions it. Flattening them here — with `source`
 * kept — means the panel shows "what is this agent holding" as one answer rather than four
 * lists the reader has to add up.
 *
 * The endpoint is NOT bloq-scoped and NOT under /users/{id}: it is `/api/v1/agents/{id}/tasks`.
 */
export async function fetchAgentTasks(
  agentId: number,
  opts: { includeDone?: boolean } = {},
): Promise<PlatformResult<AgentTaskState>> {
  const empty: AgentTaskState = {
    counts: { itemTasks: 0, leadTasks: 0, scheduledJobs: 0, heartbeatBloqs: 0, total: 0 },
    tasks: [],
  }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }

  try {
    const q = opts.includeDone ? "?include_done=1" : ""
    const res = await irisFetch(`/api/v1/agents/${agentId}/tasks${q}`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: empty }
    const json = (await res.json()) as any
    const d = json?.data ?? {}

    const tasks: AgentTask[] = []
    for (const t of Array.isArray(d.item_tasks) ? d.item_tasks : []) {
      tasks.push({
        source: "bloq_item_task",
        id: Number(t.task_id),
        title: String(t.title ?? "untitled"),
        status: t.status ?? undefined,
        done: Boolean(t.is_completed),
        dueDate: t.due_date ?? undefined,
        itemId: t.item_id ?? undefined,
        itemTitle: t.item_title ?? undefined,
        bloqId: t.bloq_id ?? undefined,
        listId: t.list_id ?? undefined,
      })
    }
    for (const t of Array.isArray(d.lead_tasks) ? d.lead_tasks : []) {
      tasks.push({
        source: "lead_task",
        id: Number(t.task_id),
        title: String(t.title ?? "untitled"),
        done: Boolean(t.is_completed),
        dueDate: t.due_date ?? undefined,
        leadId: t.lead_id ?? undefined,
      })
    }
    for (const j of Array.isArray(d.scheduled_jobs) ? d.scheduled_jobs : []) {
      tasks.push({
        source: "scheduled_job",
        id: Number(j.task_id),
        title: String(j.title ?? "untitled"),
        status: j.status ?? undefined,
        done: false,
        nextRunAt: j.next_run_at ?? undefined,
        frequency: j.frequency ?? undefined,
      })
    }
    for (const b of Array.isArray(d.heartbeat_bloqs) ? d.heartbeat_bloqs : []) {
      tasks.push({
        source: "heartbeat_bloq",
        id: Number(b.bloq_id),
        title: String(b.name ?? `bloq ${b.bloq_id}`),
        done: false,
        bloqId: b.bloq_id ?? undefined,
      })
    }

    const c = d.counts ?? {}
    return {
      measured: true,
      data: {
        counts: {
          itemTasks: Number(c.item_tasks ?? 0),
          leadTasks: Number(c.lead_tasks ?? 0),
          scheduledJobs: Number(c.scheduled_jobs ?? 0),
          heartbeatBloqs: Number(c.heartbeat_bloqs ?? 0),
          // The API's `total` deliberately omits heartbeat boards. Recomputed here so the
          // number over the list counts the rows IN the list — a total that does not match
          // what is on screen is worse than no total.
          total: tasks.length,
        },
        tasks,
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

export interface Integration {
  id: string
  name: string
  provider?: string
  category?: string
  status: string
  connected: boolean
  account?: string
}

/**
 * The account's integrations.
 *
 * NOT bloq-scoped — a connected Gmail is connected for the account, not for a board — so this
 * takes no id. 97 of them here, which is why the UI sorts connected ones first: a list that
 * long is only useful if the answer to "what is actually wired up" is at the top.
 */
export async function fetchIntegrations(): Promise<PlatformResult<{ integrations: Integration[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { integrations: [] } }

  try {
    const res = await irisFetch(`/api/v1/users/${userId}/integrations`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { integrations: [] } }
    const json = (await res.json()) as any
    const raw = json?.integrations ?? json?.data ?? json
    const rows = Array.isArray(raw) ? raw : []
    const integrations: Integration[] = rows.map((r: any) => {
      const status = String(r.status ?? r.local_status ?? "unknown")
      return {
        id: String(r.id ?? r.name ?? ""),
        name: String(r.name ?? r.provider ?? "unnamed"),
        provider: r.provider ?? undefined,
        category: r.category ?? undefined,
        status,
        connected: status === "connected" || status === "active" || Boolean(r.connected_account_id),
        account: r.account_email ?? undefined,
      }
    })
    // Connected first, then by name. The interesting half of 97 rows is the connected half.
    integrations.sort((a, b) => (a.connected === b.connected ? a.name.localeCompare(b.name) : a.connected ? -1 : 1))
    return { measured: true, data: { integrations } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { integrations: [] } }
  }
}

export interface PlaybookStep {
  id: string
  title: string
  /** "shell" runs a command, "prompt" asks a model. The difference is the whole playbook. */
  mode?: string
  integrations?: string[]
}

export interface PlaybookArg {
  name: string
  type?: string
  required?: boolean
  default?: string
  description?: string
}

export interface Playbook {
  name: string
  description?: string
  /** True when attached to THIS board; false when it is one of the account-wide set. */
  attached: boolean
  steps: PlaybookStep[]
  args: PlaybookArg[]
  version?: number
  scope?: string
  accessType?: string
  active?: boolean
  publishedAt?: string
  /** The landing page. 66 of 127 have one. */
  publicUrl?: string
  installs?: number
  views?: number
  /**
   * Whether ~/.iris/playbooks/<name>/PLAYBOOK.md exists on THIS machine.
   *
   * Playbook content never leaves the machine, so the local document is both richer than the
   * API summary and the only place the actual instructions live. The flag is here so the UI
   * can offer the document tab without a second round trip per row.
   */
  hasLocal: boolean
}

/** One playbook's local document, when this machine has it. */
export function readPlaybookDoc(name: string): { found: boolean; content: string; path: string } {
  // The name comes off a list WE produced, but it still lands in a filesystem path, so it is
  // constrained here rather than trusted: a slug, nothing else. `..` in a playbook name would
  // otherwise read any file the sidecar can reach.
  const safe = /^[a-zA-Z0-9._-]+$/.test(name) ? name : ""
  const file = path.join(homedir(), ".iris", "playbooks", safe, "PLAYBOOK.md")
  if (!safe || !existsSync(file)) return { found: false, content: "", path: file }
  try {
    return { found: true, content: readFileSync(file, "utf-8"), path: file }
  } catch {
    return { found: false, content: "", path: file }
  }
}

/** Shared shape for both halves of the playbook list — attached and account-wide. */
function toPlaybook(x: any, attached: boolean): Playbook {
  const name = String(x?.name ?? "unknown")
  return {
    name,
    description: x?.description || undefined,
    attached,
    steps: (Array.isArray(x?.steps_summary) ? x.steps_summary : []).map((s: any) => ({
      id: String(s?.id ?? ""),
      title: String(s?.title ?? s?.id ?? "step"),
      mode: s?.mode || undefined,
      integrations: Array.isArray(s?.integrations) ? s.integrations.map(String) : undefined,
    })),
    // args_schema is an OBJECT keyed by arg name, not an array — the one place this payload
    // changes shape. Reading it as a list gives every playbook zero arguments, silently.
    args: (() => {
      const a = x?.args_schema
      if (Array.isArray(a)) return a.map((v: any) => ({ name: String(v?.name ?? "arg"), ...v }))
      if (a && typeof a === "object")
        return Object.entries(a).map(([k, v]: [string, any]) => ({
          name: k,
          type: v?.type || undefined,
          required: v?.required === true,
          default: v?.default != null ? String(v.default) : undefined,
          description: v?.description || undefined,
        }))
      return []
    })(),
    version: typeof x?.version === "number" ? x.version : undefined,
    scope: x?.scope || undefined,
    accessType: x?.access_type || undefined,
    active: typeof x?.is_active === "boolean" ? x.is_active : undefined,
    publishedAt: x?.published_at || undefined,
    publicUrl: x?.public_url || x?.canonical_url || undefined,
    installs: typeof x?.reach?.installs === "number" ? x.reach.installs : undefined,
    views: typeof x?.reach?.views === "number" ? x.reach.views : undefined,
    hasLocal: existsSync(path.join(homedir(), ".iris", "playbooks", name, "PLAYBOOK.md")),
  }
}

/**
 * Playbooks for a board, and the account's full set.
 *
 * BOTH, flagged, never one or the other. The TUI shipped this as either/or — attached
 * playbooks, or the global list as a fallback when none were attached — and both halves were
 * wrong the same way: with attachments you could not reach your own or the marketplace ones at
 * all, and without them a board-scoped panel listed every global under a one-line disclaimer.
 */
export async function fetchPlaybooks(bloqId: number): Promise<PlatformResult<{ playbooks: Playbook[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { playbooks: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { playbooks: [] } }

  try {
    const [attachedRes, allRes] = await Promise.all([
      irisFetch(`/api/v1/bloqs/${bloqId}/playbooks`),
      irisFetch(`/api/v1/playbooks`, IRIS_API),
    ])

    const unwrap = async (res: Response) => {
      if (!res.ok) return []
      const j = (await res.json()) as any
      const d = j?.playbooks ?? j?.data ?? j
      return Array.isArray(d) ? d : (d?.data ?? [])
    }

    const attached = (await unwrap(attachedRes)).map((x: any) => toPlaybook(x, true))
    const names = new Set(attached.map((p: Playbook) => p.name))
    const others = (await unwrap(allRes))
      .map((x: any) => toPlaybook(x, false))
      .filter((p: Playbook) => !names.has(p.name))

    return {
      measured: attachedRes.ok || allRes.ok,
      reason: attachedRes.ok ? undefined : `board playbooks unavailable (fl-api ${attachedRes.status})`,
      data: { playbooks: [...attached, ...others] },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { playbooks: [] } }
  }
}
