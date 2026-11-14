/**
 * `iris hive search --type files` over the owner's own mesh (#188665, epic #188696 O3).
 *
 * WHY. Through the cloud task queue a file search costs ~3.8–4.4 s although each node's own
 * search is <100 ms: node list ~0.4 s + task create ~0.65 s + node round trip + polling. The bar
 * is "one search returns file hits from two physical machines in under a second". So each of the
 * user's nodes that is reachable on their Tailscale mesh is asked DIRECTLY:
 *
 *   ssh <node>  →  curl 127.0.0.1:3200/api/files/search   (the node daemon's own route)
 *
 * Measured (this Mac → iris-hive-001, RTT 4 ms): cold ssh handshake ~0.45 s, a ControlMaster
 * reused connection ~10–20 ms, the daemon route itself ~30–60 ms.
 *
 * SECURITY. Nothing new listens on the network. Authentication is the user's own ssh key to
 * their own machine; the daemon route stays on 127.0.0.1 and still requires that node's operator
 * token, which the ssh session reads from the node's disk and hands to curl on STDIN (never argv).
 * The node applies its own policy (`hive_search.files = false` → refusal) and its patient-data
 * guard, so this lane returns exactly what the task lane would. The query is user text: it is
 * one single-quoted shell word, never interpreted.
 *
 * FALLBACK. Any node this lane cannot serve — no ssh route, a daemon without the route (404), no
 * curl, a timeout — is handed back to the caller for the cloud task path. A node that REFUSES is
 * not retried elsewhere: the node decided.
 *
 * Kept free of yargs and of real ssh so every decision is testable with the remote faked out.
 */

import { spawn } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"

export interface MeshTarget {
  id: string
  name: string
  host: string
  user: string | null
}

export interface MeshRow {
  source: string
  match: string
  preview: string
  date?: string | null
  provider?: string
  [k: string]: unknown
}

export type MeshOutcome =
  | { kind: "hits"; rows: MeshRow[]; backend: string | null; ms: number }
  | { kind: "refused"; reason: string; ms: number }
  | { kind: "fallback"; reason: string; ms: number }

export interface RunResult {
  code: number | null
  stdout: string
  timedOut: boolean
}

export type Runner = (t: MeshTarget, script: string, timeoutMs: number) => Promise<RunResult>

/** POSIX single-quote. */
export function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** Exit codes the remote script uses to say "this lane cannot serve, use the cloud". */
export const EXIT_NO_TOKEN = 90
export const EXIT_NO_CURL = 91

/**
 * The script run on the node. The token is read there and piped to curl as a header file on
 * stdin (`-H @-`), so it never appears in any process's argv. The last line of output is the
 * HTTP status (000 when the daemon is not listening).
 */
export function remoteScript(query: string, limit: number, port = 3200): string {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 10)))
  const curl =
    `printf 'X-Bridge-Key: %s\\n' "$T" | curl -s -m 5 -G -H @- ` +
    `--data-urlencode ${shq("q=" + query)} --data-urlencode ${shq("limit=" + n)} ` +
    `-w '\\n%{http_code}' "http://127.0.0.1:${Math.floor(port)}$P"`
  // The daemon is normally EMBEDDED in the bridge server (routes under /daemon, behind the
  // bridge's own X-Bridge-Key check); a standalone daemon serves them at the root. Try both.
  return [
    `T=$(cat "$HOME/.iris/bridge-token" 2>/dev/null)`,
    `[ -n "$T" ] || exit ${EXIT_NO_TOKEN}`,
    `command -v curl >/dev/null 2>&1 || exit ${EXIT_NO_CURL}`,
    `for P in /daemon/api/files/search /api/files/search; do R=$(${curl}); case "$R" in *"
404") ;; *) break ;; esac; done`,
    `printf '%s' "$R"`,
  ].join("; ")
}

/** Remote output → outcome. Exported for the test. */
export function parseRemote(r: RunResult, ms: number): MeshOutcome {
  if (r.timedOut) return { kind: "fallback", reason: "no answer on the mesh in time", ms }
  if (r.code === EXIT_NO_TOKEN) return { kind: "fallback", reason: "node has no operator token", ms }
  if (r.code === EXIT_NO_CURL) return { kind: "fallback", reason: "node has no curl", ms }
  if (r.code === 255) return { kind: "fallback", reason: "ssh could not reach the node", ms }
  const out = r.stdout.replace(/\s+$/, "")
  const nl = out.lastIndexOf("\n")
  const status = Number((nl === -1 ? out : out.slice(nl + 1)).trim())
  const body = nl === -1 ? "" : out.slice(0, nl)
  let json: any = null
  try {
    json = JSON.parse(body)
  } catch {
    /* handled below */
  }
  if (status === 403 && json?.disabled) {
    return { kind: "refused", reason: String(json.error ?? "file search is turned off on that machine"), ms }
  }
  if (status === 200 && json && Array.isArray(json.rows)) {
    return { kind: "hits", rows: json.rows, backend: json.backend ?? null, ms }
  }
  if (status === 404) return { kind: "fallback", reason: "node daemon predates the direct route", ms }
  if (status === 0) return { kind: "fallback", reason: "node daemon not listening on 127.0.0.1:3200", ms }
  return { kind: "fallback", reason: `unexpected answer from the node (HTTP ${status || "?"})`, ms }
}

