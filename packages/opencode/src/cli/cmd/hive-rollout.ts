// ============================================================================
// `iris hive rollout` — update the IRIS daemon (and the `iris` CLI) on every machine in your
// Hive, one command (#191614).
//
// WHY. `iris daemon update --node <name>` updates ONE machine. Rolling it out by hand to three
// machines on 2026-10-28 needed, per machine: an `iris update` first (the --node path runs the
// node's OWN CLI, and every node's was too old), a restore of files a person had added (fixed in
// daemon update itself — they are now kept), a second look because the hub's node list still
// showed the old commit after the node itself reported the new one (#191641), and a retry for the
// machine that had dropped off the network. This command is that procedure, for any account:
//
//   PLAN     list the nodes → ask every online node (in parallel) for its CLI version, what its
//            daemon's /health reports, and a dry run of the update → one table.
//   EXECUTE  canary first (this machine if it is a node, else the first ready one), then the rest
//            ONE AT A TIME by default. Per node: bring its CLI up to the required version, re-plan,
//            update, then verify BY ASKING THE NODE (its last.json and its /health) — never only
//            the hub. Stop at the first failure or rollback unless --keep-going.
//   SUMMARY  updated / already current / skipped (local edits) / offline / failed, and the exact
//            command that finishes the rest.
//
// Offline and unreachable machines are PENDING, not failures: re-running picks them up. The
// rollout's own tasks are dispatched with `force` (the owner asked for this maintenance; a node
// busy from CPU/memory pressure must not refuse it).
//
// Everything that touches the network goes through RolloutDeps, so the whole flow runs in tests
// against fake nodes (hive-rollout.integration.test.ts). No node names are hard-coded anywhere.
// ============================================================================

import { describeLast, isSha, parseDaemonVersion, short } from "./daemon-update"
import { remoteUpdateScript } from "./daemon-update-fleet"

/** The first CLI release with `iris daemon update` (and its --detach-restart). */
export const MIN_ROLLOUT_CLI = "1.5.21"

// ─── Types ──────────────────────────────────────────────────────────────────────────────────

export type FleetNode = {
  id: string
  name: string
  connection_status: string
  last_heartbeat_at?: string | null
  daemon_version?: unknown
  hardware_profile?: any
  capabilities?: any
}

export type TaskOutcome = {
  /** The task reached a terminal state. false = still queued/running at the bound, or never dispatched. */
  finished: boolean
  exit_code: number | null
  stdout: string
  stderr: string
  /** Dispatch failed (HTTP error, node refused) — the node was never asked. */
  error?: string
  taskId?: string
}

export interface RolloutDeps {
  listNodes(): Promise<FleetNode[]>
  resolveRef(ref: string): Promise<string>
  /** Run a bash script on the node as a Hive task (dispatched with force) and wait for it. */
  run(node: FleetNode, script: string, o: { title: string; timeoutSec: number }): Promise<TaskOutcome>
  /** Best effort: stop a task that did not finish, so it cannot run later unattended. */
  cancel?(taskId: string): Promise<void>
  /** Which node is the machine running this command (null = not a node / cannot tell). */
  localNodeId(): Promise<string | null>
  localCliVersion: string
  sleep(ms: number): Promise<void>
  now(): number
  log(s: string): void
}

export type RowStatus =
  | "ready" //            dry run passed — will update
  | "ready-cli" //        will update after `iris update` brings this node's CLI up to date
  | "up-to-date" //       already runs the target, nothing to do
  | "needs-force" //      local modifications to shipped files (or an unauditable copy)
  | "offline" //          not connected (pending — a rerun picks it up)
  | "unreachable" //      online in the hub, but the task never came back (pending)
  | "duplicate" //        an offline record sharing its name with an online node (stale)
  | "unsupported" //      Windows: no daemonctl, `daemon update` cannot run there
  | "error" //            the node answered, but the dry run failed

export type PlanRow = {
  id: string
  name: string
  os: string
  /** What the NODE says it runs (its /health), else the hub's view. */
  current: string | null
  currentSource: "node" | "hub" | "none"
  /** The hub's view, kept to show when it disagrees with the node (#191641). */
  hubCommit: string | null
  target: string
  cli: string | null
  cliRequired: string
  cliOk: boolean
  /** Modified/missing shipped files + untracked files that conflict with the target. */
  localMods: number | null
  /** Files a person added that will be kept. */
  kept: number | null
  /** Every untracked file a person added (kept by a current CLI, blocking for an old one). */
  added?: number | null
  deps: boolean | null
  status: RowStatus
  detail?: string
  local: boolean
}

export type NodeResultStatus = "updated" | "current" | "skipped-local-mods" | "offline" | "failed" | "not-attempted" | "unsupported" | "duplicate"

export type NodeResult = {
  id: string
  name: string
  status: NodeResultStatus
  from?: string | null
  to?: string | null
  detail?: string
  kept?: string[]
  cliUpdated?: { from: string | null; to: string | null }
  /** What the hub said afterwards, when it disagrees with the node. */
  hubSays?: string | null
}

export type RolloutOptions = {
  ref: string
  nodes?: string[]
  canary?: string
  dryRun?: boolean
  force?: boolean
  keepGoing?: boolean
  parallel?: number
  /** Seconds to wait for each node's helper to report the outcome. */
  waitSec?: number
  pollSec?: number
  confirm?: (plan: RolloutPlan) => Promise<boolean>
}

