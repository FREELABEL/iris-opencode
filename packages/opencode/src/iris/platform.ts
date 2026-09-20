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
// Aliased: this file already exports GraphNode/GraphEdge for the BOARD-TO-BOARD graph (numeric ids).
// Same names, different graphs — importing them bare silently retyped graphRows.
import {
  buildRelationshipGraph,
  renderedGraph,
  type GraphEdge as InteriorGraphEdge,
  type GraphInputs,
  type GraphNode as InteriorGraphNode,
} from "./relationship-graph"
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
/** Where a board share link is REDEEMED — Elon's /invite/{token}. fl-api returns the token, never the URL. */
export const ELON_WEB = process.env.IRIS_ELON_URL ?? "https://elon.freelabel.net"

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

/**
 * Filter a board's Atlas by a query.
 *
 * APPLIED TO THE WHOLE BOARD, not to a page. fetchAtlas pulls every list and item in one call
 * and pagination slices afterwards, so filtering here searches everything and the count over
 * the results is a true count — filtering the 25 rows a client happens to hold would report
 * "3 of 40" about a set it never looked at.
 *
 * Deliberately NOT the platform's global search: that is Typesense across the whole account
 * and would put another board's items under this board's heading, which is the exposure three
 * separate surfaces were fixed for today (#185117, #185118, #185137).
 *
 * A list matches on its own name OR on any item. When the LIST matched, its items are kept
 * whole — you asked for the list. When only items matched, the list is narrowed to them, so
 * what is on screen is the reason it is on screen.
 */
export function filterAtlas(lists: AtlasList[], query: string): AtlasList[] {
  const q = query.trim().toLowerCase()
  if (!q) return lists
  const hit = (s: unknown) => typeof s === "string" && s.toLowerCase().includes(q)

  const out: AtlasList[] = []
  for (const l of lists) {
    if (hit(l.name)) {
      out.push(l)
      continue
    }
    // Body as well as title: "the item that mentions Servis" is the search people actually run,
    // and a title-only match cannot answer it.
    const items = (l.items ?? []).filter((i) => hit(i.title) || hit(i.content) || hit(i.description))
    if (items.length) out.push({ ...l, items })
  }
  return out
}

export async function fetchAtlas(bloqId: number): Promise<PlatformResult<{ lists: AtlasList[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { lists: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { lists: [] } }

  try {
    /*
     * ?no_searchable_content=1 — drop the duplicate, keep the bodies.
     *
     * `searchable_content` is an $appends accessor that ships a near-copy of `content` on every
     * item. Measured on board 174: 3.42 MB total, of which content is 1,468 KB and its
     * duplicate 1,397 KB. Nothing here reads the duplicate.
     *
     * NOT `?light=1`, which also drops `content` and would be 0.60 MB — 83% off — because two
     * things in this panel read the body: the reader renders it, and the search filters on it.
     * Taking the cheaper number would break search into a title-only match and call it a
     * performance win. That version needs a per-item fetch on open first.
     *
     *   default                     3,590,030 bytes
     *   no_searchable_content=1     2,139,422 bytes   <- here
     *   light=1                       625,237 bytes   <- once the reader fetches bodies
     */
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}?no_searchable_content=1`)
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

export type BillingStatus = {
  plan: string | null
  bypassed: boolean
  fraction: number
  bindingPeriod: string
  capUsd: number
  spentUsd: number
  resetsAt: string | null
  upgradeUrl: string | null
}

/**
 * What the signed-in user may spend, and what they have spent.
 *
 * `measured` matters more here than anywhere else in this file. An unreachable billing endpoint
 * and a user who has spent nothing both produce zero, and rendering the second when it is really
 * the first means a usage indicator that sits reassuringly empty while someone is about to hit a
 * wall. The caller must check `measured` before drawing anything — the same rule the fleet pill
 * learned by getting it wrong.
 */
export async function fetchBilling(): Promise<PlatformResult<{ billing: BillingStatus | null }>> {
  try {
    const res = await irisFetch(`/api/v6/billing/me`, IRIS_API)
    if (res.status === 401) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { billing: null } }
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { billing: null } }
    const json = (await res.json()) as any
    const d = json?.data
    if (!d) return { measured: false, reason: "iris-api returned no data", data: { billing: null } }

    const period = String(d.binding_period ?? "daily")
    const side = period === "monthly" ? d.monthly : d.daily
    return {
      measured: true,
      data: {
        billing: {
          plan: d.plan ?? null,
          bypassed: Boolean(d.bypassed),
          fraction: Number(d.fraction ?? 0),
          bindingPeriod: period,
          capUsd: Number(side?.cap_usd ?? 0),
          spentUsd: Number(side?.spent_usd ?? 0),
          resetsAt: d.resets_at ?? null,
          upgradeUrl: d.upgrade_url ?? null,
        },
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : "unreachable", data: { billing: null } }
  }
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

/**
 * Anything fl-api hands us, as a string the wire schema will accept — or nothing.
 *
 * ## The outage this exists to end
 *
 * Every board that had leads returned HTTP 400 and rendered an empty pane:
 *
 *   Expected string | undefined, got {"source":null} at ["leads"][0]["keywords"]
 *
 * `keywords` came back as an OBJECT on some rows. The mapper handled arrays and scalars and
 * passed everything else through untouched, the response schema rejected the payload, and
 * Effect failed the WHOLE request — 50 leads lost to one field on one row.
 *
 * It survived because of how it failed. The 21 boards with no leads returned a valid empty
 * 200, so the surface looked healthy everywhere anyone happened to click; the four boards that
 * actually had leads — Richard's Signal, KMG, ReachR, Pathways Engagement — were the only ones
 * that broke. An empty list is indistinguishable from a working empty list.
 *
 * So this coerces rather than trusts, and it is applied to EVERY string field, not just the one
 * that was caught: the other six are passed through with the same `?? undefined` that let this
 * one through, and there is nothing special about `keywords` except that someone loaded a board
 * that exercised it.
 */
export function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === "string") return v || undefined
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) {
    const parts = v.map((x) => str(x)).filter((x): x is string => !!x)
    return parts.length ? parts.join(", ") : undefined
  }
  if (typeof v === "object") {
    // `{"source": null}` carries no information — say nothing rather than print "[object Object]".
    const parts = Object.values(v as Record<string, unknown>)
      .map((x) => str(x))
      .filter((x): x is string => !!x)
    return parts.length ? parts.join(", ") : undefined
  }
  return undefined
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
      status: str(l.status),
      company: str(l.company),
      email: str(l.email),
      hot: Number(l.lead_score ?? l.leadScore ?? 0) >= 70,
      score: typeof l.lead_score === "number" ? l.lead_score : undefined,
      type: str(l.lead_type),
      city: str(l.city),
      country: str(l.country),
      createdAt: str(l.created_at),
      repliedAt: typeof l.has_replied === "boolean" ? l.has_replied : undefined,
      keywords: str(l.keywords),
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
  opts: { page?: number; perPage?: number; bloqId?: number } = {},
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
    /*
     * THE DATASET MUST BELONG TO THE BOARD YOU ARE ON.
     *
     * This route took a slug and nothing else. Measured 2026-09-13: asking it for `cases` with
     * no board context returned 2,157 patient records — patient_name, gender, attorney,
     * law_firm, bill_amount, date_of_injury — from a board the caller was not looking at. The
     * schemas LIST had just been narrowed to the board, which made the panel look scoped while
     * the door behind it stayed open; a narrowed index over an unnarrowed fetch is not scoping,
     * it is a hidden link.
     *
     * Resolved from the same schema list the columns come from, so the check and the column
     * definitions cannot disagree about which dataset this is.
     */
    const defn = await schemaRow(slug)
    if (!defn) return { measured: false, reason: `no dataset "${slug}"`, data: { ...empty, page, perPage } }
    if (opts.bloqId != null && Number(defn.bloq_id) !== opts.bloqId) {
      // A REFUSAL, not an empty result. "0 rows" would read as "this dataset is empty".
      return {
        measured: false,
        reason: `"${slug}" belongs to another board`,
        data: { ...empty, page, perPage },
      }
    }

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
        columns: readSchemaFields(defn.fields),
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
 * One schema row, by slug — the source of BOTH the board check and the column definitions.
 *
 * One lookup rather than two on purpose: if the authorisation check and the columns came from
 * different reads they could disagree about which dataset this is, and the failure mode of that
 * disagreement is showing one board's data under another board's column headings.
 */
async function schemaRow(slug: string): Promise<any | null> {
  try {
    const res = await irisFetch(`/api/v1/atlas/schemas`)
    if (!res.ok) return null
    const json = (await res.json()) as any
    const raw = json?.schemas ?? json?.data ?? json
    return (Array.isArray(raw) ? raw : []).find((r: any) => String(r?.slug) === slug) ?? null
  } catch {
    return null
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

export type IntegrationScope = "project" | "organization" | "user"

export interface CatalogEntry {
  type: string
  name: string
  category?: string
  description?: string
  /** "brokered" | "key" | "bridge" | "oauth" — what connecting it actually involves. */
  mode?: string
  oauthRequired: boolean
  functionsCount?: number
  connected: boolean
  logoUrl?: string
  /** What to type. Built from the mode, because the steps genuinely differ. */
  command: string
}

/**
 * Everything you COULD connect, and what connecting each one takes.
 *
 * The connect step is not uniform and pretending it is would send people down the wrong path:
 * a `key` integration wants a credential you already hold, `brokered` and `oauth` open a browser
 * round trip, and `bridge` talks to an app on this Mac rather than to a service at all. The mode
 * is on the row for that reason.
 *
 * Already-connected rows are dropped: this list answers "what can I add", and the ones you have
 * are the other tabs.
 */
export async function fetchCatalog(): Promise<PlatformResult<{ catalog: CatalogEntry[]; attribution?: string }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { catalog: [] } }

  const logoMap = await fetchIntegrationLogos()
  if (!_catalogCache.items.length) return { measured: false, reason: "integration catalogue unavailable", data: { catalog: [] } }

  /*
   * WHAT YOU HAVE, asked of your own account — not read off the catalogue.
   *
   * The catalogue carries an `is_connected` flag and it is false for all 79 rows regardless,
   * so trusting it offered five integrations this account already has: courtlistener, gmail,
   * google-calendar, google-drive, servis-ai. A field that is present, plausible and always
   * the same value is worse than a missing one — it looks like an answer.
   *
   * A failure to read the connected set is NOT treated as "nothing is connected": that would
   * silently restore the same wrong list. The catalogue is returned unfiltered with a reason
   * saying so, which is visible rather than reassuring.
   */
  const mine = await fetchIntegrations({ scope: "all" })
  const connected = new Set(mine.data.integrations.map((i) => i.type).filter(Boolean) as string[])

  const catalog: CatalogEntry[] = _catalogCache.items
    .filter((x: any) => !connected.has(String(x?.type)))
    .map((x: any) => {
      const type = String(x?.type ?? "")
      const mode = _catalogCache.modes[type]
      return {
        type,
        name: String(x?.name ?? type),
        category: x?.category ?? undefined,
        description: x?.description ?? undefined,
        mode,
        oauthRequired: Boolean(x?.oauth_required),
        functionsCount: typeof x?.functions_count === "number" ? x.functions_count : undefined,
        connected: false,
        logoUrl: logoFor(logoMap.logos, type),
        // `iris connect <type>` is the real command — checked against the CLI, not invented.
        // It handles the OAuth and key paths itself, which is why there is one command and not
        // four; the mode is shown so you know what it is about to do.
        command: `iris connect ${type}`,
      }
    })
    .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name))

  return {
    measured: true,
    reason: mine.measured
      ? undefined
      : "could not read your existing integrations, so this list may offer things you already have",
    data: { catalog, attribution: logoMap.attribution },
  }
}

export interface PageDoc {
  id: number
  title: string
  slug?: string
  status: string
  visibility?: string
  /** Feeds `expected_version` on the way back. Without it a save is a blind overwrite. */
  currentVersion?: number
  publicUrl?: string
  json: string
}

/** One page's JSON, for editing. */
export async function fetchPageDoc(id: number): Promise<PlatformResult<PageDoc>> {
  const empty: PageDoc = { id, title: "", status: "unknown", json: "" }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  try {
    const res = await irisFetch(`/api/v1/pages/${id}?include_json=true`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: empty }
    const j = (await res.json()) as any
    const p = j?.data ?? j
    return {
      measured: true,
      data: {
        id: Number(p?.id ?? id),
        title: String(p?.title ?? ""),
        slug: p?.slug ?? undefined,
        status: String(p?.status ?? "unknown"),
        visibility: p?.visibility ?? undefined,
        currentVersion: typeof p?.current_version === "number" ? p.current_version : undefined,
        publicUrl: p?.public_url ?? undefined,
        json: JSON.stringify(p?.json_content ?? {}, null, 2),
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

/**
 * Save a page's JSON.
 *
 * PINNED TO THE VERSION IT WAS READ AT. fl-api accepts `expected_version` and refuses the write
 * if the page has moved since — which is the whole difference between saving and clobbering.
 * `iris pages push` has no divergence check (#183600) and has overwritten other people's work;
 * this path does not repeat that, and a stale save comes back as a REFUSAL naming the conflict
 * rather than as a success that quietly won.
 *
 * The JSON is parsed here, not sent as a string: a malformed document should fail in the editor
 * with a parse error, not reach the server and be stored as a broken page.
 */
export async function savePageDoc(input: {
  id: number
  json: string
  expectedVersion?: number
}): Promise<{ ok: boolean; reason?: string; version?: number }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }

  let parsed: unknown
  try {
    parsed = JSON.parse(input.json)
  } catch (e) {
    return { ok: false, reason: `that is not valid JSON — ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "a page's json_content must be an object" }
  }

  try {
    const body: Record<string, unknown> = { json_content: parsed }
    if (input.expectedVersion != null) body.expected_version = input.expectedVersion
    const res = await irisFetch(`/api/v1/pages/${input.id}`, FL_API, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) {
      // 409 is the good failure: someone else saved while this was open.
      const why = j?.message ?? `fl-api ${res.status}`
      return { ok: false, reason: res.status === 409 ? `${why} — reload before saving again` : String(why) }
    }
    const p = j?.data ?? j
    return { ok: true, version: typeof p?.current_version === "number" ? p.current_version : undefined }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export interface GraphNode {
  id: number
  name: string
  /** How many edges touch it. 0 means isolated, which is most of them. */
  degree: number
}

export interface GraphEdge {
  id: number
  from: number
  to: number
  /** "sibling" | "feeds_into" | "affiliated" — the relation is typed and directional. */
  type: string
}

export interface BloqGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  summary: { nodes: number; edges: number; isolated: number; isolatedPct: number; largestDegree: number }
}

