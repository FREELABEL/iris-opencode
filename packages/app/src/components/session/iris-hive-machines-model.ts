/**
 * Hive › Machines — the pure half (heyiris.io/p/hive-panel-directions#pick).
 *
 * "Team of computers": one card per computer (registrations of the same hardware fold together),
 * a triage line on top, problems written as sentences on the computer they belong to, and the
 * same fleet as a map one click away. Every rule here is testable without a DOM or a network.
 */
import { ago, diskOf, groupComputers, type Computer, type HiveNodeRow } from "./iris-hive-scripts-model"
import type { HiveSessionNode } from "./iris-hive-sessions-model"

export type { Computer }

/**
 * One card per computer. Work done is the sum over every registration: the MacBook did 734 tasks
 * as its current record and 492 more as two older ones, and "1,226 done" is what it has done.
 */
export function machinesOf(nodes: readonly HiveNodeRow[]): Computer[] {
  const done = new Map(nodes.map((n) => [n.id, n.tasksCompleted ?? 0]))
  return groupComputers(nodes).map((c) => ({ ...c, tasksCompleted: c.ids.reduce((t, id) => t + (done.get(id) ?? 0), 0) }))
}

export type HivePeerRow = {
  id: string
  name: string
  status: string
  active: boolean
  inviter: boolean
  inviteCode?: string
  permissions?: string[]
  expiresAt?: string
}

export type Attention = {
  kind: "disk" | "silent" | "dupes"
  /** `crit` can break a run now; `warn` will; `info` is housekeeping. */
  level: "crit" | "warn" | "info"
  text: string
  /** What to do about it, in words — shown under the problem. */
  fix: string
}

/** A disk under 5 GB or 2% free fails the first run that writes anything. */
export const DISK_LOW_GB = 5
/** A hardware snapshot older than this is shown with its age, not as a fact about now. */
const SNAPSHOT_STALE_MS = 6 * 3600_000

export function gb(n: number): string {
  if (n >= 100) return `${Math.round(n).toLocaleString("en-US")} GB`
  return `${n.toFixed(1)} GB`
}

export function attentionOf(c: Computer, now: number): Attention[] {
  const out: Attention[] = []
  const d = diskOf(c)
  if (d && (d.free < DISK_LOW_GB || d.pct < 2)) {
    const t = c.hardwareDetectedAt ? Date.parse(c.hardwareDetectedAt) : NaN
    const stale = Number.isFinite(t) && now - t > SNAPSHOT_STALE_MS
    out.push({
      kind: "disk",
      level: d.free < 1 || d.pct < 1 ? "crit" : "warn",
      text: `Disk almost full — ${gb(d.free)} free${stale ? ` (as of ${ago(c.hardwareDetectedAt, now)})` : ""}`,
      fix: "Clear space on it. A run that writes anything can fail on a full disk.",
    })
  }
  if (c.online && !(c.capabilities ?? []).length)
    out.push({
      kind: "silent",
      level: "warn",
      text: "Not reporting what it can do",
      fix: "Restart its Hive daemon. Scripts that need a skill will skip it until it reports again.",
    })
  // No restart rule: `recent_restarts` is the last 20 restarts with no time window (the hub keeps
  // a capped list), so every long-lived computer reads 20 and the rule flagged the whole fleet.
  if (c.regs > 1)
    out.push({
      kind: "dupes",
      level: "info",
      text: `Registered ${c.regs} times — same computer`,
      fix: "Old registrations of this computer. They never take work while this one is online.",
    })
  return out
}

/** The line under a computer's name: can it take work, and how much. */
export function statusOf(c: HiveNodeRow, now: number): { text: string; tone: "free" | "busy" | "full" | "away" } {
  if (!c.online) {
    if (!c.lastHeartbeat) return { text: "Never connected", tone: "away" }
    const a = ago(c.lastHeartbeat, now)
    return { text: a === "just now" ? "Just went away" : `Away since ${a}`, tone: "away" }
  }
  const max = c.maxConcurrent ?? 0
  const busy = c.activeTasks ?? 0
  if (max <= 0) return { text: busy ? `Online — ${busy} running` : "Online", tone: busy ? "busy" : "free" }
  const room = max - busy
  if (busy === 0) return { text: `Free — can take ${max} task${max === 1 ? "" : "s"}`, tone: "free" }
  if (room > 0) return { text: `Busy — ${busy} running, room for ${room}`, tone: "busy" }
  return { text: `Full — ${busy} of ${max} running`, tone: "full" }
}

export function fleetSummary(cs: readonly Computer[], now: number) {
  const online = cs.filter((c) => c.online).length
  const attention = cs.filter((c) => attentionOf(c, now).some((a) => a.level !== "info")).length
  const done = cs.reduce((n, c) => n + (c.tasksCompleted ?? 0), 0)
  return { online, total: cs.length, attention, done }
}