export type RolloutPlan = { target: string; ref: string; rows: PlanRow[]; canary: PlanRow | null; order: PlanRow[]; error?: string }

export type RolloutReport = {
  target: string
  ref: string
  dryRun: boolean
  plan: PlanRow[]
  /** The node that went (or would go) first. */
  canary?: string | null
  results: NodeResult[]
  stoppedAt?: string
  aborted?: string
  summary: Record<"updated" | "current" | "skipped" | "offline" | "failed" | "notAttempted" | "unsupported" | "duplicate", string[]>
  next: string[]
  ok: boolean
}

// ─── Pure helpers ───────────────────────────────────────────────────────────────────────────

/** "1.5.21" → [1,5,21]; anything else (a dev build says "local") → null. */
export function parseCliVersion(v: string | null | undefined): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * The CLI every node must run: at least the one running the rollout (so every machine updates
 * with the same rules this machine planned with), and never below the first release that has
 * `daemon update`. A dev build here ("local") falls back to the floor.
 */
export function requiredCliVersion(localVersion: string): string {
  const local = parseCliVersion(localVersion)
  const floor = parseCliVersion(MIN_ROLLOUT_CLI)!
  return local && compareVersions(local, floor) > 0 ? local.join(".") : MIN_ROLLOUT_CLI
}

/** Does a node's CLI meet the requirement? An unparsable version only passes if the command exists. */
export function cliMeets(nodeVersion: string | null, required: string, hasUpdateCommand: boolean): boolean {
  if (!hasUpdateCommand) return false
  const v = parseCliVersion(nodeVersion)
  if (!v) return false
  return compareVersions(v, parseCliVersion(required)!) >= 0
}

export function nodeOs(n: FleetNode): string {
  const hp = n.hardware_profile?.os
  if (hp && typeof hp === "object" && hp.label) return String(hp.label)
  const caps = n.capabilities
  if (caps && typeof caps.os === "string") return caps.arch ? `${caps.os}-${caps.arch}` : caps.os
  return "unknown"
}

export function isWindows(n: FleetNode): boolean {
  return /^win/i.test(nodeOs(n)) || n.hardware_profile?.os?.platform === "win32"
}

/** "offline since 2026-10-20 14:03 (8d ago)" — or "never seen". */
export function offlineSince(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "offline (never seen)"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "offline"
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  const ago = s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
  return `offline since ${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC (${ago} ago)`
}

/** Exact id, then exact name, then id prefix, then name prefix — online records win a name tie. */
export function selectNodes(all: FleetNode[], wanted: string[] | undefined): { nodes: FleetNode[]; unknown: string[] } {
  if (!wanted || wanted.length === 0) return { nodes: all, unknown: [] }
  const out: FleetNode[] = []
  const unknown: string[] = []
  const online = (xs: FleetNode[]) => [...xs].sort((a, b) => Number(b.connection_status === "online") - Number(a.connection_status === "online"))
  for (const w of wanted) {
    const t = w.toLowerCase()
    const hit =
      all.find((n) => n.id === w) ??
      online(all.filter((n) => n.name.toLowerCase() === t))[0] ??
      all.find((n) => n.id.startsWith(w)) ??
      online(all.filter((n) => n.name.toLowerCase().startsWith(t)))[0]
    if (!hit) unknown.push(w)
    else if (!out.includes(hit)) out.push(hit)
  }
  return { nodes: out, unknown }
}

/**
 * Offline records that share a name with an ONLINE record are stale re-registrations (#190299):
 * the machine is the online one. Reporting them as "pending: offline" forever would make every
 * rollout look unfinished.
 */
export function staleDuplicates(nodes: FleetNode[]): Set<string> {
  const onlineNames = new Set(nodes.filter((n) => n.connection_status === "online").map((n) => n.name.toLowerCase()))
  return new Set(nodes.filter((n) => n.connection_status !== "online" && onlineNames.has(n.name.toLowerCase())).map((n) => n.id))
}

// ─── The scripts each node runs ─────────────────────────────────────────────────────────────

const FIND_IRIS = [
  'IRIS="$HOME/.iris/bin/iris"; [ -x "$IRIS" ] || IRIS="$(command -v iris || true)"',
  'if [ -z "$IRIS" ]; then echo "@@no_iris=1"; exit 3; fi',
]

// The daemon's own node binary (same order as daemonNode() in daemon-update.ts), used only to
// shrink the dry-run JSON before it travels back: a fleet with a large drift lists hundreds of
// files, and a truncated JSON would read as "the node failed".
const FIND_NODE = [
  'NODE="$(head -n1 "$HOME/.iris/daemon-node" 2>/dev/null || true)"',
  '[ -n "$NODE" ] && [ -x "$NODE" ] || NODE="$(ls -d "$HOME"/.iris/runtime/node-*/bin/node 2>/dev/null | sort -r | head -n1)"',
  '[ -n "$NODE" ] && [ -x "$NODE" ] || NODE="$(command -v node || true)"',
]