/**
 * The board-to-board relationship graph.
 *
 * THIS IS A REAL ENDPOINT, which is worth saying because the obvious place to look says
 * otherwise: Elon's RelationshipGraph.vue is fed by a computed property in Board.vue that
 * assembles one board's contents client-side. That one has no endpoint. This is a different
 * graph — bloq to bloq, across the account — and fl-api serves it whole at 12 KB, already
 * carrying degree per node and a summary.
 *
 * The summary is the useful part and the panel leads with it: measured on this account, 123 of
 * 160 boards have no relation to anything at all. A drawing would spend its whole area on that
 * fact; a sentence states it.
 */
export async function fetchBloqGraph(): Promise<PlatformResult<BloqGraph>> {
  const empty: BloqGraph = {
    nodes: [],
    edges: [],
    summary: { nodes: 0, edges: 0, isolated: 0, isolatedPct: 0, largestDegree: 0 },
  }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }

  try {
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/graph`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: empty }
    const j = (await res.json()) as any
    const d = j?.data ?? j
    const s = d?.summary ?? {}
    return {
      measured: true,
      data: {
        nodes: (Array.isArray(d?.nodes) ? d.nodes : []).map((n: any) => ({
          id: Number(n?.id),
          name: String(n?.name ?? `bloq ${n?.id}`),
          degree: Number(n?.degree ?? 0),
        })),
        edges: (Array.isArray(d?.edges) ? d.edges : []).map((e: any) => ({
          id: Number(e?.id),
          from: Number(e?.from),
          to: Number(e?.to),
          type: String(e?.type ?? "related"),
        })),
        summary: {
          nodes: Number(s?.nodes ?? 0),
          edges: Number(s?.edges ?? 0),
          isolated: Number(s?.isolated ?? 0),
          isolatedPct: Number(s?.isolated_pct ?? 0),
          largestDegree: Number(s?.largest_degree ?? 0),
        },
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

/**
 * The graph as rows: every CONNECTED board, most-connected first, with what it links to.
 *
 * Not a force layout. 160 nodes and 41 edges in a 500px column is a hairball that answers
 * nothing, and 77% of the nodes have no edge at all — a drawing would spend its whole area
 * rendering that. Sorted by degree, the same data answers "what is central here" in one glance.
 *
 * Edges are directional and both ends are shown, because `feeds_into` read from the wrong end
 * is a different claim.
 */
export function graphRows(g: BloqGraph): {
  id: number
  name: string
  degree: number
  links: { id: number; name: string; type: string; direction: "out" | "in" }[]
}[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const rows = g.nodes
    .filter((n) => n.degree > 0)
    .map((n) => ({
      id: n.id,
      name: n.name,
      degree: n.degree,
      links: g.edges
        .filter((e) => e.from === n.id || e.to === n.id)
        .map((e) => {
          const otherId = e.from === n.id ? e.to : e.from
          return {
            id: otherId,
            name: byId.get(otherId)?.name ?? `bloq ${otherId}`,
            type: e.type,
            direction: (e.from === n.id ? "out" : "in") as "out" | "in",
          }
        }),
    }))
  rows.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
  return rows
}

/** A node in a board's interior graph — ELON's node shape. */
export type InteriorNode = InteriorGraphNode
/** An interior edge — ELON's edge shape. `type` is set only on relation edges, as in ELON. */
export type InteriorEdge = InteriorGraphEdge

/**
 * ONE BOARD'S INTERIOR, fetched the way ELON fetches it and built by ELON'S rules.
 *
 * #185584: desktop's graph had to show the same structure as ELON's, with equal counts as the
 * floor. The previous assembler matched ELON's shape loosely and its rules not at all (one node
 * per lead where ELON clusters by status, no Programs/Workflows hubs, no runs/assigned edges,
 * no related boards), so no board with leads could pass. The rules now live in
 * relationship-graph.ts, a port proven against ELON's own function; this function only has to
 * collect the SAME raw inputs ELON's store collects.
 *
 * SAME REQUESTS, not similar ones — a different query returns a different set and the counts
 * drift even with identical rules:
 *   - scheduled jobs: NO query string, filtered client-side. ELON asks for all of them and keeps
 *     this board's workflow jobs; `?bloq_id=&per_page=50` is a different result set.
 *   - relations: `?direction=both`.  leads: `per_page=50`, ELON's page size.
 *
 * A failed source contributes nothing, exactly as a failed ELON store action leaves its getter
 * empty — but unlike ELON it is NAMED in `unread`, because a missing Leads hub on a board that
 * has leads is indistinguishable from "no leads" otherwise.
 */
export async function fetchBloqInterior(
  bloqId: number,
): Promise<PlatformResult<{ nodes: InteriorNode[]; edges: InteriorEdge[]; unread: string[] }>> {
  const empty = { nodes: [] as InteriorNode[], edges: [] as InteriorEdge[], unread: [] as string[] }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: empty }

  const get = async (path: string) => {
    const res = await irisFetch(path)
    if (!res.ok) throw new Error(`fl-api ${res.status}`)
    return res.json()
  }
  /** ELON unwraps `data.data`; a bare array is accepted because some of these return one. */
  const rows = (j: any): any[] => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [])

  const sources = {
    agents: get(`/api/v1/users/${userId}/bloqs/${bloqId}/agents/with-tasks`),
    scheduledJobs: get(`/api/v1/users/${userId}/bloqs/scheduled-jobs`),
    playbooks: get(`/api/v1/bloqs/${bloqId}/playbooks`),
    relations: get(`/api/v1/user/${userId}/bloqs/${bloqId}/relations?direction=both`),
    leads: get(`/api/v1/users/${userId}/leads?bloq_id=${bloqId}&per_page=50`),
    board: get(`/api/v1/user/${userId}/bloqs/${bloqId}?no_searchable_content=1`),
  }
  const names = Object.keys(sources) as (keyof typeof sources)[]
  const settled = await Promise.allSettled(names.map((k) => sources[k]))
  const got: Record<string, any> = {}
  const unread: string[] = []
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") got[names[i]] = r.value
    else unread.push(`${names[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
  })

  // Without the board itself there is no centre and no lists — nothing ELON would draw either.
  if (!got.board) return { measured: false, reason: unread.join("; ") || "board unreadable", data: { ...empty, unread } }
  const boardBody = got.board?.data ?? got.board

  const inputs: GraphInputs = {
    bloqId,
    boardTitle: boardBody?.name ?? null,
    agents: rows(got.agents),
    scheduledJobs: rows(got.scheduledJobs),
    playbooks: rows(got.playbooks),
    relations: rows(got.relations),
    leads: rows(got.leads),
    lists: Array.isArray(boardBody?.lists) ? boardBody.lists : [],
  }
  const { nodes, edges } = renderedGraph(buildRelationshipGraph(inputs))
  return { measured: true, data: { nodes, edges, unread } }
}

