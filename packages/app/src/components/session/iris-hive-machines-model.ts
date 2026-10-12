/**
 * Hive › Machines — the pure half (heyiris.io/p/hive-panel-directions#pick).
 *
 * "Team of computers": one card per computer (registrations of the same hardware fold together),
 * a triage line on top, problems written as sentences on the computer they belong to, and the
 * same fleet as a map one click away. Every rule here is testable without a DOM or a network.
 */
import { ago, diskOf, groupComputers, type Computer, type HiveNodeRow } from "./iris-hive-scripts-model"

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