const COMPACT_JS =
  "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const p=j.plan||{};const c=p.current||{};" +
  "const cut=(a)=>Array.isArray(a)?a.slice(0,20):[];const n=(a)=>Array.isArray(a)?a.length:0;" +
  "console.log(JSON.stringify({ok:j.ok,status:j.status,from:j.from,to:j.to,detail:j.detail,features:j.features,plan:p.target?{upToDate:p.upToDate,blocked:p.blocked,depsChanged:p.depsChanged,depsReason:p.depsReason," +
  "current:{kind:c.kind,commit:c.commit,note:c.note,modified:cut(c.modified),missing:cut(c.missing),untracked:cut(c.untracked)}," +
  "keptYours:p.keptYours===undefined?undefined:cut(p.keptYours),untrackedConflicts:p.untrackedConflicts===undefined?undefined:cut(p.untrackedConflicts)," +
  "_counts:{modified:n(c.modified),missing:n(c.missing),untracked:n(c.untracked),keptYours:n(p.keptYours),untrackedConflicts:n(p.untrackedConflicts)}}:undefined}))"

const HEALTH = [
  'H="$(curl -fsS --max-time 4 "http://127.0.0.1:${BRIDGE_PORT:-3200}/health" 2>/dev/null || true)"',
  'if [ -n "$H" ]; then echo "@@health_ok=1"; else echo "@@health_ok=0"; fi',
  'echo "@@health_commit=$(printf %s "$H" | grep -o \'"daemon_commit":"[^"]*"\' | head -n1 | sed \'s/.*:"//; s/"$//\')"',
]

/** Read-only: the node's CLI version, its /health, and a dry run of the update. Changes nothing. */
export function probeScript(sha: string): string {
  if (!isSha(sha)) throw new Error(`refusing a non-commit ref: ${sha}`)
  return [
    "#!/bin/bash",
    ...FIND_IRIS,
    'echo "@@cli=$("$IRIS" --version 2>/dev/null | head -n1)"',
    ...HEALTH,
    'if "$IRIS" daemon update --help 2>&1 | grep -q -- "--detach-restart"; then echo "@@has_update=1"; else echo "@@has_update=0"; exit 0; fi',
    ...FIND_NODE,
    'T="$(mktemp)"',
    `"$IRIS" daemon update --ref ${sha} --dry-run --json > "$T" 2>"$T.err"; RC=$?`,
    'echo "@@dry_rc=$RC"',
    'echo "@@plan_begin"',
    'if [ -n "$NODE" ] && "$NODE" -e ' + shellQuote(COMPACT_JS) + ' "$T" 2>/dev/null; then :; else cat "$T"; echo; fi',
    'echo "@@plan_end"',
    'tail -n 5 "$T.err" >&2',
    'rm -f "$T" "$T.err"',
    "exit 0",
  ].join("\n")
}

/** Bring the node's own CLI up to date (the --node path runs THAT CLI). */
export function cliUpdateScript(): string {
  return ["#!/bin/bash", ...FIND_IRIS, 'echo "@@cli_before=$("$IRIS" --version 2>/dev/null | head -n1)"', '"$IRIS" update </dev/null 2>&1 | tail -n 15', 'echo "@@cli=$("$IRIS" --version 2>/dev/null | head -n1)"'].join("\n")
}

