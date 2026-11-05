/**
 * The pure half of Agents › Live › Tool access (#192619): which tools an agent has used in this
 * run, which it may use and has not yet, and which it has no access to — laid out as a map.
 *
 * Drawn after a component @growthflo posted (Threads, 2026-11-04), with what that one cannot show:
 * a call held for approval next to a failed one, and each tool's effect (reads, sends, moves money).
 *
 * Counts come from the run's recent calls, and iris-api keeps the last 20 (RunLiveView::KEEP), so
 * a long run's map covers its newest calls only. The header says so when the window is full.
 */
import { toolFor, type Catalog, type CatalogTool, type Effect } from "./iris-agent-editor-model"
import type { LiveRun, LiveToolCall } from "./iris-agent-live-model"

/** iris-api's window of recent calls (RunLiveView::KEEP). */
export const CALL_WINDOW = 20

export type NodeKind = "used" | "idle" | "none"

export type MapNode = {
  id: string
  name: string
  kind: NodeKind
  effect: Effect
  calls: number
  lastMs?: number
  /** The newest call to this tool: what the node's badge shows. */
  last?: LiveToolCall["status"]
}

export type ToolMap = {
  left: MapNode[]
  right: MapNode[]
  /** Nodes that did not fit, per side. */
  moreLeft: number
  moreRight: number
  /** Tools the agent may use, and the catalogue it was picked from. */
  access: number
  total: number
  calls: number
  /** The call window is full, so counts cover the newest calls only. */
  windowFull: boolean
}

const pretty = (id: string) => {
  const s = id.replace(/tool$/i, "").replace(/[_-]+/g, " ").trim()
  return s ? s[0]!.toUpperCase() + s.slice(1) : id
}

const describe = (catalog: Catalog, entry: string): { id: string; name: string; effect: Effect; group?: string } => {
  const t = toolFor(catalog, entry)
  return t ? { id: t.id, name: t.name, effect: t.effect, group: t.group } : { id: entry, name: pretty(entry), effect: "unclassified" }
}

/**
 * @param allowed the agent's tool list, or null when it was never given one (it may get every tool,
 *   so nothing can be called "no access").
 */
export function toolMap(
  catalog: Catalog,
  allowed: readonly string[] | null,
  run: LiveRun | null,
  max: { left: number; right: number } = { left: 6, right: 6 },
): ToolMap {
  const used = new Map<string, MapNode & { group?: string }>()
  const refused = new Map<string, MapNode & { group?: string }>()
  let calls = 0

  for (const c of run?.toolCalls ?? []) {
    const d = describe(catalog, c.tool)
    if (c.status === "skipped") {
      // A refused call never ran: the tool belongs with the ones it has no access to.
      if (!used.has(d.id)) refused.set(d.id, { ...d, kind: "none", calls: 0, last: "skipped" })
      continue
    }
    calls++
    refused.delete(d.id)
    const n = used.get(d.id) ?? { ...d, kind: "used" as const, calls: 0 }
    n.calls++
    n.last = c.status
    if (c.durationMs !== undefined && c.status !== "running") n.lastMs = c.durationMs
    used.set(d.id, n)
  }

  const allowedTools = allowed ? dedupe(allowed.map((a) => describe(catalog, a))) : []
  const idle: MapNode[] = allowedTools.filter((t) => !used.has(t.id)).map((t) => ({ ...t, kind: "idle", calls: 0 }))

  // No access: tools it tried and was refused, then catalogue tools beside the ones it has (same
  // group) that are not on its list — the nearest things it cannot do, riskiest first.
  const none: MapNode[] = [...refused.values()]
  if (allowed) {
    const have = new Set([...allowedTools.map((t) => t.id), ...used.keys(), ...refused.keys()])
    const groups = new Set([...allowedTools, ...used.values()].map((t) => t.group).filter(Boolean))
    const near = catalog.tools
      .filter((t) => groups.has(t.group) && !have.has(t.id) && !t.alwaysOn)
      .sort((a, b) => hot(b) - hot(a) || a.name.localeCompare(b.name))
    for (const t of near) none.push({ id: t.id, name: t.name, effect: t.effect, kind: "none", calls: 0 })
  }

  const left = [...used.values()]
  const right = [...idle, ...none]
  const access = allowed ? allowedTools.length : used.size
  return {
    left: left.slice(0, max.left).map(strip),
    right: right.slice(0, max.right).map(strip),
    moreLeft: Math.max(0, left.length - max.left),
    moreRight: Math.max(0, right.length - max.right),
    access,
    total: catalog.available ? Math.max(catalog.tools.length, access) : access + none.length,
    calls,
    windowFull: (run?.toolCalls.length ?? 0) >= CALL_WINDOW,
  }
}

const RISK: Effect[] = ["read", "own_write", "unclassified", "shared_write", "shared_overwrite", "egress", "payment"]
const hot = (t: Pick<CatalogTool, "effect">) => RISK.indexOf(t.effect)

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>()
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

const strip = ({ group: _, ...n }: MapNode & { group?: string }): MapNode => n

/** What a node says under its name. */
export function nodeLine(n: MapNode, fmt: (ms: number | undefined) => string): string {
  if (n.kind === "idle") return "Not used yet"
  if (n.kind === "none") return n.last === "skipped" ? "Refused" : "No access"
  if (n.last === "running") return "Running…"
  return n.lastMs !== undefined ? `Last call ${fmt(n.lastMs)}` : "Last call"
}