/** The raw inputs, exposed for the parity harness — it must feed ELON's code the same bytes. */
export async function fetchBloqInteriorInputs(bloqId: number): Promise<GraphInputs | null> {
  const userId = await resolveUserId()
  if (!userId) return null
  const j = async (p: string) => {
    const r = await irisFetch(p)
    return r.ok ? r.json() : null
  }
  const rows = (x: any): any[] => (Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : [])
  const [agents, jobs, playbooks, relations, leads, board] = await Promise.all([
    j(`/api/v1/users/${userId}/bloqs/${bloqId}/agents/with-tasks`),
    j(`/api/v1/users/${userId}/bloqs/scheduled-jobs`),
    j(`/api/v1/bloqs/${bloqId}/playbooks`),
    j(`/api/v1/user/${userId}/bloqs/${bloqId}/relations?direction=both`),
    j(`/api/v1/users/${userId}/leads?bloq_id=${bloqId}&per_page=50`),
    j(`/api/v1/user/${userId}/bloqs/${bloqId}?no_searchable_content=1`),
  ])
  const b = board?.data ?? board
  if (!b) return null
  return {
    bloqId,
    boardTitle: b?.name ?? null,
    agents: rows(agents),
    scheduledJobs: rows(jobs),
    playbooks: rows(playbooks),
    relations: rows(relations),
    leads: rows(leads),
    lists: Array.isArray(b?.lists) ? b.lists : [],
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// One item, for EDITING — the card editor (#185485)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The statuses fl-api will accept on an item write (BloqItemController::VALID_ITEM_STATUSES,
 * mirrored by the CLI's BLOQ_ITEM_STATUS_CHOICES). Anything else is refused server-side with a
 * 422, so the editor offers exactly this set rather than a free-text field that fails on save.
 *
 * NOT the same list as the board's card schema: `active` is in the column's enum and absent
 * from the schema vocabulary, and a per-board schema can declare a status id the enum will
 * refuse. The editor shows the schema's labels and writes only what this set allows.
 */
export const ITEM_STATUSES = ["active", "pending", "approved", "rejected", "todo", "in_progress", "done"] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export interface ItemTask {
  id: number
  title: string
  description?: string
  done: boolean
  status?: string
  /** The agent the task is assigned to, if any. Assignment on an item IS a task carrying an agent. */
  agentId?: number
  agentName?: string
  dueDate?: string
  completedAt?: string
  source?: string
  /** Nesting depth from getTasks' tree, flattened so the list reads top to bottom. */
  depth: number
}

/**
 * How a body is stored, which decides how it is SAVED.
 *
 * fl-api's `content` is either a markdown string or a JSON object — Elon writes
 * `{text, body, labels, assignedAgents, attachments, …}`. Replacing a structured body with the
 * string from a textarea would silently drop every one of those keys, so a structured body is
 * saved with `content_merge` (only `text`/`body` change) and a string body with `content`.
 */
export type ContentKind = "markdown" | "structured"

export interface ItemDoc {
  id: number
  title: string
  /** The readable body: the string itself, or a structured body's text. */
  content: string
  contentKind: ContentKind
  description?: string
  /** Elon's "Type" pill — the `card_type` column, NOT the `type` enum (default/research/diary…). */
  cardType?: string
  priority?: string
  status?: string
  dueDate?: string
  listId?: number
  listName?: string
  /** Label names from a structured body, read-only here — labels live inside `content`. */
  labels: string[]
  isPublic: boolean
  publicUrl?: string
  updatedAt?: string
  tasks: ItemTask[]
  /** `tasks` is empty for two reasons; this says which. */
  tasksMeasured: boolean
  tasksReason?: string
}

/**
 * Strip a task row to what the editor shows.
 *
 * fl-api returns each task with its FULL agent embedded — config, system prompt, heartbeat
 * settings, Stripe ids — roughly 10KB per task, and the system prompt is not something a task
 * list should carry to a webview. The editor needs the agent's id and name.
 */
export function readItemTask(t: any, depth = 0): ItemTask {
  return {
    id: Number(t.id),
    title: String(t.title ?? "untitled"),
    description: t.description || undefined,
    done: Boolean(t.is_completed),
    status: t.status ?? undefined,
    agentId: t.agent_id != null ? Number(t.agent_id) : t.agent?.id != null ? Number(t.agent.id) : undefined,
    agentName: t.agent?.name ?? undefined,
    dueDate: t.due_date ? String(t.due_date).slice(0, 10) : undefined,
    completedAt: t.completed_at ?? undefined,
    source: t.source ?? undefined,
    depth,
  }
}

/** getTasks nests children under `children[]`; the editor lists them flat with a depth. */
export function flattenTasks(rows: any[], depth = 0, out: ItemTask[] = []): ItemTask[] {
  for (const t of Array.isArray(rows) ? rows : []) {
    out.push(readItemTask(t, depth))
    if (Array.isArray(t.children) && t.children.length) flattenTasks(t.children, depth + 1, out)
  }
  return out
}

/** `content` as stored: a string, a JSON string of an object, or (from some routes) the object. */
function parseContent(raw: unknown): { kind: ContentKind; text: string; obj?: Record<string, any> } {
  if (raw == null) return { kind: "markdown", text: "" }
  let obj: unknown = raw
  if (typeof raw === "string") {
    const s = raw.trim()
    if (!(s.startsWith("{") && s.endsWith("}"))) return { kind: "markdown", text: raw }
    try {
      obj = JSON.parse(s)
    } catch {
      return { kind: "markdown", text: raw }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { kind: "markdown", text: String(raw) }
  const o = obj as Record<string, any>
  const text = typeof o.text === "string" ? o.text : typeof o.body === "string" ? o.body : ""
  return { kind: "structured", text, obj: o }
}

export function readItemDoc(raw: any): Omit<ItemDoc, "tasks" | "tasksMeasured" | "tasksReason"> {
  const c = parseContent(raw.content)
  const labels: string[] = Array.isArray(c.obj?.labels)
    ? c.obj!.labels.map((l: any) => (typeof l === "string" ? l : String(l?.name ?? l?.label ?? l?.id ?? ""))).filter(Boolean)
    : []
  return {
    id: Number(raw.id),
    title: String(raw.title ?? "Untitled"),
    content: c.text,
    contentKind: c.kind,
    description: raw.description || undefined,
    cardType: raw.card_type || undefined,
    priority: raw.priority || undefined,
    status: raw.status || undefined,
    dueDate: raw.due_date ? String(raw.due_date).slice(0, 10) : undefined,
    listId: raw.bloq_list_id != null ? Number(raw.bloq_list_id) : undefined,
    listName: raw.list_name || undefined,
    labels,
    isPublic: Boolean(raw.is_public),
    publicUrl: raw.public_url || undefined,
    updatedAt: raw.updated_at || undefined,
  }
}

/** fl-api's 422 names the fields; say those rather than the status code. */
function apiFailure(j: any, status: number): string {
  const errs = j?.errors && typeof j.errors === "object" ? Object.values(j.errors).flat().join("; ") : ""
  return String(errs || j?.message || `fl-api ${status}`)
}

/**
 * The item and its tasks, in one reply.
 *
 * Two upstream calls because fl-api keeps them on two routes. They fail independently, and the
 * reply says so: an item whose tasks could not be read is still an item you can edit, with
 * `tasksMeasured: false` rather than a tasks list that claims to be empty.
 */
export async function fetchItem(id: number): Promise<PlatformResult<ItemDoc>> {
  const empty: ItemDoc = {
    id,
    title: "",
    content: "",
    contentKind: "markdown",
    labels: [],
    isPublic: false,
    tasks: [],
    tasksMeasured: false,
  }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }

  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${id}`)
    if (!res.ok) {
      const reason = res.status === 404 ? `no item ${id} visible to this account` : `fl-api ${res.status}`
      return { measured: false, reason, data: empty }
    }
    const json = (await res.json()) as any
    const doc = readItemDoc(json?.data ?? json)

    let tasks: ItemTask[] = []
    let tasksMeasured = false
    let tasksReason: string | undefined
    try {
      const tr = await irisFetch(`/api/v1/user/bloqs/list/item/${id}/tasks`)
      if (tr.ok) {
        const tj = (await tr.json()) as any
        tasks = flattenTasks(tj?.data?.tasks ?? tj?.tasks ?? [])
        tasksMeasured = true
      } else {
        tasksReason = `tasks: fl-api ${tr.status}`
      }
    } catch (e) {
      tasksReason = `tasks: ${e instanceof Error ? e.message : String(e)}`
    }

    return { measured: true, reason: tasksReason, data: { ...doc, tasks, tasksMeasured, tasksReason } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

export interface ItemPatch {
  title?: string
  /** The new body text. HOW it lands depends on `bodyMode` — see ContentKind. */
  body?: string
  bodyMode?: "replace" | "merge"
  status?: string
  priority?: string | null
  cardType?: string | null
  /** YYYY-MM-DD, or null to clear. */
  dueDate?: string | null
  /** Move to another list on the same board. */
  listId?: number
}

/**
 * Build the fl-api body from the editor's patch. Exported so the mapping is testable without
 * the network: a field the editor sets that never reaches the wire is a save that reports
 * success and changes nothing — and `cardType` → `card_type` (not `type`) is exactly the kind
 * of rename that fails that way.
 */
export function itemPatchBody(patch: ItemPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (patch.title !== undefined) body.title = patch.title
  if (patch.body !== undefined) {
    if (patch.bodyMode === "merge") body.content_merge = { text: patch.body, body: patch.body }
    else body.content = patch.body
  }
  if (patch.status !== undefined) body.status = patch.status
  if (patch.priority !== undefined) body.priority = patch.priority
  if (patch.cardType !== undefined) body.card_type = patch.cardType
  if (patch.dueDate !== undefined) body.due_date = patch.dueDate
  if (patch.listId !== undefined) body.bloq_list_id = patch.listId
  return body
}

export async function saveItem(id: number, patch: ItemPatch): Promise<{ ok: boolean; reason?: string }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }

  if (patch.status !== undefined && !(ITEM_STATUSES as readonly string[]).includes(patch.status)) {
    return { ok: false, reason: `"${patch.status}" is not a status fl-api accepts (${ITEM_STATUSES.join(", ")})` }
  }
  const body = itemPatchBody(patch)
  if (Object.keys(body).length === 0) return { ok: false, reason: "nothing to save" }

  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, FL_API, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Add a task to an item. With `agentId` this IS "assign an agent to this card" — there is
 * deliberately no agent column on items; assignment is a task carrying the agent, which is
 * what `iris agents tasks` and the Tasks tab both read back.
 */
export async function addItemTask(
  itemId: number,
  input: { title: string; agentId?: number; dueDate?: string },
): Promise<{ ok: boolean; reason?: string; task?: ItemTask }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  const title = input.title.trim()
  if (!title) return { ok: false, reason: "a task needs a title" }

  try {
    const body: Record<string, unknown> = { title, status: "todo" }
    if (input.agentId != null) body.agent_id = input.agentId
    if (input.dueDate) body.due_date = input.dueDate
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/tasks`, FL_API, {
      method: "POST",
      body: JSON.stringify(body),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    const raw = j?.data ?? j
    return { ok: true, task: raw && raw.id != null ? readItemTask(raw) : undefined }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function saveItemTask(
  itemId: number,
  taskId: number,
  patch: { done?: boolean; title?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  const body: Record<string, unknown> = {}
  if (patch.done !== undefined) body.is_completed = patch.done
  if (patch.title !== undefined) body.title = patch.title
  if (Object.keys(body).length === 0) return { ok: false, reason: "nothing to save" }
  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/tasks/${taskId}`, FL_API, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteItemTask(itemId: number, taskId: number): Promise<{ ok: boolean; reason?: string }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/tasks/${taskId}`, FL_API, { method: "DELETE" })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card editor, second pass (#185506): Sharing · Labels · Attachments · Events · Asks · Chat
// ─────────────────────────────────────────────────────────────────────────────

type Ok = { ok: boolean; reason?: string }

/** One raw item read, shared by the writers below that need the current content or columns. */
async function rawItem(id: number): Promise<{ ok: true; raw: any } | { ok: false; reason: string }> {
  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${id}`)
    if (!res.ok) return { ok: false, reason: res.status === 404 ? `no item ${id} visible to this account` : `fl-api ${res.status}` }
    const j = (await res.json()) as any
    return { ok: true, raw: j?.data ?? j }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function postJson(path: string, body: unknown, method = "POST"): Promise<Ok & { data?: any }> {
  try {
    const res = await irisFetch(path, FL_API, { method, body: body === undefined ? undefined : JSON.stringify(body) })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    return { ok: true, data: j?.data ?? j }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function notSignedIn(): string {
  return `not signed in (token: ${tokenSource()})`
}

// ── Sharing ─────────────────────────────────────────────────────────────────

export interface ShareMember {
  userId: number
  name: string
  email: string
  permission: string
}
export interface ShareLink {
  id: string
  url: string
  createdAt: string
  expiresAt?: string
  uses: number
  revoked: boolean
}
export interface ShareState {
  isPublic: boolean
  publicUrl?: string
  /** private | public | gated | password | expiring — fl-api's ladder label, when it returns one. */
  accessLevel?: string
  /**
   * False when this fl-api build does not return the item's allow-list (showById gained it
   * in fl-api 462c8a5a). An empty `allowedEmails` with this false is NOT "anyone with the
   * link" — it is "cannot see the list from here", and the UI says that instead.
   */
  allowKnown: boolean
  allowedEmails: string[]
  boardDefaults: { allowedEmails: string[] }
  members: ShareMember[]
  links: ShareLink[]
}

/** fl-api stores the allow-list as an array, or as a JSON/CSV string on older rows. One reader. */
export function readEmailList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
  if (typeof v === "string") {
    const s = v.trim()
    if (!s) return []
    if (s.startsWith("[")) {
      try {
        return readEmailList(JSON.parse(s))
      } catch {}
    }
    return s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
  }
  return []
}

/** BloqUserController@index rows: {id, name, email, username, permission: viewer|editor|owner, status, …}. */
export function readShareMember(r: any): ShareMember {
  return {
    userId: Number(r?.id ?? r?.user_id),
    name: String(r?.name ?? r?.username ?? ""),
    email: String(r?.email ?? ""),
    permission: String(r?.permission ?? "viewer"),
  }
}

/**
 * BloqShareLinkController rows: {id, token, permission, expires_at, max_uses, use_count,
 * is_active, is_usable, created_at}. No url — the server's own convention is
 * `<frontend_origin>/invite/<token>`, so that is built here. Revoked = is_active false.
 */
export function readShareLink(r: any): ShareLink {
  const token = r?.token ? String(r.token) : ""
  return {
    id: String(r?.id ?? ""),
    url: token ? `${ELON_WEB}/invite/${token}` : "",
    createdAt: String(r?.created_at ?? ""),
    expiresAt: r?.expires_at ?? undefined,
    uses: Number(r?.use_count ?? 0),
    revoked: r?.is_active === false,
  }
}

/**
 * Four reads folded into one. The ITEM decides `measured`; each board read that fails leaves
 * its list empty and is named in `reason`, so "no members" and "could not list members" stay
 * different sentences.
 */
export async function fetchShareState(itemId: number, bloqId?: number): Promise<PlatformResult<ShareState>> {
  const empty: ShareState = { isPublic: false, allowKnown: false, allowedEmails: [], boardDefaults: { allowedEmails: [] }, members: [], links: [] }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: empty }
  const item = await rawItem(itemId)
  if (!item.ok) return { measured: false, reason: item.reason, data: empty }

  const state: ShareState = {
    ...empty,
    isPublic: Boolean(item.raw.is_public),
    publicUrl: item.raw.public_url || undefined,
    accessLevel: item.raw.access_level || undefined,
    allowKnown: "share_allowed_emails" in item.raw || "share_allowed_domains" in item.raw,
    allowedEmails: [
      ...readEmailList(item.raw.share_allowed_emails),
      ...readEmailList(item.raw.share_allowed_domains).map((x) => (x.startsWith("@") ? x : `@${x}`)),
    ],
  }
  const b = bloqId ?? (item.raw.bloq_id != null ? Number(item.raw.bloq_id) : undefined)
  const problems: string[] = []
  if (b == null) {
    problems.push("board unknown — members, defaults and links not read")
    return { measured: true, reason: problems.join("; "), data: state }
  }

  const reads: [string, string, (d: any) => void][] = [
    [
      "share-defaults",
      `/api/v1/user/bloqs/${b}/share-defaults`,
      (d) => {
        // {allowed_emails: [], allowed_domains: []} — domains shown with a leading @ so a
        // reader can tell "anyone at heyiris.io" from one address at a glance.
        state.boardDefaults = {
          allowedEmails: [...readEmailList(d?.allowed_emails), ...readEmailList(d?.allowed_domains).map((x) => (x.startsWith("@") ? x : `@${x}`))],
        }
      },
    ],
    [
      "shared-users",
      `/api/v1/user/bloqs/${b}/shared-users`,
      (d) => {
        const rows = Array.isArray(d) ? d : (d?.shared_users ?? [])
        state.members = (Array.isArray(rows) ? rows : []).map(readShareMember).filter((m) => m.userId)
      },
    ],
    [
      "share-links",
      `/api/v1/user/bloqs/${b}/share-links`,
      (d) => {
        const rows = Array.isArray(d) ? d : []
        state.links = (Array.isArray(rows) ? rows : []).map(readShareLink).filter((l) => l.id)
      },
    ],
  ]
  await Promise.all(
    reads.map(async ([name, path, apply]) => {
      try {
        const res = await irisFetch(path)
        if (!res.ok) {
          problems.push(`${name}: fl-api ${res.status}`)
          return
        }
        const j = (await res.json()) as any
        apply(j?.data ?? j)
      } catch (e) {
        problems.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }),
  )
  return { measured: true, reason: problems.length ? problems.join("; ") : undefined, data: state }
}

/** Split the UI's one list into fl-api's two: addresses, and domains (with or without the @). */
export function splitAllowList(entries: string[]): { emails: string[]; domains: string[] } {
  const emails: string[] = []
  const domains: string[] = []
  for (const e of readEmailList(entries)) {
    if (e.includes("@") && !e.startsWith("@")) emails.push(e)
    else domains.push(e.replace(/^@/, ""))
  }
  return { emails, domains }
}

/**
 * Public or private. fl-api's make-public is ALSO where the item's allow-list is written
 * (BloqItem::makePublic reads allowed_emails / allowed_domains; nothing else assigns the
 * column), so going public re-sends the list the item already has — otherwise a toggle would
 * silently empty the gate, which is the leak this whole tab is about.
 */
export async function setShareVisibility(itemId: number, pub: boolean): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  if (!pub) {
    const r = await postJson(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/make-private`, {})
    return { ok: r.ok, reason: r.reason }
  }
  const item = await rawItem(itemId)
  if (!item.ok) return { ok: false, reason: item.reason }
  const body: Record<string, unknown> = {}
  const emails = readEmailList(item.raw.share_allowed_emails)
  const domains = readEmailList(item.raw.share_allowed_domains)
  if (emails.length) body.allowed_emails = emails
  if (domains.length) body.allowed_domains = domains
  const r = await postJson(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/make-public`, body)
  return { ok: r.ok, reason: r.reason }
}

/**
 * The item's allow-list. Stored ONLY by make-public, so the card must be public — a private
 * card has no link for the list to guard, and the route says so rather than pretending.
 * An empty list is a legal write: it is sent as [] and means "anyone with the link".
 */
export async function setShareAllowlist(itemId: number, entries: string[]): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const item = await rawItem(itemId)
  if (!item.ok) return { ok: false, reason: item.reason }
  if (!item.raw.is_public) return { ok: false, reason: "Make the card public first — fl-api stores the allow-list on publish, a private card has no link to guard." }
  const { emails, domains } = splitAllowList(entries)
  const r = await postJson(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/make-public`, { allowed_emails: emails, allowed_domains: domains })
  if (!r.ok) return r
  // Read back from the reply's own ladder label: make-public answers access_level, and it is
  // "gated" exactly when a list is stored. "Accepted" and "stored" have differed here before.
  const level = r.data?.access_level
  const want = emails.length + domains.length > 0
  if (level && (level === "gated") !== want) {
    return { ok: false, reason: `fl-api accepted the write but reports access_level "${level}" (expected ${want ? "gated" : "public"})` }
  }
  return { ok: true }
}

export async function inviteMember(bloqId: number, email: string, permission: string): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  // /share wants a user_id; /invite takes an email and creates the account if needed.
  const r = await postJson(`/api/v1/user/bloqs/${bloqId}/invite`, { email, permission, send_notification_email: true })
  return { ok: r.ok, reason: r.reason }
}
export async function setMemberPermission(bloqId: number, memberUserId: number, permission: string): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const r = await postJson(`/api/v1/user/bloqs/${bloqId}/share/${memberUserId}`, { permission }, "PUT")
  return { ok: r.ok, reason: r.reason }
}
export async function revokeMember(bloqId: number, memberUserId: number): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const r = await postJson(`/api/v1/user/bloqs/${bloqId}/share/${memberUserId}`, undefined, "DELETE")
  return { ok: r.ok, reason: r.reason }
}
export async function createShareLink(bloqId: number, expiresInDays?: number): Promise<Ok & { link?: ShareLink }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const body: Record<string, unknown> = { permission: "viewer" }
  if (expiresInDays != null && expiresInDays > 0) body.expires_at = new Date(Date.now() + expiresInDays * 86400_000).toISOString()
  const r = await postJson(`/api/v1/user/bloqs/${bloqId}/share-link`, body)
  if (!r.ok) return { ok: false, reason: r.reason }
  const link = readShareLink(r.data)
  return { ok: true, link: link.id ? link : undefined }
}
export async function revokeShareLink(bloqId: number, linkId: string): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const r = await postJson(`/api/v1/user/bloqs/${bloqId}/share-link/${encodeURIComponent(linkId)}`, undefined, "DELETE")
  return { ok: r.ok, reason: r.reason }
}