export function controlDir(): string {
  return process.env.IRIS_SSH_CONTROL_DIR || join(homedir(), ".iris", "cm")
}

/** ssh options for a search: short connect timeout, connection reuse where the platform has it. */
export function sshArgs(t: MeshTarget, script: string, platform: string = process.platform): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
  ]
  // ControlMaster keeps one authenticated connection per node for 10 minutes, so the next
  // search pays ~15 ms instead of a ~450 ms handshake. Windows' OpenSSH has no ControlMaster.
  if (platform !== "win32") {
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(), "%C")}`, "-o", "ControlPersist=600")
  }
  args.push(t.user ? `${t.user}@${t.host}` : t.host, script)
  return args
}

/**
 * Run over ssh. stderr is NOT piped: with ControlPersist the backgrounded master inherits it and
 * would hold the pipe open for its whole lifetime, so waiting for 'close' would hang 10 minutes.
 */
export const sshRunner: Runner = (t, script, timeoutMs) =>
  new Promise((resolve) => {
    try {
      if (process.platform !== "win32") {
        if (!existsSync(controlDir())) mkdirSync(controlDir(), { recursive: true, mode: 0o700 })
        chmodSync(controlDir(), 0o700)
      }
    } catch {
      /* ssh falls back to a plain connection if the control socket cannot be made */
    }
    let stdout = ""
    let done = false
    const child = spawn("ssh", sshArgs(t, script), { stdio: ["ignore", "pipe", "ignore"] })
    const finish = (code: number | null, timedOut: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (timedOut) {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }
      resolve({ code, stdout, timedOut })
    }
    const timer = setTimeout(() => finish(null, true), timeoutMs)
    child.stdout.on("data", (b) => {
      stdout += b
      if (stdout.length > 8 << 20) finish(null, true)
    })
    child.on("error", () => finish(255, false))
    child.on("close", (code) => finish(code, false))
  })

/** Search one node directly. Never throws. */
export async function searchNodeOnMesh(
  t: MeshTarget,
  query: string,
  limit: number,
  opts: { run?: Runner; timeoutMs?: number; now?: () => number } = {},
): Promise<MeshOutcome> {
  const now = opts.now ?? (() => performance.now())
  const started = now()
  try {
    const r = await (opts.run ?? sshRunner)(t, remoteScript(query, limit), opts.timeoutMs ?? 2500)
    return parseRemote(r, Math.round(now() - started))
  } catch (e: any) {
    return { kind: "fallback", reason: `mesh error: ${String(e?.message ?? e).slice(0, 80)}`, ms: Math.round(now() - started) }
  }
}

// ── What the node advertises (it also enforces) ──────────────────────────────────────────────

/** `bridge_capabilities.file_search.available === false` → the node turned file search off. */
export function fileSearchOff(node: { bridge_capabilities?: any }): string | null {
  const fs = node?.bridge_capabilities?.file_search
  if (fs && typeof fs === "object" && fs.available === false) {
    return String(fs.reason ?? "file search is turned off on that machine")
  }
  return null
}

// ── Roster: which lane each node took last time, so the next search starts at t=0 ───────────

export interface RosterEntry {
  id: string
  name: string
  lane: "mesh" | "cloud" | "skip"
  host?: string
  user?: string | null
  reason?: string
}

export interface Roster {
  user_id: number
  saved_at: number
  local_node_id: string | null
  nodes: RosterEntry[]
}

export const ROSTER_TTL_MS = 60 * 60 * 1000

export function rosterPath(): string {
  return process.env.IRIS_HIVE_SEARCH_ROSTER || join(homedir(), ".iris", "hive-search-roster.json")
}

/** The roster, if it is this user's and fresh enough to start from without the node list. */
export function readRoster(userId: number, now = Date.now(), path = rosterPath()): Roster | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf-8")) as Roster
    if (!r || r.user_id !== userId || !Array.isArray(r.nodes)) return null
    const age = now - r.saved_at
    if (!(age >= 0 && age < ROSTER_TTL_MS)) return null
    return r
  } catch {
    return null
  }
}

export function writeRoster(r: Roster, path = rosterPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(r, null, 2), { mode: 0o600 })
  } catch {
    /* a lost cache is a slower next search, not an error */
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────────────────────

export interface ListedNode {
  id: string
  name: string
  connection_status?: string
  tailscale_ip?: string | null
  bridge_capabilities?: any
}

export interface NodeReport {
  id: string
  name: string
  lane: "mesh" | "cloud" | "skipped" | "missed"
  hits: number
  ms: number
  reason?: string
}

export interface MeshSearchDeps {
  /** The fresh node list. Started by the caller at t=0; only awaited when there is no roster. */
  nodes: Promise<ListedNode[]>
  /** Is this node the machine we are running on (searched locally instead)? */
  isLocal: (nodes: ListedNode[]) => Promise<(n: ListedNode) => boolean>
  /**
   * Where to ssh, or null to not try the mesh for this node. Callers return a target only for a
   * node with an ssh binding already on this machine, or one advertising the route.
   */
  target: (n: ListedNode) => Promise<{ host: string; user: string | null } | null>
  mesh: (t: MeshTarget) => Promise<MeshOutcome>
  /** The cloud task path. null = the node did not answer. */
  cloud: (n: { id: string; name: string }) => Promise<MeshRow[] | null>
  now?: () => number
  /**
   * Stop waiting for a node after this many ms (0/undefined = wait for every node). A node past it
   * is reported "missed" — never silently dropped — and `onDeadline` is called so the caller can
   * stop polling the cloud for it.
   */
  deadlineMs?: number
  onDeadline?: () => void
}

export interface MeshSearchResult {
  rows: (MeshRow & { node_name: string; node_id: string })[]
  reports: NodeReport[]
  /** The roster to save, or null when the node list did not arrive in time to check it. */
  roster: Roster | null
  /** True when the search started from the roster without waiting for the node list. */
  fromRoster: boolean
}

/**
 * Search every eligible remote node: mesh first where possible, cloud otherwise, all in parallel.
 * With a fresh roster the searches start immediately and the node list is only used to reconcile
 * if it has already arrived; without one, the node list is awaited first.
 */
export async function searchRemoteNodes(
  userId: number,
  roster: Roster | null,
  deps: MeshSearchDeps,
): Promise<MeshSearchResult> {
  const now = deps.now ?? (() => performance.now())
  const t0 = now()
  let listed: ListedNode[] | null = null
  const listDone = deps.nodes.then(
    (n) => {
      listed = n
      return n
    },
    () => null,
  )

  type Done = { node: { id: string; name: string }; report: NodeReport; rows: MeshRow[]; entry: RosterEntry | null }

  const viaCloud = async (node: { id: string; name: string }, why?: string): Promise<Done> => {
    const s = now()
    const rows = await deps.cloud(node)
    const ms = Math.round(now() - s)
    if (!rows) {
      return { node, rows: [], report: { ...node, lane: "missed", hits: 0, ms, reason: why ? `${why}; no answer via the cloud either` : "no answer via the cloud" }, entry: { ...node, lane: "cloud" } }
    }
    const disabled = rows.find((r: any) => r && r.disabled === true)
    if (disabled) return { node, rows: [], report: { ...node, lane: "skipped", hits: 0, ms, reason: String(disabled.preview) }, entry: { ...node, lane: "skip", reason: String(disabled.preview) } }
    return { node, rows, report: { ...node, lane: "cloud", hits: countHits(rows), ms, ...(why ? { reason: why } : {}) }, entry: { ...node, lane: "cloud" } }
  }

  const viaMesh = async (node: { id: string; name: string }, t: { host: string; user: string | null }): Promise<Done> => {
    const o = await deps.mesh({ ...node, host: t.host, user: t.user })
    if (o.kind === "hits") return { node, rows: o.rows, report: { ...node, lane: "mesh", hits: countHits(o.rows), ms: o.ms }, entry: { ...node, lane: "mesh", host: t.host, user: t.user } }
    if (o.kind === "refused") return { node, rows: [], report: { ...node, lane: "skipped", hits: 0, ms: o.ms, reason: o.reason }, entry: { ...node, lane: "skip", reason: o.reason } }
    return viaCloud(node, `mesh: ${o.reason}`)
  }

  const fromEntry = (e: RosterEntry): Promise<Done> => {
    const node = { id: e.id, name: e.name }
    if (e.lane === "skip") {
      return Promise.resolve({ node, rows: [], report: { ...node, lane: "skipped" as const, hits: 0, ms: 0, reason: e.reason ?? "file search is turned off on that machine" }, entry: e })
    }
    if (e.lane === "mesh" && e.host) return viaMesh(node, { host: e.host, user: e.user ?? null })
    return viaCloud(node)
  }

  const fresh = async (n: ListedNode): Promise<Done> => {
    const node = { id: n.id, name: n.name }
    const off = fileSearchOff(n)
    if (off) return { node, rows: [], report: { ...node, lane: "skipped", hits: 0, ms: 0, reason: off }, entry: { ...node, lane: "skip", reason: off } }
    const t = await deps.target(n).catch(() => null)
    return t ? viaMesh(node, t) : viaCloud(node)
  }

  // A node still searching at the deadline is reported, not waited for.
  let deadlineHit = false
  const bounded = (p: Promise<Done>, node: { id: string; name: string }): Promise<Done> => {
    const ms = deps.deadlineMs
    if (!ms || ms <= 0) return p
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<Done>((resolve) => {
      timer = setTimeout(() => {
        deadlineHit = true
        resolve({ node, rows: [], report: { ...node, lane: "missed", hits: 0, ms: Math.round(now() - t0), reason: `no answer within ${Math.round(ms)} ms` }, entry: null })
      }, Math.max(0, ms - (now() - t0)))
    })
    return Promise.race([p.finally(() => clearTimeout(timer)), late])
  }
  const fromEntryB = (e: RosterEntry) => bounded(fromEntry(e), { id: e.id, name: e.name })
  const freshB = (n: ListedNode) => bounded(fresh(n), { id: n.id, name: n.name })

  let done: Done[]
  let localId: string | null = roster?.local_node_id ?? null
  let fromRoster = false

  if (roster) {
    fromRoster = true
    done = await Promise.all(roster.nodes.map(fromEntryB))
    // Reconcile with the node list ONLY if it is already here — waiting for it is the 0.4 s
    // this path exists to avoid. When it is late, the roster stays as it was (it expires).
    if (listed) {
      const list: ListedNode[] = listed
      const local = await deps.isLocal(list)
      const byId = new Map(list.map((n) => [n.id, n]))
      done = done.filter((d) => {
        const n = byId.get(d.node.id)
        if (!n) return false // no longer registered to this account
        const off = fileSearchOff(n)
        if (off && d.report.lane !== "skipped") {
          d.rows = []
          d.report = { ...d.report, lane: "skipped", hits: 0, reason: off }
          d.entry = { ...d.node, lane: "skip", reason: off }
        }
        return true
      })
      const known = new Set(roster.nodes.map((e) => e.id))
      const extra = list.filter((n) => n.connection_status === "online" && !local(n) && !known.has(n.id))
      done.push(...(await Promise.all(extra.map(freshB))))
      localId = list.find((n) => local(n))?.id ?? localId
    }
  } else {
    const list = (await listDone) ?? []
    const local = await deps.isLocal(list)
    localId = list.find((n) => local(n))?.id ?? null
    done = await Promise.all(list.filter((n) => n.connection_status === "online" && !local(n)).map(freshB))
  }
  if (deadlineHit) deps.onDeadline?.()

  const rows = done.flatMap((d) => d.rows.map((r) => ({ ...r, node_name: d.node.name, node_id: d.node.id })))
  const reports = done.map((d) => d.report)
  const nextRoster: Roster | null = listed || !roster
    ? {
        user_id: userId,
        saved_at: Date.now(),
        local_node_id: localId,
        nodes: done
          .map((d) => d.entry ?? roster?.nodes.find((e) => e.id === d.node.id) ?? { ...d.node, lane: "cloud" as const })
          .filter((e): e is RosterEntry => !!e),
      }
    : null
  return { rows, reports, roster: nextRoster, fromRoster }
}

/**
 * What a finished cloud search task yields. A FAILED task is not "0 hits": the cloud refuses to
 * send work to a node it thinks is busy ("is busy (CPU at 168%)", measured 2026-10-23 on a Mac
 * running three agent sessions), and both lanes used to print that as a clean 0. Say why instead.
 */
export function rowsFromCloudTask(task: { status?: string; result?: any; error?: any }): MeshRow[] {
  if (task.status === "failed") {
    const why = task.result?.metadata?.reason ?? task.result?.error ?? task.error ?? "the task failed"
    return [{ source: "files", match: "(not searched)", preview: `refused: ${String(why).slice(0, 160)}`, date: null }]
  }
  try {
    const parsed = JSON.parse(task.result?.output ?? "")
    if (Array.isArray(parsed)) return parsed
  } catch {
    /* output wasn't JSON */
  }
  return []
}

/** Real file hits — not the "(no file results)" / "(file search disabled)" marker rows. */
export function countHits(rows: MeshRow[]): number {
  return rows.filter((r) => r && typeof r.match === "string" && !r.match.startsWith("(")).length
}

/** One line per node, for the human output and --timing. */
export function formatReport(r: NodeReport): string {
  const t = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`
  if (r.lane === "skipped") return `${r.name}  skipped — ${r.reason}`
  if (r.lane === "missed") return `${r.name}  missed — ${r.reason}`
  return `${r.name}  ${r.lane}  ${r.hits} hit(s)  ${t}${r.reason ? `  (${r.reason})` : ""}`
}
