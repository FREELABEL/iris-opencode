import { providerWord, sortSessions, type HiveSessionNode } from "@/components/session/iris-hive-sessions-model"

/**
 * Home › On your machines (#192626): the sessions running on every machine you have — Claude Code,
 * Codex, IRIS / opencode — read from the same /iris/hive/sessions that Hive › Sessions draws. Pure.
 *
 * Only what is live is listed. Measured 2026-11-05: 116 rows, 16 of them live; the other 100 came
 * from two machines whose reports were days old (every row `unknown`). Those, and `stale` rows
 * (untouched for over a day), are counted, not listed — Hive › Sessions shows them all.
 */

export type FleetPayload = { measured: boolean; reason?: string | null; nodes: HiveSessionNode[] }

export type FleetRow = {
  nodeId: string
  machine: string
  sessionId: string
  provider: string
  tool: string
  label: string
  status: string
  working: boolean
  branch: string | null
  updatedAt: string | null
}

const LIVE = new Set(["needs_you", "active", "idle"])

export function fleetOf(payload: FleetPayload | undefined): {
  rows: FleetRow[]
  /** Rows not listed: stale, or on a machine whose report is old. */
  hidden: number
  /** Machines with at least one listed row. */
  machines: number
  tools: string[]
} {
  const rows: FleetRow[] = []
  let hidden = 0
  for (const n of payload?.nodes ?? []) {
    for (const s of sortSessions(n.sessions)) {
      if (n.report !== "fresh" || !LIVE.has(s.status)) {
        hidden++
        continue
      }
      rows.push({
        nodeId: n.id,
        machine: n.name,
        sessionId: s.sessionId,
        provider: s.provider,
        tool: providerWord(s.provider),
        label: s.label,
        status: s.status,
        working: s.activity === "working" || s.activity === "retrying",
        branch: s.branch && s.branch !== "HEAD" ? s.branch : null,
        updatedAt: s.updatedAt,
      })
    }
  }
  // Across machines in the same order Hive › Sessions uses within one: needs you, working, active, idle.
  const rank = (r: FleetRow) => ({ needs_you: 0, active: 1, idle: 2 })[r.status as "active"] - (r.working ? 0.5 : 0)
  const t = (r: FleetRow) => (r.updatedAt ? Date.parse(r.updatedAt) || 0 : 0)
  rows.sort((a, b) => rank(a) - rank(b) || t(b) - t(a))
  return {
    rows,
    hidden,
    machines: new Set(rows.map((r) => r.nodeId)).size,
    tools: [...new Set(rows.map((r) => r.tool))].sort(),
  }
}

export function byTool(rows: readonly FleetRow[], tool: string | null): FleetRow[] {
  return tool ? rows.filter((r) => r.tool === tool) : [...rows]
}