// ── Labels ──────────────────────────────────────────────────────────────────

/**
 * Labels live inside content. Structured body → content_merge {labels}. Markdown body → the
 * body becomes {text: <markdown>, labels} — the readable text is unchanged and readItemDoc
 * reads it back as structured. card_type and priority are pinned from the current columns,
 * because fl-api derives both from labels when they are not sent.
 */
export async function setItemLabels(itemId: number, labels: string[]): Promise<PlatformResult<{ labels: string[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { labels: [] } }
  const item = await rawItem(itemId)
  if (!item.ok) return { measured: false, reason: item.reason, data: { labels: [] } }
  const clean = [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))]
  const c = parseContent(item.raw.content)
  // The WHOLE object, not content_merge: fl-api merges with array_replace_recursive, which
  // cannot shrink an array — {labels: [a]} over [a, b] stores [a, b]. Measured on #185518.
  const body: Record<string, unknown> = {}
  if (c.kind === "structured") body.content = JSON.stringify({ ...c.obj, labels: clean })
  else body.content = JSON.stringify({ text: c.text, body: c.text, labels: clean })
  if (item.raw.card_type) body.card_type = item.raw.card_type
  if (item.raw.priority) body.priority = item.raw.priority
  const r = await postJson(`/api/v1/user/bloqs/list/item/${itemId}`, body, "PUT")
  if (!r.ok) return { measured: false, reason: r.reason, data: { labels: [] } }
  const back = await rawItem(itemId)
  const stored = back.ok ? readItemDoc(back.raw).labels : clean
  return { measured: true, data: { labels: stored } }
}