/** Ask the node how its update went: the helper's last.json and what its /health says now. */
export function verifyScript(): string {
  return [
    "#!/bin/bash",
    'echo "@@last_begin"',
    'cat "${IRIS_HOME:-$HOME/.iris}/daemon-update/last.json" 2>/dev/null',
    'echo',
    'echo "@@last_end"',
    ...HEALTH,
  ].join("\n")
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ─── Parsing what the node said ─────────────────────────────────────────────────────────────

export type Probe = {
  noIris: boolean
  cli: string | null
  hasUpdate: boolean
  healthOk: boolean
  healthCommit: string | null
  dryRc: number | null
  plan: any | null
}

const tag = (out: string, k: string): string | null => {
  const m = new RegExp(`^@@${k}=(.*)$`, "m").exec(out)
  return m ? m[1].trim() : null
}
const between = (out: string, a: string, b: string): string | null => {
  const i = out.indexOf(`@@${a}`)
  const j = out.indexOf(`@@${b}`, i + 1)
  if (i < 0) return null
  return out.slice(i + a.length + 2, j < 0 ? undefined : j).trim()
}
const lastJson = (s: string | null): any => {
  if (!s) return null
  const i = s.indexOf("{")
  const j = s.lastIndexOf("}")
  if (i < 0 || j < i) return null
  try {
    return JSON.parse(s.slice(i, j + 1))
  } catch {
    return null
  }
}

export function parseProbe(stdout: string): Probe {
  const hc = tag(stdout, "health_commit")
  const rc = tag(stdout, "dry_rc")
  return {
    noIris: tag(stdout, "no_iris") === "1",
    cli: tag(stdout, "cli") || null,
    hasUpdate: tag(stdout, "has_update") === "1",
    healthOk: tag(stdout, "health_ok") === "1",
    healthCommit: isSha(hc) ? hc : null,
    dryRc: rc === null ? null : Number(rc),
    plan: lastJson(between(stdout, "plan_begin", "plan_end")),
  }
}

export function parseVerify(stdout: string): { last: any; healthOk: boolean; healthCommit: string | null } {
  const hc = tag(stdout, "health_commit")
  return { last: lastJson(between(stdout, "last_begin", "last_end")), healthOk: tag(stdout, "health_ok") === "1", healthCommit: isSha(hc) ? hc : null }
}

/** Counts from a dry-run result, full or compacted. */
/** The capability a node's `daemon update` must have before the rollout trusts its plan. */
export const KEEPS_ADDED_FILES = "keeps-added-files"

/**
 * Counts from a dry-run result, full or compacted, split by what they ARE:
 *   shipped  — modified/missing files the install shipped (real edits; need --force)
 *   conflicts — added files at a path the target ships with different bytes (need --force)
 *   added    — every untracked file a person added
 *   kept     — added files the update keeps (only known to a CLI that keeps them)
 * keepsAdded: the node's CLI has the keep-added-files fix. Its absence means an OLD CLI, whose
 * dry run calls every added file a "local change" and whose real update would block on them.
 */
export function planCounts(dry: any): { shipped: number; conflicts: number; added: number; kept: number; keepsAdded: boolean } | null {
  const p = dry?.plan
  if (!p || !p.current) return null
  const c = p.current
  const cnt = p._counts
  const len = (k: string, arr: unknown) => (cnt && typeof cnt[k] === "number" ? cnt[k] : Array.isArray(arr) ? arr.length : 0)
  const keepsAdded = (Array.isArray(dry.features) && dry.features.includes(KEEPS_ADDED_FILES)) || p.keptYours !== undefined
  return {
    shipped: len("modified", c.modified) + len("missing", c.missing),
    conflicts: keepsAdded ? len("untrackedConflicts", p.untrackedConflicts) : 0,
    added: len("untracked", c.untracked),
    kept: keepsAdded ? len("keptYours", p.keptYours) : 0,
    keepsAdded,
  }
}

/** One node's row, from the hub record and (when online) what the node itself answered. */
export function planRow(n: FleetNode, o: { target: string; cliRequired: string; local: boolean; probe?: TaskOutcome; force?: boolean; nowMs: number; duplicate?: boolean }): PlanRow {
  const hub = parseDaemonVersion(n.daemon_version)?.commit ?? null
  const row: PlanRow = {
    id: n.id,
    name: n.name,
    os: nodeOs(n),
    current: hub,
    currentSource: hub ? "hub" : "none",
    hubCommit: hub,
    target: o.target,
    cli: null,
    cliRequired: o.cliRequired,
    cliOk: false,
    localMods: null,
    kept: null,
    deps: null,
    status: "ready",
    local: o.local,
  }
  if (o.duplicate) return { ...row, status: "duplicate", detail: `stale record — "${n.name}" is also registered online; remove this one: iris hive nodes remove ${n.id}` }
  if (n.connection_status !== "online") return { ...row, status: "offline", detail: n.connection_status === "offline" ? offlineSince(n.last_heartbeat_at, o.nowMs) : `${n.connection_status}` }
  if (isWindows(n)) return { ...row, status: "unsupported", detail: "Windows: iris daemon update needs daemonctl (macOS/Linux) — update this machine by reinstalling" }
  const t = o.probe
  if (!t || t.error || !t.finished) {
    return { ...row, status: "unreachable", detail: t?.error ? `could not dispatch: ${t.error}` : "online in the hub, but did not answer within the probe timeout" }
  }
  const pr = parseProbe(t.stdout)
  if (pr.noIris) return { ...row, status: "error", detail: "no iris CLI on this node (install IRIS there, then rerun)" }
  if (pr.healthCommit) {
    row.current = pr.healthCommit
    row.currentSource = "node"
  }
  row.cli = pr.cli
  row.cliOk = cliMeets(pr.cli, o.cliRequired, pr.hasUpdate)
  if (!pr.hasUpdate) {
    // The CLI predates `daemon update`, so it cannot even dry-run. Its daemon is judged from
    // /health; the real plan is made after `iris update`.
    if (row.current === o.target) return { ...row, status: "up-to-date", detail: "CLI predates daemon update, but the daemon already runs the target" }
    return { ...row, status: "ready-cli", detail: `CLI ${pr.cli ?? "unknown"} has no "daemon update" — runs iris update first, then plans` }
  }
  const dry = pr.plan
  const counts = planCounts(dry)
  if (!dry || dry.status !== "dry-run" || !counts) {
    const why = dry?.detail ?? (t.stderr || "").trim().split("\n").slice(-2).join(" / ") ?? ""
    return { ...row, status: "error", detail: `dry run failed${dry?.status ? ` (${dry.status})` : ""}${why ? `: ${why}` : ""}` }
  }
  row.localMods = counts.shipped + counts.conflicts
  row.added = counts.added
  row.kept = counts.keepsAdded ? counts.kept : null
  row.deps = Boolean(dry.plan.depsChanged)
  // A CLI without the keep-added-files fix would block on (or, with --force, drop) files a
  // person added. Its version number alone cannot say that, so the capability gates too.
  row.cliOk = row.cliOk && counts.keepsAdded
  if (!row.current && isSha(dry.from)) {
    row.current = dry.from
    row.currentSource = "node"
  }
  const kind = dry.plan.current.kind
  const addedText = counts.added
    ? counts.keepsAdded
      ? `${counts.added} added file(s) (kept on update)`
      : `${counts.added} added file(s) — old CLI would block; updating CLI first`
    : ""
  const shippedText = counts.shipped ? `${counts.shipped} edit(s) to shipped files` : ""
  const conflictText = counts.conflicts ? `${counts.conflicts} added file(s) at paths the update ships` : ""
  const info = (...xs: string[]) => xs.filter(Boolean).join("; ") || undefined

  // ALREADY AT THE TARGET: nothing to install, whatever else is on the disk. Local files are
  // information, never a reason to run --force on a node that needs nothing.
  if (dry.plan.upToDate || (isSha(row.current) && row.current === o.target)) {
    const local = info(shippedText.replace("edit(s) to shipped files", "local edit(s) to shipped files"), counts.added ? `${counts.added} added file(s)` : "")
    return { ...row, status: "up-to-date", detail: local ? `already at the target; on disk: ${local}` : undefined }
  }
  const forceText = ". --force replaces them; the current copy stays in ~/.iris/bridge.prev"
  if (kind === "unknown" && !o.force)
    return { ...row, status: "needs-force", detail: `a plain copy with no install manifest — local edits cannot be told apart from the version${forceText}` }
  if (!counts.keepsAdded) {
    // An OLD CLI: its "blocked" counts added files too, so decide from the shipped edits alone.
    if (counts.shipped > 0 && !o.force) return { ...row, status: "needs-force", detail: `${info(shippedText, addedText)}${forceText}` }
    return { ...row, status: "ready-cli", detail: info(addedText, `CLI ${pr.cli ?? "unknown"} cannot keep added files — runs iris update first, then re-plans`) }
  }
  if (dry.plan.blocked && !o.force) {
    const why = info(shippedText, conflictText) ?? String(dry.plan.blocked)
    return { ...row, status: "needs-force", detail: `${why}${forceText}${addedText ? `; ${addedText}` : ""}` }
  }
  return {
    ...row,
    status: row.cliOk ? "ready" : "ready-cli",
    detail: row.cliOk ? info(addedText) : info(`CLI ${pr.cli ?? "unknown"} < ${o.cliRequired} — runs iris update first`, addedText),
  }
}

export const isReady = (r: PlanRow) => r.status === "ready" || r.status === "ready-cli"

/**
 * Who goes first. --canary names it (and it must be ready); otherwise the machine running this
 * command when it is a ready node (you are at its keyboard if it breaks); otherwise the first
 * ready node. Everyone else follows in list order.
 */
export function orderRollout(rows: PlanRow[], canaryName?: string): { canary: PlanRow | null; rest: PlanRow[]; error?: string } {
  const ready = rows.filter(isReady)
  let canary: PlanRow | null = null
  if (canaryName) {
    const t = canaryName.toLowerCase()
    const hit = rows.find((r) => r.id === canaryName || r.name.toLowerCase() === t) ?? rows.find((r) => r.id.startsWith(canaryName) || r.name.toLowerCase().startsWith(t))
    if (!hit) return { canary: null, rest: [], error: `--canary ${canaryName}: no such node in this rollout` }
    if (!isReady(hit)) return { canary: null, rest: [], error: `--canary ${hit.name} is not ready to update (${hit.status}${hit.detail ? `: ${hit.detail}` : ""})` }
    canary = hit
  } else {
    canary = ready.find((r) => r.local) ?? ready[0] ?? null
  }
  return { canary, rest: ready.filter((r) => r !== canary) }
}

// ─── Rendering ──────────────────────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<RowStatus, string> = {
  ready: "ready",
  "ready-cli": "ready (CLI update first)",
  "up-to-date": "up to date",
  "needs-force": "needs --force",
  offline: "pending: offline",
  unreachable: "pending: unreachable",
  duplicate: "skip: stale duplicate",
  unsupported: "skip: unsupported",
  error: "error",
}

