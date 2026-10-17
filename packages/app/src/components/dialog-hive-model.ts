/**
 * The machines and inbox dialogs behind the titlebar pills (#189763) — the pure half.
 *
 * The dialogs answer "is my Hive OK, and if not, what do I press?" for a person who has never
 * opened a terminal. Every rule that decides a sentence or a button lives here, so it is tested
 * without a DOM. The cards reuse the Machines panel's own rules (statusOf, attentionOf) — the
 * dialog and the panel it opens must never disagree about the same computer.
 */
import { attentionOf, machinesOf, statusOf, type Attention, type Computer } from "./session/iris-hive-machines-model"
import type { HiveNodeRow } from "./session/iris-hive-scripts-model"

/** /iris/hive/local — this computer's daemon, read on this computer. */
export type LocalDaemon = {
  supported: boolean
  nodeId: string | null
  running: boolean
  pid: number | null
  program: string | null
  programOk: boolean | null
  version: string | null
  behind: number | null
  fetchedAt: string | null
  localEdits: number | null
}

/** A problem with a button. `restart` is the only repair the app performs today. */
export type LocalNote = Attention & { action?: "restart" }

/**
 * What only THIS computer can know about its own daemon — every one of these was invisible from
 * the hub on 2026-10-17 while the Mac kept heartbeating.
 */
export function localNotes(d: LocalDaemon | null | undefined): LocalNote[] {
  if (!d || !d.supported) return []
  const out: LocalNote[] = []
  if (!d.running)
    out.push({
      kind: "silent",
      level: "crit",
      text: "The Hive daemon is not running on this computer",
      fix: "Start it. Nothing can run here until it does.",
      action: "restart",
    })
  if (d.programOk === false)
    out.push({
      kind: "silent",
      level: "warn",
      text: "It starts from a temporary folder",
      fix: "It would not come back after this computer restarts. Restart it here to load it from the right place.",
      action: "restart",
    })
  if (d.behind != null && d.behind > 0)
    out.push({
      kind: "silent",
      level: d.behind >= 10 ? "warn" : "info",
      text: `${d.behind} update${d.behind === 1 ? "" : "s"} behind`,
      fix:
        d.behind >= 10
          ? "Scripts can miss their settings on an old daemon. Updating from here is coming next — for now ask IRIS to update it."
          : "Updates are waiting. Nothing is broken by this yet.",
    })
  return out
}

export type FleetCard = Computer & {
  self: boolean
  status: ReturnType<typeof statusOf>
  notes: LocalNote[]
}

/** One card per computer, THIS computer first, each with the panel's status and problems. */
export function fleetCards(nodes: readonly HiveNodeRow[], local: LocalDaemon | null | undefined, now: number): FleetCard[] {
  const cards = machinesOf(nodes).map((c) => {
    const self = !!local?.nodeId && c.ids.includes(local.nodeId)
    return {
      ...c,
      self,
      status: statusOf(c, now),
      notes: [...(self ? localNotes(local) : []), ...attentionOf(c, now)] as LocalNote[],
    }
  })
  return cards.sort((a, b) => Number(b.self) - Number(a.self))
}

/** The dialog's one-line summary. "Needs you" counts only crit/warn — housekeeping is not a problem. */
export function fleetHeadline(cards: readonly FleetCard[]): string {
  const online = cards.filter((c) => c.online).length
  const needs = cards.filter((c) => c.notes.some((n) => n.level !== "info")).length
  const base = `${online} of ${cards.length} computer${cards.length === 1 ? "" : "s"} online`
  return needs ? `${base} · ${needs} need${needs === 1 ? "s" : ""} you` : base
}

/** After a restart: say what happened in words, from the PIDs, never from an exit code. */
export function restartWords(r: { measured: boolean; reason?: string; before: number | null; after: number | null; repaired: boolean }): string {
  if (!r.measured || !r.after) return `Did not restart — ${r.reason ?? "no new daemon process appeared"}`
  return r.repaired ? "Restarted, and it now starts from the right place" : "Restarted — it is running again"
}

// ── inbox ────────────────────────────────────────────────────────────────────────────────────

export type InboxRow = { index: number; read: boolean; type: string; from: string; receivedAt?: string; label: string }

/** What kind of thing a row is, in a word a person uses. */
export function inboxKind(type: string): string {
  if (type === "message") return "Message"
  if (type === "link") return "Link"
  if (type === "handoff" || type === "job") return "Work handed to you"
  return "File"
}

/** The inbox pill's label: unread count, or nothing to count. The pill stays clickable either way. */
export function inboxPill(unread: number | null | undefined, unreadable: boolean | undefined): string {
  if (unreadable || unread === null) return "—"
  return unread && unread > 0 ? String(unread) : ""
}