// ── Attachments ─────────────────────────────────────────────────────────────

export interface CardFile {
  id: string
  name: string
  size?: number
  type?: string
  url?: string
  stored: boolean
}

export function readAttachment(a: any, i: number): CardFile {
  const url = a?.url ?? a?.public_url ?? a?.file_url ?? a?.cloud_file?.url ?? a?.cloud_file?.public_url
  return {
    id: String(a?.cloud_file_id ?? a?.id ?? a?.cloud_file?.id ?? `${i}:${a?.name ?? a?.filename ?? ""}`),
    name: String(a?.name ?? a?.filename ?? a?.original_name ?? "file"),
    size: a?.size != null ? Number(a.size) : a?.file_size != null ? Number(a.file_size) : undefined,
    type: a?.type ?? a?.mime_type ?? a?.mime ?? undefined,
    url: url || undefined,
    // Referenced in content but no URL and no cloud file id: Elon's "Missing Files Detected".
    stored: Boolean(url || a?.cloud_file_id || a?.cloud_file?.id),
  }
}

export async function fetchAttachments(itemId: number): Promise<PlatformResult<{ files: CardFile[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { files: [] } }
  const item = await rawItem(itemId)
  if (!item.ok) return { measured: false, reason: item.reason, data: { files: [] } }
  const c = parseContent(item.raw.content)
  const list = Array.isArray(c.obj?.attachments) ? c.obj!.attachments : Array.isArray(item.raw.attachments) ? item.raw.attachments : []
  return { measured: true, data: { files: list.map(readAttachment) } }
}