export function formatPlanTable(plan: { rows: PlanRow[]; target: string; canary?: PlanRow | null }): string[] {
  const head = ["NODE", "OS", "DAEMON (current → target)", "CLI", "LOCAL MODS", "DEPS", "STATUS"]
  const body = plan.rows.map((r) => {
    const cur = r.current ? short(r.current) : "unknown"
    const daemon = r.status === "up-to-date" ? `${cur} = target` : `${cur} → ${short(r.target)}`
    const hubNote = r.currentSource === "node" && r.hubCommit && r.hubCommit !== r.current ? ` (hub: ${short(r.hubCommit)})` : ""
    const cli = r.cli ? `${r.cli}${r.cliOk ? "" : ` (<${r.cliRequired})`}` : "—"
    const mods = r.localMods === null ? "—" : `${r.localMods}${r.added ? ` (+${r.added} added${r.kept === null ? "" : ", kept"})` : ""}`
    const deps = r.deps === null ? "—" : r.deps ? "yes" : "no"
    const name = `${r.name}${r.local ? " (you)" : ""}${plan.canary && plan.canary.id === r.id ? " [canary]" : ""}`
    return [name, r.os, daemon + hubNote, cli, mods, deps, STATUS_TEXT[r.status]]
  })
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cols: string[]) => "  " + cols.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd()
  const out = [line(head), "  " + w.map((n) => "─".repeat(n)).join("  ")]
  for (let i = 0; i < body.length; i++) {
    out.push(line(body[i]))
    const r = plan.rows[i]
    if (r.detail) out.push(`      ${r.detail}`)
  }
  return out
}