/** The badge beside the line: a failure or a hold is the thing to notice. */
export function nodeBadge(n: MapNode): { tone: "fail" | "held"; text: string } | null {
  if (n.last === "error") return { tone: "fail", text: "Failed" }
  if (n.last === "held") return { tone: "held", text: "Held" }
  return null
}

export function headerLine(m: ToolMap): string {
  const calls = m.windowFull ? `last ${m.calls} calls` : `${m.calls} ${m.calls === 1 ? "call" : "calls"}`
  return `${m.access}/${m.total} tools · ${calls}`
}

/** The status pill on the agent card. */
export function runPill(run: LiveRun | null): { tone: "run" | "pause" | "done" | "fail" | "idle"; text: string } {
  const s = (run?.status ?? "").toLowerCase()
  if (!run) return { tone: "idle", text: "Idle" }
  if (s === "running") return { tone: "run", text: "Running" }
  if (s === "paused" || run.takeover?.status === "paused") return { tone: "pause", text: "Paused" }
  if (s === "failed" || s === "error") return { tone: "fail", text: "Failed" }
  if (s === "completed" || s === "done" || s === "finished") return { tone: "done", text: "Done" }
  return { tone: "idle", text: s ? s[0]!.toUpperCase() + s.slice(1) : "Idle" }
}

/** The provider a model id belongs to, for its icon ("anthropic/claude-…", "gpt-4o", "gemini-…"). */
export function providerOf(model: string | undefined): string | undefined {
  const m = (model ?? "").toLowerCase().trim()
  if (!m) return undefined
  const prefix = m.includes("/") ? m.split("/")[0]! : ""
  if (["anthropic", "openai", "google", "xai", "deepseek", "groq", "mistral"].includes(prefix)) return prefix
  const name = m.split("/").pop()!
  if (/^claude/.test(name)) return "anthropic"
  if (/^(gpt|o\d|chatgpt)/.test(name)) return "openai"
  if (/^gemini/.test(name)) return "google"
  if (/^grok/.test(name)) return "xai"
  if (/^deepseek/.test(name)) return "deepseek"
  if (/^(mistral|codestral|ministral)/.test(name)) return "mistral"
  return prefix === "openrouter" ? "openrouter" : undefined
}

/** "anthropic/claude-sonnet-4-5" → "Claude Sonnet 4.5"; "gpt-4o-mini" → "GPT-4o mini". */
export function modelLabel(model: string | undefined): string {
  const name = (model ?? "").split("/").pop()?.trim() ?? ""
  if (!name) return ""
  if (/^gpt/i.test(name)) return name.replace(/^gpt/i, "GPT").replace(/-(mini|nano|pro)$/i, " $1")
  return name
    .split("-")
    .reduce<string[]>((out, w) => {
      const prev = out[out.length - 1]
      if (/^\d+$/.test(w) && prev && /^\d+$/.test(prev.split(" ").pop()!)) out[out.length - 1] = `${prev}.${w}`
      else out.push(/^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1))
      return out
    }, [])
    .join(" ")
}

// ── geometry ──────────────────────────────────────────────────────────────────────────────

export const GEO = { nodeW: 150, nodeH: 46, gap: 12, cardW: 210, cardH: 86, pad: 2, radius: 6 } as const

export type Edge = { d: string; kind: NodeKind; side: "left" | "right" }

/**
 * Positions for the nodes and the card, and the edges between them, in one coordinate space the
 * HTML and the SVG share. Each edge leaves its node horizontally, turns at a bus halfway to the
 * card, and enters the card at its middle.
 */
export function layout(nLeft: number, nRight: number, width: number) {
  const { nodeW, nodeH, gap, cardW, cardH, pad, radius } = GEO
  const colH = (n: number) => (n ? n * nodeH + (n - 1) * gap : 0)
  const height = Math.max(colH(nLeft), colH(nRight), cardH) + pad * 2
  const w = Math.max(width, nodeW * 2 + cardW + 2 * 48)
  const cardX = Math.round((w - cardW) / 2)
  const cardY = Math.round((height - cardH) / 2)
  const cy = cardY + cardH / 2
  const top = (n: number) => Math.round((height - colH(n)) / 2)
  const ys = (n: number) => Array.from({ length: n }, (_, i) => top(n) + i * (nodeH + gap))
  const rightX = w - nodeW - pad
  const leftBus = Math.round((pad + nodeW + cardX) / 2)
  const rightBus = Math.round((cardX + cardW + rightX) / 2)

  const elbow = (x1: number, y1: number, bus: number, y2: number, x2: number) => {
    if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`
    const r = Math.min(radius, Math.abs(y2 - y1) / 2)
    const dy = y2 > y1 ? 1 : -1
    const dx1 = bus > x1 ? 1 : -1
    const dx2 = x2 > bus ? 1 : -1
    return `M${x1},${y1} H${bus - dx1 * r} Q${bus},${y1} ${bus},${y1 + dy * r} V${y2 - dy * r} Q${bus},${y2} ${bus + dx2 * r},${y2} H${x2}`
  }

  return {
    width: w,
    height,
    card: { x: cardX, y: cardY },
    left: ys(nLeft).map((y) => ({ x: pad, y })),
    right: ys(nRight).map((y) => ({ x: rightX, y })),
    edgesLeft: ys(nLeft).map((y) => elbow(pad + nodeW, y + nodeH / 2, leftBus, cy, cardX)),
    edgesRight: ys(nRight).map((y) => elbow(cardX + cardW, cy, rightBus, y + nodeH / 2, rightX)),
    ports: { left: { x: cardX, y: cy }, right: { x: cardX + cardW, y: cy } },
  }
}