/** "Mac · 10 cores · 16 GB memory" */
export function specOf(c: HiveNodeRow): string {
  const os = c.os ? (/mac|darwin/i.test(c.os) ? "Mac" : /win/i.test(c.os) ? "Windows" : /linux|ubuntu|debian/i.test(c.os) ? "Linux" : c.os) : null
  return [os, c.cores ? `${c.cores} cores` : null, c.memoryGb ? `${gb(c.memoryGb).replace(".0 GB", " GB")} memory` : null]
    .filter(Boolean)
    .join(" · ")
}

/** The GPU in words. Never reported and "no GPU" are different answers (#192222). */
export function gpuOf(c: HiveNodeRow): string {
  if (!c.gpu) return "Not reported"
  if (!c.gpu.available) return "None"
  const vram = c.gpu.vramGb ? ` · ${c.gpu.vramGb} GB` : ""
  return `${c.gpu.name ?? "GPU"}${vram}`
}

/**
 * The AI line on a card: what this machine lends to the IRIS gateway right now. Installed models
 * that are not shared get their own wording, so "has models" never reads as "serving models".
 */
export function aiOf(c: HiveNodeRow): { serving: readonly string[]; text: string } | null {
  const serving = c.modelsServing ?? []
  const installed = c.modelsInstalled ?? []
  if (serving.length) {
    const first = serving[0].replace(/^hive\//, "")
    return { serving, text: serving.length > 1 ? `Serving ${first} +${serving.length - 1}` : `Serving ${first}` }
  }
  if (installed.length) return { serving, text: `${installed.length} model${installed.length > 1 ? "s" : ""} installed, not shared` }
  return null
}

export type MachinesView = "list" | "map"
export const readMachinesView = (raw: string | null | undefined): MachinesView => (raw === "map" ? "map" : "list")

// ── map ─────────────────────────────────────────────────────────────────────────────────────────

export type MapNode = {
  id: string
  kind: "you" | "computer" | "peer"
  label: string
  x: number
  y: number
  online?: boolean
  attention?: boolean
  regs?: number
}

/**
 * You in the middle, your computers on the inner ring, the people you share with on the outer
 * one. Positions are a pure function of the lists, so the map does not jump on a refresh.
 */
export function mapLayout(cs: readonly Computer[], peers: readonly HivePeerRow[], w: number, h: number, now: number): MapNode[] {
  const cx = w / 2
  const cy = h / 2
  const r1 = Math.min(w, h) * 0.27
  const r2 = Math.min(w, h) * 0.44
  const out: MapNode[] = [{ id: "you", kind: "you", label: "You", x: cx, y: cy }]
  const ring = <T,>(items: readonly T[], r: number, offset: number, f: (t: T, x: number, y: number) => MapNode) =>
    items.forEach((t, i) => {
      const a = -Math.PI / 2 + offset + (i * 2 * Math.PI) / Math.max(1, items.length)
      out.push(f(t, cx + r * Math.cos(a), cy + r * Math.sin(a)))
    })
  ring(cs, r1, 0, (c, x, y) => ({
    id: c.id,
    kind: "computer",
    label: c.name,
    x,
    y,
    online: c.online,
    attention: attentionOf(c, now).some((a) => a.level !== "info"),
    regs: c.regs,
  }))
  // People sit between the computers' spokes, so no label lands on a computer's line.
  ring(peers, r2, Math.PI / Math.max(2, cs.length, peers.length), (p, x, y) => ({
    id: `peer:${p.id}`,
    kind: "peer",
    label: p.name,
    x,
    y,
    online: p.active,
  }))
  return out
}

// ── Computers (#192608): how each one is reached, and what is running on it ───────────────────────

/**
 * What THIS computer knows about itself (`/iris/hive/here`): which Hive record it is, whether it
 * is on a tailnet, and the shell panes Hive started on it.
 */
export type HereRow = {
  measured: boolean
  reason?: string
  nodeId: string | null
  onTailnet: boolean
  shells: { measured: boolean; reason?: string; workspaces: readonly { panes: number; kind: string | null }[] }
}

/** The `/iris/hive/sessions` payload — the same rows `iris hive sessions` prints. */
export type SessionsPayload = { measured: boolean; reason?: string; nodes: readonly HiveSessionNode[] }

/** Tailscale's 100.64.0.0/10 (and its IPv6 prefix) — the bound fl-iris-api validates before storing one. */
export function isTailnetIp(ip: string | null | undefined): boolean {
  if (!ip) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return /^fd7a:115c:a1e0:/i.test(ip.trim())
  const o = m.slice(1).map(Number)
  return o.every((n) => n <= 255) && o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

export type ReachKind = "self" | "tailscale" | "lan" | "other" | "unknown"
export type Reach = { kind: ReachKind; label: string; detail: string }

export const REACH_LABEL: Record<ReachKind, string> = {
  self: "This computer",
  tailscale: "Tailscale",
  lan: "This network",
  other: "Other",
  unknown: "Unknown",
}

/** An advertised address older than this is shown with its age, not as a fact about now. */
const ADDRESS_STALE_MS = 24 * 3600_000

const isHere = (c: Computer, here: HereRow | null | undefined) => !!here?.nodeId && c.ids.includes(here.nodeId)

/**
 * How this computer reaches that one — derived from what both sides reported, never guessed:
 *  - Tailscale: it advertised a tailnet address AND this computer is on a tailnet too;
 *  - This network: IRIS saw both connect from the same internet connection;
 *  - Other: it reported an address, but neither of the above holds (Hive still reaches it through IRIS);
 *  - Unknown: nothing to go on — this computer could not check itself, or that one never said.
 */
export function reachOf(c: Computer, here: HereRow | null | undefined, all: readonly Computer[], now: number): Reach {
  const r = (kind: ReachKind, detail: string): Reach => ({ kind, label: REACH_LABEL[kind], detail })
  if (!here?.measured) return r("unknown", "Could not check how this computer is connected")
  if (isHere(c, here)) return r("self", "You are using this computer")
  const mine = all.find((x) => isHere(x, here))
  const sameNet = !!mine?.lastIp && !!c.lastIp && mine.lastIp === c.lastIp
  const tail = isTailnetIp(c.tailscaleIp)
  if (tail && here.onTailnet) {
    const t = c.tailscaleIpAt ? Date.parse(c.tailscaleIpAt) : NaN
    const old = Number.isFinite(t) && now - t > ADDRESS_STALE_MS
    return r(
      "tailscale",
      `Over Tailscale at ${c.tailscaleIp}${old ? ` (address as of ${ago(c.tailscaleIpAt, now)})` : ""}${sameNet ? " · same internet connection as this computer" : ""}`,
    )
  }
  if (sameNet) return r("lan", "Same internet connection as this computer")
  if (tail) return r("other", "It is on Tailscale, but this computer is not — Hive still reaches it through IRIS")
  if (c.lastIp) return r("other", "Over the internet, through IRIS")
  return r("unknown", "It has never said how it connects")
}

export type AgentCount =
  | {
      state: "counted"
      n: number
      /** Untouched for over a day — hidden, as `iris hive sessions` hides them without --all. */
      stale: number
      /** A provider was cut at its cap or could not be asked: n is a floor. */
      floor: boolean
      /** The list is the last report, not a live one. */
      old: boolean
      reportedAt: string | null
    }
  | { state: "never" }
  | { state: "unmeasured"; reason?: string }

/**
 * Agent sessions on a computer: exactly the rows `iris hive sessions` lists for it (stale hidden),
 * summed over every registration of that computer. A machine that never reported is not zero.
 */
export function agentsOf(c: Computer, sessions: SessionsPayload | null | undefined): AgentCount {
  if (!sessions?.measured) return { state: "unmeasured", reason: sessions?.reason }
  const recs = sessions.nodes.filter((n) => c.ids.includes(n.id))
  const reported = recs.filter((n) => n.report !== "never")
  if (!reported.length) return { state: "never" }
  const rows = reported.flatMap((n) => n.sessions)
  const stale = rows.filter((s) => s.status === "stale").length
  const newest = [...reported].sort((a, b) => (Date.parse(b.reportedAt ?? "") || 0) - (Date.parse(a.reportedAt ?? "") || 0))[0]
  return {
    state: "counted",
    n: rows.length - stale,
    stale,
    floor: reported.some((n) => n.incomplete.length > 0),
    old: newest.report !== "fresh",
    reportedAt: newest.reportedAt,
  }
}

export type ShellCount =
  | { state: "counted"; n: number; workspaces: number }
  /** Not this computer: no machine reports its panes to IRIS, so they are not measured. */
  | { state: "elsewhere" }
  | { state: "unmeasured"; reason?: string }

/** Shell panes Hive started (`iris hive panes`). Counted only on the computer you are using. */
export function shellsOfComputer(c: Computer, here: HereRow | null | undefined): ShellCount {
  if (!here?.measured) return { state: "unmeasured", reason: here?.reason }
  if (!isHere(c, here)) return { state: "elsewhere" }
  if (!here.shells.measured) return { state: "unmeasured", reason: here.shells.reason }
  return { state: "counted", n: here.shells.workspaces.reduce((t, w) => t + w.panes, 0), workspaces: here.shells.workspaces.length }
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`

/** The words for a count. Anything not counted says why — never "0". */
export function agentWords(a: AgentCount, now: number): { text: string; note: string | null; counted: boolean } {
  if (a.state === "unmeasured") return { text: "Agents: couldn't check", note: a.reason ?? null, counted: false }
  if (a.state === "never") return { text: "Agents: never reported", note: "This computer has not told IRIS about its sessions", counted: false }
  const notes = [
    a.old ? `as of ${ago(a.reportedAt, now)}` : null,
    a.floor ? "at least — some were not counted" : null,
    a.stale ? `${a.stale} older hidden` : null,
  ].filter(Boolean)
  return { text: `${a.floor ? "≥" : ""}${plural(a.n, "agent session")}`, note: notes.length ? notes.join(" · ") : null, counted: true }
}

export function shellWords(s: ShellCount): { text: string; note: string | null; counted: boolean } {
  if (s.state === "elsewhere") return { text: "Shells: not counted", note: "Hive counts shells only on the computer you are using", counted: false }
  if (s.state === "unmeasured") return { text: "Shells: couldn't check", note: s.reason ?? null, counted: false }
  return {
    text: plural(s.n, "shell"),
    note: s.workspaces ? `Hive-started only · ${plural(s.workspaces, "workspace")}` : "Hive-started only",
    counted: true,
  }
}

export type ComputerRow = { computer: Computer; reach: Reach; agents: AgentCount; shells: ShellCount }

export function computerRows(
  cs: readonly Computer[],
  sessions: SessionsPayload | null | undefined,
  here: HereRow | null | undefined,
  now: number,
): ComputerRow[] {
  return cs.map((c) => ({ computer: c, reach: reachOf(c, here, cs, now), agents: agentsOf(c, sessions), shells: shellsOfComputer(c, here) }))
}

export type ComputersFilter = "all" | "agents" | "shells"
export const readComputersFilter = (raw: string | null | undefined): ComputersFilter =>
  raw === "agents" || raw === "shells" ? raw : "all"

/**
 * All: every computer. Agents only / Shells only: the computers with at least one COUNTED of that
 * kind. A computer whose count is unknown is not shown as having none — `hiddenUnknown` says how
 * many were left out because they could not be counted, so the view can say so.
 */
export function filterComputers(rows: readonly ComputerRow[], f: ComputersFilter): { rows: ComputerRow[]; hiddenUnknown: number } {
  if (f === "all") return { rows: [...rows], hiddenUnknown: 0 }
  const counted = (r: ComputerRow) => (f === "agents" ? r.agents.state === "counted" : r.shells.state === "counted")
  const n = (r: ComputerRow) =>
    f === "agents" ? (r.agents.state === "counted" ? r.agents.n : 0) : r.shells.state === "counted" ? r.shells.n : 0
  return { rows: rows.filter((r) => counted(r) && n(r) > 0), hiddenUnknown: rows.filter((r) => !counted(r)).length }
}

/** Totals across computers, with how many computers each total actually covers. */
export function computerTotals(rows: readonly ComputerRow[]) {
  let agents = 0
  let agentsFloor = false
  let agentMachines = 0
  let shells = 0
  let shellMachines = 0
  for (const r of rows) {
    if (r.agents.state === "counted") {
      agents += r.agents.n
      agentMachines++
      agentsFloor ||= r.agents.floor
    }
    if (r.shells.state === "counted") {
      shells += r.shells.n
      shellMachines++
    }
  }
  return { computers: rows.length, agents, agentsFloor, agentMachines, shells, shellMachines }
}

/**
 * "Add a computer" — the hive-secure-mesh playbook's own steps, in order, with where each runs.
 * Not a new flow: the same commands the playbook documents.
 */
export const ADD_COMPUTER_STEPS: readonly { title: string; where: string; command: string; why: string }[] = [
  {
    title: "Put it on your private network",
    where: "On the new computer",
    command: "iris playbook run hive-secure-mesh --action onboard",
    why: "Installs Tailscale and joins your tailnet. No ports are opened to the internet. Note the 100.x address it prints.",
  },
  {
    title: "Make it a Hive computer",
    where: "On this computer",
    command: "iris playbook run hive-secure-mesh --action enroll --ip <its 100.x address>",
    why: "Registers it with Hive over the private network, so it shows up here and can take work.",
  },
  {
    title: "Check the whole chain",
    where: "On either",
    command: "iris playbook run hive-secure-mesh --action doctor",
    why: "Checks the network, who may reach it, and Hive, from the bottom up, and says what is missing.",
  },
]