export function summarize(target: string, plan: PlanRow[], results: NodeResult[]): { summary: RolloutReport["summary"]; next: string[] } {
  const summary: RolloutReport["summary"] = { updated: [], current: [], skipped: [], offline: [], failed: [], notAttempted: [], unsupported: [], duplicate: [] }
  const key: Record<NodeResultStatus, keyof RolloutReport["summary"]> = {
    updated: "updated",
    current: "current",
    "skipped-local-mods": "skipped",
    offline: "offline",
    failed: "failed",
    "not-attempted": "notAttempted",
    unsupported: "unsupported",
    duplicate: "duplicate",
  }
  for (const r of results) summary[key[r.status]].push(r.name)
  // A node's name is ambiguous when two records share it — say its id then.
  const names = new Map<string, number>()
  for (const p of plan) names.set(p.name.toLowerCase(), (names.get(p.name.toLowerCase()) ?? 0) + 1)
  const ref = (r: NodeResult) => ((names.get(r.name.toLowerCase()) ?? 0) > 1 ? r.id : r.name)
  const pending = results.filter((r) => r.status === "offline" || r.status === "failed" || r.status === "not-attempted").map(ref)
  const forceable = results.filter((r) => r.status === "skipped-local-mods").map(ref)
  const next: string[] = []
  if (pending.length) next.push(`iris hive rollout --ref ${target} --nodes ${pending.join(",")}`)
  if (forceable.length) next.push(`iris hive rollout --ref ${target} --nodes ${forceable.join(",")} --force   # replaces their local edits; the old copies stay in ~/.iris/bridge.prev`)
  return { summary, next }
}

// ─── Orchestration ──────────────────────────────────────────────────────────────────────────

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const q = [...items]
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, q.length)) }, async () => {
    while (q.length) await fn(q.shift()!)
  }))
}

export async function planRollout(deps: RolloutDeps, o: RolloutOptions): Promise<RolloutPlan & { unknown?: string[] }> {
  const target = await deps.resolveRef(o.ref)
  const all = await deps.listNodes()
  const { nodes, unknown } = selectNodes(all, o.nodes)
  if (unknown.length) return { target, ref: o.ref, rows: [], canary: null, order: [], unknown, error: `no node matching: ${unknown.join(", ")} — see: iris hive nodes list` }
  const dups = staleDuplicates(all)
  const localId = await deps.localNodeId().catch(() => null)
  const cliRequired = requiredCliVersion(deps.localCliVersion)
  const probes = new Map<string, TaskOutcome>()
  const toProbe = nodes.filter((n) => n.connection_status === "online" && !isWindows(n) && !dups.has(n.id))
  await pool(toProbe, 8, async (n) => {
    const t = await deps.run(n, probeScript(target), { title: `iris hive rollout: plan ${short(target)}`, timeoutSec: 180 }).catch((e: any) => ({ finished: false, exit_code: null, stdout: "", stderr: "", error: e?.message ?? String(e) }) as TaskOutcome)
    if (!t.finished && t.taskId) await deps.cancel?.(t.taskId).catch(() => {})
    probes.set(n.id, t)
  })
  const rows = nodes.map((n) => planRow(n, { target, cliRequired, local: n.id === localId, probe: probes.get(n.id), force: o.force, nowMs: deps.now(), duplicate: dups.has(n.id) }))
  const ord = orderRollout(rows, o.canary)
  return { target, ref: o.ref, rows, canary: ord.canary, order: ord.canary ? [ord.canary, ...ord.rest] : ord.rest, error: ord.error }
}