export async function deleteAttachment(itemId: number, fileId: string): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const item = await rawItem(itemId)
  if (!item.ok) return { ok: false, reason: item.reason }
  const c = parseContent(item.raw.content)
  const list: any[] = Array.isArray(c.obj?.attachments) ? c.obj!.attachments : []
  const gone = list.find((a, i) => readAttachment(a, i).id === fileId)
  const keep = list.filter((a, i) => readAttachment(a, i).id !== fileId)
  if (!gone) return { ok: false, reason: `no attachment ${fileId} on this card` }
  // The stored file first, then the reference — Elon does it in this order too.
  if (gone.cloud_file_id) {
    const del = await postJson(`/api/v1/cloud-files/${gone.cloud_file_id}`, undefined, "DELETE")
    // Already gone is fine — the reference is what is being removed. Laravel says it three ways.
    if (!del.ok && !/not found|404|no query results/i.test(del.reason ?? "")) return { ok: false, reason: `cloud file: ${del.reason}` }
  }
  // Whole object: content_merge cannot remove an array element (array_replace_recursive).
  const r = await postJson(`/api/v1/user/bloqs/list/item/${itemId}`, { content: JSON.stringify({ ...c.obj, attachments: keep }) }, "PUT")
  return { ok: r.ok, reason: r.reason }
}

/**
 * Upload one file to a card. The webview sends it base64 in JSON (the sidecar route is plain
 * JSON, no multipart machinery); this forwards it as multipart to fl-api's cloud-files
 * upload — the same call Elon's CloudFileService makes — then appends the reference to
 * content.attachments in Elon's shape, so both editors list it.
 */
export async function uploadAttachment(
  itemId: number,
  input: { name: string; type?: string; data: string; bloqId?: number },
): Promise<Ok & { file?: CardFile }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const name = input.name.trim() || "file"
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const buf = Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64")
    bytes = new Uint8Array(new ArrayBuffer(buf.length))
    bytes.set(buf)
  } catch (e) {
    return { ok: false, reason: `not valid base64 — ${e instanceof Error ? e.message : String(e)}` }
  }
  if (bytes.length === 0) return { ok: false, reason: "empty file" }
  if (bytes.length > 100 * 1024 * 1024) return { ok: false, reason: "fl-api takes files up to 100MB" }

  const form = new FormData()
  form.append("file", new Blob([bytes], { type: input.type || "application/octet-stream" }), name)
  form.append("user_id", String(userId))
  form.append("bloq_item_id", String(itemId))
  if (input.bloqId != null) form.append("bloq_id", String(input.bloqId))
  form.append("title", name)

  let cloud: any
  try {
    const token = resolveToken()
    const headers: Record<string, string> = { Accept: "application/json" }
    if (token) headers["Authorization"] = `Bearer ${token}`
    // NOT irisFetch: that sets content-type JSON, and multipart must carry its own boundary.
    const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, { method: "POST", headers, body: form })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    cloud = j?.data ?? j
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }

  const ref = {
    id: cloud?.id ?? Date.now(),
    name: cloud?.original_filename ?? name,
    type: input.type || cloud?.filetype || undefined,
    size: bytes.length,
    url: cloud?.filepath ?? cloud?.url ?? undefined,
    cloud_file_id: cloud?.id,
    upload_status: "completed",
    processing_status: cloud?.processing_status ?? "pending",
    is_image: /^image\//.test(input.type ?? ""),
    upload_date: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }
  const item = await rawItem(itemId)
  if (!item.ok) return { ok: false, reason: `uploaded, but the card could not be read to attach it: ${item.reason}` }
  const c = parseContent(item.raw.content)
  const list: any[] = Array.isArray(c.obj?.attachments) ? c.obj!.attachments : []
  const body: Record<string, unknown> =
    c.kind === "structured"
      ? { content_merge: { attachments: [...list, ref] } }
      : { content: JSON.stringify({ text: c.text, body: c.text, attachments: [ref] }) }
  const saved = await postJson(`/api/v1/user/bloqs/list/item/${itemId}`, body, "PUT")
  if (!saved.ok) return { ok: false, reason: `uploaded (cloud file ${ref.cloud_file_id}) but not attached to the card: ${saved.reason}` }
  return { ok: true, file: readAttachment(ref, list.length) }
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface CardEvent {
  id: string
  title: string
  startsAt: string
  endsAt?: string
  kind?: string
}

export function readCardEvent(e: any): CardEvent {
  return {
    id: String(e?.id ?? ""),
    title: String(e?.title ?? "event"),
    startsAt: String(e?.start_date ?? e?.startsAt ?? ""),
    endsAt: e?.end_date ?? e?.endsAt ?? undefined,
    kind: e?.event_type ?? e?.kind ?? undefined,
  }
}

/**
 * fl-api's card-scoped events (content_events, entity_type=item — fl-api a96b7388), plus the
 * item's own due_date as a row so one list holds every date the card carries.
 */
export async function fetchEvents(itemId: number): Promise<PlatformResult<{ events: CardEvent[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { events: [] } }
  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/events`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { events: [] } }
    const j = (await res.json()) as any
    const rows: any[] = j?.data?.events ?? j?.events ?? []
    const events = rows.map(readCardEvent).filter((e) => e.id)
    const item = await rawItem(itemId)
    if (item.ok && item.raw.due_date) events.push({ id: "due", title: "Due", startsAt: String(item.raw.due_date), kind: "due" })
    events.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    return { measured: true, data: { events } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { events: [] } }
  }
}

export async function addEvent(itemId: number, input: { title: string; startsAt: string; endsAt?: string }): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  // MySQL's own format, UTC. fl-api ead6675c parses ISO too; an older build refuses the Z.
  const sql = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 19).replace("T", " ")
  }
  const body: Record<string, unknown> = { title: input.title.trim(), start_date: sql(input.startsAt), event_type: "deadline" }
  if (input.endsAt) body.end_date = sql(input.endsAt)
  const r = await postJson(`/api/v1/user/bloqs/list/item/${itemId}/events`, body)
  return { ok: r.ok, reason: r.reason }
}

// ── Asks ────────────────────────────────────────────────────────────────────

export interface CardAsk {
  id: string
  to: string
  what: string
  dueAt?: string
  status: "open" | "answered"
  answer?: string
}

const ASK_MARK = "ask:"

/** A task IS an ask when its description carries the marker. Exported for the reader test. */
export function readAsk(t: any): CardAsk | null {
  const d = typeof t?.description === "string" ? t.description : ""
  if (!d.startsWith(ASK_MARK)) return null
  let meta: any = {}
  try {
    meta = JSON.parse(d.slice(ASK_MARK.length))
  } catch {
    return null
  }
  return {
    id: String(t.id),
    to: String(meta?.to ?? ""),
    what: String(t.title ?? ""),
    dueAt: t.due_date ? String(t.due_date).slice(0, 10) : undefined,
    status: t.is_completed ? "answered" : "open",
    answer: meta?.answer || undefined,
  }
}

export async function fetchAsks(itemId: number): Promise<PlatformResult<{ asks: CardAsk[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { asks: [] } }
  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/tasks`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { asks: [] } }
    const j = (await res.json()) as any
    const flat: any[] = []
    const walk = (rows: any[]) => {
      for (const t of Array.isArray(rows) ? rows : []) {
        flat.push(t)
        if (Array.isArray(t.children)) walk(t.children)
      }
    }
    walk(j?.data?.tasks ?? j?.tasks ?? [])
    return { measured: true, data: { asks: flat.map(readAsk).filter((a): a is CardAsk => !!a) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { asks: [] } }
  }
}

export async function addAsk(itemId: number, input: { to: string; what: string; dueAt?: string }): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const body: Record<string, unknown> = {
    title: input.what.trim(),
    description: `${ASK_MARK}${JSON.stringify({ to: input.to.trim() })}`,
    status: "todo",
    source: "ask",
  }
  if (input.dueAt) body.due_date = input.dueAt
  const r = await postJson(`/api/v1/user/bloqs/list/item/${itemId}/tasks`, body)
  return { ok: r.ok, reason: r.reason }
}

export async function answerAsk(itemId: number, askId: number, answer?: string): Promise<Ok> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const body: Record<string, unknown> = { is_completed: true }
  if (answer) {
    // Keep the marker: the description is what makes it an ask on the next read.
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}/tasks`)
    const j = res.ok ? ((await res.json()) as any) : null
    const rows: any[] = j?.data?.tasks ?? []
    const t = rows.find((x) => Number(x.id) === askId)
    const cur = readAsk(t)
    body.description = `${ASK_MARK}${JSON.stringify({ to: cur?.to ?? "", answer })}`
  }
  const r = await postJson(`/api/v1/user/bloqs/list/item/${itemId}/tasks/${askId}`, body, "PUT")
  return { ok: r.ok, reason: r.reason }
}

// ── Chat ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string
  role: "user" | "agent"
  text: string
  at: string
  agentName?: string
}

/** BloqItemController@getChatMessages rows. The text key has moved before; read the ones it has used. */
export function readChatMessage(m: any): ChatMessage {
  const role = m?.role === "assistant" || m?.role === "agent" ? "agent" : "user"
  return {
    id: String(m?.id ?? m?.message_id ?? ""),
    role,
    text: String(m?.message ?? m?.content ?? m?.text ?? ""),
    at: String(m?.created_at ?? m?.timestamp ?? m?.at ?? ""),
    agentName: m?.agent_name ?? m?.agent?.name ?? undefined,
  }
}

/**
 * The card's thread — fl-api keeps one per item (…/list/item/{id}/chat/messages), and it is the
 * same thread Elon's Chat tab reads, so a conversation started in either place continues in
 * the other. Nothing is invented on the card.
 */
export async function fetchItemChat(itemId: number): Promise<PlatformResult<{ agentId?: number; messages: ChatMessage[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { messages: [] } }
  try {
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/chat/messages`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { messages: [] } }
    const j = (await res.json()) as any
    const d = j?.data ?? j
    const rows: any[] = Array.isArray(d) ? d : (d?.messages ?? [])
    const messages = rows.map(readChatMessage).filter((m) => m.text)
    // The agent last spoken to, so the picker opens on it.
    const lastAgent = [...rows].reverse().find((m) => m?.agent_id != null)
    return { measured: true, data: { agentId: lastAgent ? Number(lastAgent.agent_id) : undefined, messages } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { messages: [] } }
  }
}

