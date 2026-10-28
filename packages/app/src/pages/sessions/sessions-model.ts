/**
 * The main-area Sessions view (#191497, epic #191485): every chat a person has, wherever it lives —
 * on this machine, on another of their machines, or as a cloud copy — in one list they can filter
 * and sort. Pure: the page fetches, this decides what a row is and which rows show.
 */

export type Source = "all" | "this" | "other" | "cloud"
export type SortKey = "recent" | "title" | "machine"

/** One machine's sessions as GET /iris/hive/sessions returns them. */
export type FleetSession = {
  sessionId: string
  provider: string
  label: string
  status: string
  activity: string | null
  model: string | null
  branch: string | null
  updatedAt: string | null
  projectPath?: string | null
}
export type FleetNode = { id: string; name: string; report: string; self?: boolean; sessions: FleetSession[] }

/** One cloud copy as GET /iris/hive/shares returns it. */
export type CloudCopy = { id: string; url: string; sessionId: string; title: string | null; machine: string | null; messages: number; updatedAt: string | null }

/** One chat from IRIS's session index, as GET /iris/hive/session-index returns it: older chats too. */
export type IndexedSession = {
  sessionId: string
  provider: string
  title: string | null
  nodeId: string
  machine: string | null
  self: boolean
  branch: string | null
  model: string | null
  updatedAt: string | null
}

export type SessionRow = {
  key: string
  sessionId: string
  title: string
  provider: string
  app: "IRIS" | "Claude Code" | "Codex" | "Other"
  status: string
  updatedAt: string | null
  /** Where it runs. Null for a chat known only from its cloud copy. */
  machine: { id: string; name: string; self: boolean } | null
  /** The cloud copy of this chat, when there is one. */
  copy: CloudCopy | null
  branch: string | null
}

export function appOf(provider: string): SessionRow["app"] {
  if (provider === "opencode" || provider === "acp") return "IRIS"
  if (provider === "claude_code") return "Claude Code"
  if (provider === "codex") return "Codex"
  return "Other"
}

/**
 * One row per chat. A chat that runs on a machine AND has a cloud copy is one row carrying both, so
 * "Cloud copies" and "This machine" can each find it without listing it twice. A machine registered
 * twice (one id, two records) keeps the fresher row.
 *
 * The live report holds only each machine's newest 25 per app; the index holds the rest. An indexed
 * chat the live report does not have is listed as "earlier" — the live row, when there is one,
 * always wins, because only it knows whether the chat is working right now.
 */
export function mergeRows(nodes: readonly FleetNode[], copies: readonly CloudCopy[], index: readonly IndexedSession[] = []): SessionRow[] {
  const byKey = new Map<string, SessionRow>()
  for (const n of nodes) {
    for (const s of n.sessions) {
      const key = s.sessionId
      const row: SessionRow = {
        key,
        sessionId: s.sessionId,
        title: s.label || "Untitled chat",
        provider: s.provider,
        app: appOf(s.provider),
        status: s.activity === "working" ? "working" : s.status,
        updatedAt: s.updatedAt,
        machine: { id: n.id, name: n.name, self: !!n.self },
        copy: null,
        branch: s.branch,
      }
      const prev = byKey.get(key)
      if (!prev || time(row.updatedAt) > time(prev.updatedAt)) byKey.set(key, row)
    }
  }
  for (const i of index) {
    if (byKey.has(i.sessionId)) continue
    byKey.set(i.sessionId, {
      key: i.sessionId,
      sessionId: i.sessionId,
      title: i.title || "Untitled chat",
      provider: i.provider,
      app: appOf(i.provider),
      status: "earlier",
      updatedAt: i.updatedAt,
      machine: { id: i.nodeId, name: i.machine ?? "A machine", self: i.self },
      copy: null,
      branch: i.branch,
    })
  }
  for (const c of copies) {
    const live = byKey.get(c.sessionId)
    if (live) {
      byKey.set(c.sessionId, { ...live, copy: c })
      continue
    }
    byKey.set(c.sessionId, {
      key: c.sessionId,
      sessionId: c.sessionId,
      title: c.title || "Untitled chat",
      provider: "opencode",
      app: "IRIS",
      status: "copy",
      updatedAt: c.updatedAt,
      machine: null,
      copy: c,
      branch: null,
    })
  }
  return [...byKey.values()]
}

export function inSource(r: SessionRow, source: Source): boolean {
  if (source === "this") return !!r.machine?.self
  if (source === "other") return !!r.machine && !r.machine.self
  if (source === "cloud") return !!r.copy
  return true
}

export type Filters = { source: Source; machine: string; app: string; status: string; query: string; sort: SortKey }

/** Words that say nothing about which chat you mean (the same idea as recall's session search). */
const FILLER = new Set(["a", "about", "an", "and", "the", "to", "of", "on", "in", "for", "with", "what", "did", "we", "i", "my", "chat", "session"])

export function matches(r: SessionRow, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).map((t) => t.replace(/[?!.,;:"'()]/g, "")).filter((t) => t && !FILLER.has(t))
  if (!tokens.length) return true
  const hay = `${r.title} ${r.machine?.name ?? ""} ${r.copy?.machine ?? ""} ${r.branch ?? ""} ${r.app}`.toLowerCase()
  return tokens.every((t) => hay.includes(stem(t)))
}

/** The part every form of a word shares: verify/verified/verifies → "verif" (as recall's session search). */
export function stem(word: string): string {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word
  const cut = word.replace(/(ies|ied|ing|ed|es|(?<!s)s)$/, "").replace(/[iy]$/, "")
  return cut.length >= 3 ? cut : word
}

export function applyFilters(rows: readonly SessionRow[], f: Filters): SessionRow[] {
  const out = rows.filter(
    (r) =>
      inSource(r, f.source) &&
      (!f.machine || r.machine?.name === f.machine || r.copy?.machine === f.machine) &&
      (!f.app || r.app === f.app) &&
      (!f.status || r.status === f.status) &&
      matches(r, f.query),
  )
  const name = (r: SessionRow) => r.machine?.name ?? r.copy?.machine ?? ""
  return out.sort((a, b) =>
    f.sort === "title"
      ? a.title.localeCompare(b.title)
      : f.sort === "machine"
        ? name(a).localeCompare(name(b)) || time(b.updatedAt) - time(a.updatedAt)
        : time(b.updatedAt) - time(a.updatedAt),
  )
}

/** How many rows each source would show (with every other filter applied), for the chips. */
export function sourceCounts(rows: readonly SessionRow[], f: Filters): Record<Source, number> {
  const count = (source: Source) => applyFilters(rows, { ...f, source }).length
  return { all: count("all"), this: count("this"), other: count("other"), cloud: count("cloud") }
}

export function optionsOf(rows: readonly SessionRow[]) {
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort()
  return {
    machines: uniq(rows.flatMap((r) => [r.machine?.name, r.copy?.machine])),
    apps: uniq(rows.map((r) => r.app)),
    statuses: uniq(rows.map((r) => r.status)),
  }
}

function time(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? 0 : t
}