/** One node, start to finish. Never throws: every outcome is a NodeResult. */
export async function updateOneNode(deps: RolloutDeps, node: FleetNode, row: PlanRow, o: RolloutOptions): Promise<NodeResult> {
  const base = { id: node.id, name: node.name, from: row.current, to: row.target }
  const say = (s: string) => deps.log(`  ${node.name}: ${s}`)
  const run = (script: string, title: string, timeoutSec: number) =>
    deps.run(node, script, { title, timeoutSec }).catch((e: any) => ({ finished: false, exit_code: null, stdout: "", stderr: "", error: e?.message ?? String(e) }) as TaskOutcome)
  const unreachable = (t: TaskOutcome, what: string): NodeResult =>
    t.error ? { ...base, status: "offline", detail: `${what}: could not dispatch (${t.error})` } : { ...base, status: "offline", detail: `${what}: the node did not answer in time` }

  let cliUpdated: NodeResult["cliUpdated"]
  let current = row
  if (!row.cliOk) {
    say(`CLI ${row.cli ?? "unknown"} → updating (needs ≥ ${row.cliRequired})`)
    const t = await run(cliUpdateScript(), "iris hive rollout: iris update", 600)
    if (!t.finished) {
      if (t.taskId) await deps.cancel?.(t.taskId).catch(() => {})
      return unreachable(t, "iris update")
    }
    // Re-plan with the CLI the update will actually run.
    const p = await run(probeScript(row.target), `iris hive rollout: plan ${short(row.target)}`, 180)
    if (!p.finished) return unreachable(p, "re-plan after iris update")
    current = planRow(node, { target: row.target, cliRequired: row.cliRequired, local: row.local, probe: p, force: o.force, nowMs: deps.now() })
    cliUpdated = { from: row.cli, to: current.cli }
    if (!current.cliOk)
      return { ...base, status: "failed", cliUpdated, detail: `iris update left the CLI at ${current.cli ?? "unknown"}; the rollout needs ≥ ${row.cliRequired} with ${KEEPS_ADDED_FILES}. Output: ${tail(t.stdout)}` }
    say(`CLI ${row.cli ?? "unknown"} → ${current.cli}`)
  }
  if (current.status === "up-to-date") return { ...base, status: "current", cliUpdated }
  if (current.status === "needs-force") return { ...base, status: "skipped-local-mods", cliUpdated, detail: current.detail }
  if (current.status !== "ready") return { ...base, status: "failed", cliUpdated, detail: `${current.status}${current.detail ? `: ${current.detail}` : ""}` }

  say(`updating ${current.current ? short(current.current) : "unknown"} → ${short(row.target)}${current.kept ? ` (keeping ${current.kept} file(s) you added)` : ""}`)
  const up = await run(remoteUpdateScript(row.target, { force: o.force }), `iris hive rollout → ${short(row.target)}`, 900)
  if (!up.finished) {
    if (up.taskId) await deps.cancel?.(up.taskId).catch(() => {})
    return { ...unreachable(up, "update"), cliUpdated }
  }
  const out = up.stdout ?? ""
  if (up.exit_code !== 0) return { ...base, status: "failed", cliUpdated, detail: `the update did not start (exit ${up.exit_code ?? "?"}) — nothing was swapped: ${tail(out + "\n" + up.stderr)}` }
  if (/\bup-to-date\b/.test(out) && !/restart-scheduled/.test(out)) return { ...base, status: "current", cliUpdated }
  // A refusal the node printed is final. A MISSING success marker is not: the hub can hand back the
  // task's stdout cut off before its last line (AlexMaysnow1063, 2026-10-28 — the swap had run and the
  // daemon reported the target, but the marker never arrived and the rollout called it a failure).
  // So fall through to the step that asks the node itself; it decides.
  if (/(^|\n)\s*✗|\brefus(ed|es|ing)\b/i.test(out) && !/restart-scheduled/.test(out))
    return { ...base, status: "failed", cliUpdated, detail: `the node refused the update: ${tail(out)}` }
  if (!/restart-scheduled/.test(out)) say("no 'restart-scheduled' in the task output (it may be cut off) — asking the node what happened")

  // VERIFY BY ASKING THE NODE (#191641: the hub's list can lag or be wrong). The helper's
  // last.json says what happened; /health says what runs. Both must name the target.
  const deadline = deps.now() + (o.waitSec ?? 420) * 1000
  let lastText = "no answer yet"
  while (deps.now() < deadline) {
    await deps.sleep((o.pollSec ?? 10) * 1000)
    const v = await run(verifyScript(), "iris hive rollout: verify", 60)
    if (!v.finished) {
      lastText = "the daemon is restarting (task not picked up yet)"
      if (v.taskId) await deps.cancel?.(v.taskId).catch(() => {})
      continue
    }
    const pv = parseVerify(v.stdout)
    const d = describeLast(pv.last, deps.now())
    lastText = d.text
    if (!d.final) continue
    const kept = Array.isArray(pv.last?.kept) ? pv.last.kept : undefined
    if (pv.last?.status === "updated" && pv.last?.to === row.target) {
      if (pv.healthCommit === row.target) {
        say(`✓ runs ${short(row.target)} (its /health says so)`)
        return { ...base, status: "updated", cliUpdated, kept }
      }
      lastText = `helper says updated, but /health reports ${pv.healthCommit ? short(pv.healthCommit) : pv.healthOk ? "no commit" : "nothing (not answering)"}`
      continue
    }
    if (pv.last?.status === "updated" && pv.last?.to !== row.target) {
      lastText = `last.json is from another update (${short(pv.last?.to)})`
      continue
    }
    return { ...base, status: "failed", cliUpdated, kept, detail: `${d.text}${pv.healthCommit ? `; /health reports ${short(pv.healthCommit)}` : ""}` }
  }
  return {
    ...base,
    status: "failed",
    cliUpdated,
    detail: `no verified outcome within ${o.waitSec ?? 420}s (last: ${lastText}). Look: iris hive run ${node.id} "cat ~/.iris/daemon-update/last.json ~/.iris/daemon-update/finish.log"`,
  }
}

function tail(s: string, n = 3): string {
  return (s || "").trim().split("\n").filter(Boolean).slice(-n).join(" / ") || "(no output)"
}