/**
 * One turn. The agent answers through /bloqs/agents/ask with the card as the system message
 * and the thread as history; both sides are then stored on the item's thread so the next
 * open — here or in Elon — shows them.
 */
export async function sendItemChat(
  itemId: number,
  input: { agentId: number; text: string; bloqId?: number },
): Promise<Ok & { message?: ChatMessage }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const item = await rawItem(itemId)
  if (!item.ok) return { ok: false, reason: item.reason }
  const c = parseContent(item.raw.content)
  const thread = await fetchItemChat(itemId)
  const history = thread.data.messages.slice(-12).map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.text }))
  const systemMessage = [
    `You are answering questions about one board card, #${itemId}: "${item.raw.title ?? ""}" (status ${item.raw.status ?? "unknown"}).`,
    `Card body:\n${c.text.slice(0, 6000)}`,
    "Answer from the card. If the card does not say, say so.",
  ].join("\n\n")

  let replyText = ""
  let agentName: string | undefined
  try {
    const res = await irisFetch(`/api/v1/bloqs/agents/ask`, FL_API, {
      method: "POST",
      body: JSON.stringify({ agentId: input.agentId, message: input.text, history, systemMessage, bloqId: input.bloqId }),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: apiFailure(j, res.status) }
    // Raw OpenAI shape for AI agents; {content} for human agents.
    replyText = String(j?.choices?.[0]?.message?.content ?? j?.content ?? j?.data?.content ?? "")
    agentName = j?.agentName ?? j?.agent?.name ?? undefined
    if (!replyText) return { ok: false, reason: "the agent route answered without a reply text" }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }

  const store = async (role: "user" | "assistant", message: string) =>
    postJson(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/chat/messages`, { message, role, agent_id: input.agentId, agent_name: agentName })
  const s1 = await store("user", input.text)
  const s2 = await store("assistant", replyText)
  const unsaved = [s1, s2].filter((x) => !x.ok).map((x) => x.reason).join("; ")
  return {
    ok: true,
    reason: unsaved ? `reply received but not stored on the card's thread: ${unsaved}` : undefined,
    message: { id: String(s2.data?.id ?? `a-${Date.now()}`), role: "agent", text: replyText, at: new Date().toISOString(), agentName },
  }
}

export interface SchemaOption {
  id: string
  label: string
  color?: string
}
export interface CardSchema {
  type: SchemaOption[]
  priority: SchemaOption[]
  status: SchemaOption[]
}

function readOptions(v: unknown): SchemaOption[] {
  if (!Array.isArray(v)) return []
  return v
    .map((o: any) => (typeof o === "string" ? { id: o, label: o } : { id: String(o?.id ?? ""), label: String(o?.label ?? o?.name ?? o?.id ?? ""), color: o?.color || undefined }))
    .filter((o) => o.id)
}

/**
 * The board's card vocabulary — what the Type, Priority and Status pickers offer.
 *
 * Served by fl-api's CardSchemaService: defaults merged with the board's overrides, which is the
 * same `effective` set Elon's Board.vue reads. Hardcoding the defaults here would be the second
 * copy that drifts; Elon's CardEditor already is that copy.
 */
export async function fetchCardSchema(bloqId: number): Promise<PlatformResult<CardSchema>> {
  const empty: CardSchema = { type: [], priority: [], status: [] }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  try {
    const res = await irisFetch(`/api/v1/bloqs/${bloqId}/card-schema`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: empty }
    const j = (await res.json()) as any
    const eff = j?.data?.effective ?? j?.effective ?? j?.data ?? {}
    return {
      measured: true,
      data: { type: readOptions(eff.type), priority: readOptions(eff.priority), status: readOptions(eff.status) },
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
  /**
   * WHOSE credential this is.
   *
   * A connected account is not automatically the whole account's business: a board may use a
   * project credential, an org credential belongs to the organisation, and a user credential is
   * personal. Flattening the three made a board look like it had credentials it cannot use.
   */
  scope: IntegrationScope
  /** The provider key — "gmail", "social-instagram". What an icon is chosen from. */
  type?: string
  lastTested?: string
  /** Why it is failing, when it is. A red dot with no reason is not actionable. */
  lastError?: string
  /** The brand mark, from the platform's own Logo.dev catalogue. Absent is normal. */
  logoUrl?: string
  /** Which brand owns it, when a brand does. 16 of 25 on this account do. */
  brandId?: number
  authMode?: string
  /** The platform has never tested it, so `status` is a guess rather than a measurement. */
  needsTesting?: boolean
  recentlyTested?: boolean
  functionsCount?: number
  /**
   * PLATFORM health for the provider — not your credential.
   *
   * Two different questions that look like one: "is Slack up" and "does your Slack token
   * work". `state` answers the first, `status`/`lastError` the second. A row can be
   * operational and still broken for you, which is most of what people actually hit.
   */
  health?: { state: string; basis?: string; lastVerifiedAt?: string; bars: { state: string; from?: string }[] }
  /** 30 days of call counts, for a sparkline. `band` is the platform's own summary. */
  usage?: { band?: string; series: { day: string; v: number }[] }
}

/**
 * The platform's integration logo map — the same one the public Genesis integrations page uses.
 *
 * NOT constructed here. iris-api serves `logos` keyed by our own integration types alongside a
 * `logo_attribution` string, because attribution is a CONDITION of the Logo.dev free tier. One
 * source means the desktop cannot end up showing marks without the credit that pays for them.
 *
 * Fetched from IRIS_API, not FL_API: /api/v1/integrations/catalog is 200 on freelabel.net and
 * 404 on raichu.
 */
/** Health, usage and function counts from the same catalogue call — one request, not three. */
let _catalogCache: {
  health: Record<string, any>
  usage: Record<string, any>
  functions: Record<string, number>
  items: any[]
  modes: Record<string, string>
} = { health: {}, usage: {}, functions: {}, items: [], modes: {} }

let _logoCache: { logos: Record<string, string>; attribution?: string } | null = null
export async function fetchIntegrationLogos(): Promise<{ logos: Record<string, string>; attribution?: string }> {
  if (_logoCache) return _logoCache
  try {
    const res = await irisFetch(`/api/v1/integrations/catalog`, IRIS_API)
    if (!res.ok) return { logos: {} }
    const j = (await res.json()) as any
    const logos = j?.logos && typeof j.logos === "object" ? (j.logos as Record<string, string>) : {}
    _catalogCache = {
      health: j?.health && typeof j.health === "object" ? j.health : {},
      usage: j?.usage && typeof j.usage === "object" ? j.usage : {},
      functions: Object.fromEntries(
        (Array.isArray(j?.data) ? j.data : []).map((x: any) => [String(x?.type), Number(x?.functions_count ?? 0)]),
      ),
      items: Array.isArray(j?.data) ? j.data : [],
      modes: j?.modes && typeof j.modes === "object" ? j.modes : {},
    }
    // CACHE ONLY A SUCCESS.
    //
    // The first version cached the failure too, so a single unlucky call at boot — the network
    // not up yet, a slow DNS — pinned an empty map for the life of the process and every
    // integration lost its logo until a restart. Observed exactly that: the platform function
    // returned 80 logos while the running server served logoUrl: null for all 25 rows.
    //
    // A failure is a reason to try again, never a result to remember.
    if (!Object.keys(logos).length) return { logos: {} }
    return (_logoCache = { logos, attribution: typeof j?.logo_attribution === "string" ? j.logo_attribution : undefined })
  } catch {
    return { logos: {} }
  }
}

/**
 * The best mark for one integration type.
 *
 * `social-instagram` maps to a /name/ lookup in the catalogue, which renders a generic monogram
 * rather than the Instagram mark — while a plain `instagram` key with the real logo sits in the
 * same map. So a "social-<brand>" type prefers the bare brand when one exists. Measured: that
 * turns Instagram, Facebook, Twitter/X, YouTube, Reddit and Twitch from monograms into logos.
 */
export function logoFor(logos: Record<string, string>, type: string | undefined): string | undefined {
  if (!type) return undefined
  const brand = type.startsWith("social-") ? type.slice("social-".length) : ""
  const aliased = brand === "x" ? "twitter" : brand
  return (aliased && logos[aliased]) || logos[type] || undefined
}

/**
 * The account's integrations.
 *
 * NOT bloq-scoped — a connected Gmail is connected for the account, not for a board — so this
 * takes no id. 97 of them here, which is why the UI sorts connected ones first: a list that
 * long is only useful if the answer to "what is actually wired up" is at the top.
 */
/**
 * The account's integrations, narrowed by SCOPE.
 *
 * `scope` filters here rather than in the client, for the reason every list in this file does:
 * filtering rows the client already holds leaves the footer counting the unfiltered set, so
 * "12 of 25" sits under three rows and describes something else.
 *
 * Scope is DERIVED, because the API does not state it: a row with bloq_id belongs to that
 * board, a row with organization_id to the org, and everything else is personal. Today all 25
 * on this account are personal — which is worth seeing rather than hiding, since it means no
 * board has a credential of its own.
 */
export async function fetchIntegrations(
  opts: { bloqId?: number; scope?: IntegrationScope | "all" } = {},
): Promise<PlatformResult<{ integrations: Integration[]; attribution?: string }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { integrations: [] } }

  const logoMap = await fetchIntegrationLogos()
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/integrations?per_page=200`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { integrations: [] } }
    const json = (await res.json()) as any
    const raw = json?.integrations ?? json?.data ?? json
    const rows = Array.isArray(raw) ? raw : []
    const all: Integration[] = rows.map((r: any) => {
      const status = String(r.status ?? r.local_status ?? "unknown")
      return {
        id: String(r.id ?? r.name ?? ""),
        name: String(r.name ?? r.provider ?? r.type ?? "unnamed"),
        provider: r.provider ?? r.type ?? undefined,
        category: r.category ?? undefined,
        status,
        connected: status === "connected" || status === "active" || Boolean(r.connected_account_id),
        account: r.account_email ?? undefined,
        scope: r.bloq_id != null ? "project" : r.organization_id != null ? "organization" : "user",
        type: r.type ?? undefined,
        lastTested: r.last_tested ?? undefined,
        lastError: r.last_error ? String(r.last_error).slice(0, 400) : undefined,
        logoUrl: logoFor(logoMap.logos, r.type ?? undefined),
        brandId: typeof r.brand_id === "number" ? r.brand_id : undefined,
        authMode: r.auth_mode ?? undefined,
        needsTesting: typeof r.needs_testing === "boolean" ? r.needs_testing : undefined,
        recentlyTested: typeof r.recently_tested === "boolean" ? r.recently_tested : undefined,
        functionsCount: _catalogCache.functions[String(r.type)] ?? undefined,
        health: (() => {
          const h = _catalogCache.health[String(r.type)]
          if (!h) return undefined
          return {
            state: String(h.state ?? "unknown"),
            basis: h.basis ?? undefined,
            lastVerifiedAt: h.last_verified_at ?? undefined,
            bars: (Array.isArray(h.bars) ? h.bars : []).map((b: any) => ({
              state: String(b?.state ?? "unknown"),
              from: b?.from ?? undefined,
            })),
          }
        })(),
        usage: (() => {
          const u = _catalogCache.usage[String(r.type)]
          if (!u) return undefined
          return {
            band: u.band ?? undefined,
            series: (Array.isArray(u.series) ? u.series : []).map((p: any) => ({
              day: String(p?.day ?? ""),
              v: Number(p?.v ?? 0),
            })),
          }
        })(),
      }
    })

    const want = opts.scope ?? "all"
    const integrations =
      want === "all"
        ? all
        : all.filter((i) =>
            want === "project"
              ? // A PROJECT credential means this board's, not "any board's".
                i.scope === "project" && (opts.bloqId == null || Number(rows.find((r: any) => String(r.id) === i.id)?.bloq_id) === opts.bloqId)
              : i.scope === want,
          )

    // Broken first, then connected, then by name. A row that is failing is the one you opened
    // this list to find; burying it under two dozen healthy ones is how it stays broken.
    integrations.sort((a, b) => {
      const rank = (i: Integration) => (i.status === "error" ? 0 : i.connected ? 1 : 2)
      return rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b)
    })
    return { measured: true, data: { integrations, attribution: logoMap.attribution } }
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
  /** The board it is filed against, when it is filed against one. 19 of 128 are. */
  bloqId?: number
  ownerUserId?: number
  /**
   * Whether the SIGNED-IN account owns it.
   *
   * Not a security boundary — the API already decides what it will hand over. It is a reading
   * aid: a list mixing your playbooks with other people's, undifferentiated, makes you assume
   * everything in it is yours to change.
   */
  owned: boolean
  /**
   * Whether ~/.iris/playbooks/<name>/PLAYBOOK.md exists on THIS machine.
   *
   * Playbook content never leaves the machine, so the local document is both richer than the
   * API summary and the only place the actual instructions live. The flag is here so the UI
   * can offer the document tab without a second round trip per row.
   */
  hasLocal: boolean
}

/**
 * One playbook's document — local copy first, published copy second.
 *
 * LOCAL FIRST is not an optimisation. Playbook content never leaves the machine, so for a
 * private playbook the file on disk is the only copy that exists; asking the API first would
 * return nothing for exactly the ones you most want to read. Three of 128 are installed here.
 *
 * The API's detail endpoint carries `content` — the same markdown the public landing page
 * renders — so the remaining 125 are readable too. An iframe of that page would NOT work:
 * heyiris.io sends `x-frame-options: SAMEORIGIN`, so embedding it renders blank, which looks
 * like a broken panel rather than a refused frame.
 */
export async function fetchPlaybookDoc(
  name: string,
): Promise<{ found: boolean; content: string; path: string; source: "local" | "published" | "none" }> {
  const local = readPlaybookDoc(name)
  if (local.found) return { ...local, source: "local" }

  const safe = /^[a-zA-Z0-9._-]+$/.test(name) ? name : ""
  if (!safe) return { found: false, content: "", path: local.path, source: "none" }
  try {
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(safe)}`, IRIS_API)
    if (!res.ok) return { found: false, content: "", path: local.path, source: "none" }
    const json = (await res.json()) as any
    const p = json?.playbook ?? json?.data ?? json
    const content = typeof p?.content === "string" ? p.content : ""
    return content
      ? { found: true, content, path: String(p?.public_url ?? p?.canonical_url ?? ""), source: "published" }
      : { found: false, content: "", path: local.path, source: "none" }
  } catch {
    return { found: false, content: "", path: local.path, source: "none" }
  }
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
    bloqId: typeof x?.bloq_id === "number" ? x.bloq_id : undefined,
    ownerUserId: typeof x?.owner_user_id === "number" ? x.owner_user_id : undefined,
    owned: meId != null && Number(x?.owner_user_id) === meId,
  }
}

/** Who we are, for the `owned` flag. Set once per fetch rather than resolved per row. */
let meId: number | null = null

/**
 * Playbooks for a board, and the account's full set.
 *
 * BOTH, flagged, never one or the other. The TUI shipped this as either/or — attached
 * playbooks, or the global list as a fallback when none were attached — and both halves were
 * wrong the same way: with attachments you could not reach your own or the marketplace ones at
 * all, and without them a board-scoped panel listed every global under a one-line disclaimer.
 */
export type PlaybookView = "project" | "marketplace" | "all"

export async function fetchPlaybooks(bloqId: number, view?: PlaybookView): Promise<PlatformResult<{ playbooks: Playbook[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { playbooks: [] } }

  const unknown = await unknownBloq(bloqId)
  if (unknown) return { measured: false, reason: unknown, data: { playbooks: [] } }

  meId = userId
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

    const rawAll = await unwrap(allRes)

    /*
     * OWNERSHIP BY NAME, for the board's own list.
     *
     * /api/v1/bloqs/{id}/playbooks does not return owner_user_id, so computing `owned` from
     * that row alone made every board-attached playbook read as someone else's — the two
     * Pathways playbooks on board 174 landed under a "Not yours" heading that was simply
     * false. A missing field is not evidence of a different owner.
     *
     * The account list DOES carry the owner, so it is the authority; the board list only says
     * which are attached.
     */
    const ownerByName = new Map<string, number>()
    for (const x of rawAll) if (typeof x?.owner_user_id === "number") ownerByName.set(String(x?.name), x.owner_user_id)

    const attached = (await unwrap(attachedRes)).map((x: any) =>
      toPlaybook({ owner_user_id: ownerByName.get(String(x?.name)), ...x }, true),
    )
    const names = new Set(attached.map((p: Playbook) => p.name))
    const others = rawAll.map((x: any) => toPlaybook(x, false)).filter((p: Playbook) => !names.has(p.name))

    const everything = [...attached, ...others]

    /*
     * TWO VIEWS, because one list of 128 answered neither question.
     *
     * The panel showed every playbook on the account under a board heading — attached ones
     * first and then 120-odd others, alphabetically, indistinguishable. "Which playbooks does
     * this project use" and "what could I install" are different questions and the flat list
     * was the wrong answer to both.
     *
     * PROJECT is attached-to-this-board OR filed against it (bloq_id). 19 of 128 carry a
     * bloq_id at all.
     * MARKETPLACE is what is actually published — public or unlisted. `private` is neither: it
     * is yours and unshared, and listing it as marketplace would misdescribe 42 rows.
     */
    const want = view ?? "all"
    const playbooks =
      want === "project"
        ? everything.filter((p) => p.attached || (p.bloqId != null && p.bloqId === bloqId))
        : want === "marketplace"
          ? everything.filter((p) => (p.scope === "public" || p.scope === "unlisted") && p.bloqId == null)
          : everything

    // YOURS FIRST, then everyone else's. The two are sorted apart rather than interleaved so a
    // list mixing them cannot read as "all of this is mine to change".
    playbooks.sort((a, b) =>
      a.owned === b.owned
        ? a.attached === b.attached
          ? a.name.localeCompare(b.name)
          : a.attached
            ? -1
            : 1
        : a.owned
          ? -1
          : 1,
    )

    return {
      measured: attachedRes.ok || allRes.ok,
      reason: attachedRes.ok ? undefined : `board playbooks unavailable (fl-api ${attachedRes.status})`,
      data: { playbooks },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { playbooks: [] } }
  }
}