export async function runRollout(deps: RolloutDeps, o: RolloutOptions): Promise<RolloutReport> {
  const plan = await planRollout(deps, o)
  const empty = { updated: [], current: [], skipped: [], offline: [], failed: [], notAttempted: [], unsupported: [], duplicate: [] }
  const report: RolloutReport = { target: plan.target, ref: o.ref, dryRun: Boolean(o.dryRun), plan: plan.rows, canary: plan.canary?.id ?? null, results: [], summary: empty, next: [], ok: true }
  if (plan.error) return { ...report, aborted: plan.error, ok: false }

  // Rows that are not ready end here with their own outcome.
  const fromPlan = (r: PlanRow): NodeResult | null => {
    const b = { id: r.id, name: r.name, from: r.current, to: r.target, detail: r.detail }
    switch (r.status) {
      case "up-to-date":
        return { ...b, status: "current" }
      case "needs-force":
        return { ...b, status: "skipped-local-mods" }
      case "offline":
      case "unreachable":
        return { ...b, status: "offline" }
      case "unsupported":
        return { ...b, status: "unsupported" }
      case "duplicate":
        return { ...b, status: "duplicate" }
      case "error":
        return { ...b, status: "failed" }
      default:
        return null
    }
  }
  const settled = new Map<string, NodeResult>()
  for (const r of plan.rows) {
    const x = fromPlan(r)
    if (x) settled.set(r.id, x)
  }
  const finish = (): RolloutReport => {
    const results = plan.rows.map((r) => settled.get(r.id) ?? { id: r.id, name: r.name, status: "not-attempted" as const, from: r.current, to: r.target })
    const s = summarize(plan.target, plan.rows, results)
    return { ...report, results, summary: s.summary, next: s.next, ok: results.every((r) => r.status !== "failed") }
  }

  if (o.dryRun) {
    // A dry run changes nothing; the "results" say what WOULD happen.
    for (const r of plan.order) settled.set(r.id, { id: r.id, name: r.name, status: "not-attempted", from: r.current, to: r.target, detail: "dry run" })
    const f = finish()
    return { ...f, next: [], ok: !plan.rows.some((r) => r.status === "error") }
  }
  if (plan.order.length === 0) return finish()
  if (o.confirm && !(await o.confirm(plan))) return { ...finish(), aborted: "not confirmed — nothing was changed" }

  const nodes = new Map((await deps.listNodes()).map((n) => [n.id, n]))
  let stoppedAt: string | undefined
  const doOne = async (r: PlanRow) => {
    const node = nodes.get(r.id) ?? { id: r.id, name: r.name, connection_status: "online" }
    const res = await updateOneNode(deps, node, r, o)
    settled.set(r.id, res)
    if (res.status === "failed" && !stoppedAt) stoppedAt = r.name
  }

  // The canary goes alone, and a failed canary always stops the rollout — that is what it is for.
  const [canary, ...rest] = plan.order
  deps.log(`  canary: ${canary.name}`)
  await doOne(canary)
  if (settled.get(canary.id)?.status !== "failed") {
    await pool(rest, Math.max(1, o.parallel ?? 1), async (r) => {
      if (stoppedAt && !o.keepGoing) return
      await doOne(r)
    })
  }

  // The hub's view afterwards, shown only where it disagrees with what the node said (#191641).
  try {
    const after = new Map((await deps.listNodes()).map((n) => [n.id, parseDaemonVersion(n.daemon_version)?.commit ?? null]))
    for (const res of settled.values()) {
      if (res.status !== "updated") continue
      const hub = after.get(res.id) ?? null
      if (hub !== plan.target) res.hubSays = hub
    }
  } catch {}
  return { ...finish(), stoppedAt }
}

export function formatReport(r: RolloutReport): string[] {
  const L: string[] = []
  const lines: Array<[keyof RolloutReport["summary"], string]> = [
    ["updated", "updated"],
    ["current", "already current"],
    ["skipped", "skipped (local edits — needs --force)"],
    ["offline", "pending (offline/unreachable)"],
    ["failed", "FAILED"],
    ["notAttempted", "not attempted"],
    ["unsupported", "unsupported"],
    ["duplicate", "stale duplicate records"],
  ]
  for (const [k, label] of lines) if (r.summary[k].length) L.push(`  ${label.padEnd(38)} ${r.summary[k].length}  ${r.summary[k].join(", ")}`)
  for (const x of r.results) {
    if (x.status === "failed") L.push(`  ✗ ${x.name}: ${x.detail ?? "failed"}`)
    if (x.status === "offline" && x.detail) L.push(`  … ${x.name}: ${x.detail}`)
    if (x.kept?.length) L.push(`  ${x.name}: kept ${x.kept.length} file(s) you added: ${x.kept.slice(0, 8).join(", ")}${x.kept.length > 8 ? ", …" : ""}`)
    if (x.cliUpdated) L.push(`  ${x.name}: CLI ${x.cliUpdated.from ?? "?"} → ${x.cliUpdated.to ?? "?"}`)
    if (x.status === "updated" && x.hubSays !== undefined)
      L.push(`  ${x.name}: the node runs ${short(r.target)}; the hub's list still says ${x.hubSays ? short(x.hubSays) : "unknown"} (it catches up on a later heartbeat — #191641)`)
  }
  if (r.stoppedAt) L.push(`  stopped after ${r.stoppedAt} failed${r.summary.notAttempted.length ? ` — ${r.summary.notAttempted.length} node(s) not attempted (--keep-going continues past failures)` : ""}`)
  if (r.next.length) {
    L.push("  to finish the rest:")
    for (const n of r.next) L.push(`    ${n}`)
  }
  return L
}
