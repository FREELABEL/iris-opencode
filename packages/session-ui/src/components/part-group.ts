import type { Part as PartType, ToolPart } from "@opencode-ai/sdk/v2"

/**
 * How a turn's parts are folded into rows (#189316). Pure — no Solid, no DOM — so it is testable
 * without the component file's worker imports. message-part.tsx re-exports everything here.
 */
const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
/**
 * IRIS calls (#189316): the IRIS MCP gateway's tools reach the session as `IRIS_OS_<tool>`, and a
 * turn that drives the CLI makes ten of them in a row — each its own "Called `IRIS_OS_iris_run`"
 * line, with the answer pushed off screen. A run of them folds into one row, like file reads do.
 * A failure is never folded out of sight: the row counts it in the error colour and opens on it.
 */
export function isIrisGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && /^iris_os_/i.test(part.tool)
}
/**
 * Shell commands (#188457) fold with IRIS calls: in a real turn they alternate — Shell, IRIS ×4,
 * Shell, IRIS ×2 — and folding each kind separately still left a wall of rows. Both are "a command
 * the agent ran", so one row holds a run of either.
 */
export function isShellTool(part: PartType): part is ToolPart {
  return part.type === "tool" && (part.tool === "shell" || part.tool === "bash")
}
export function isCommandTool(part: PartType): part is ToolPart {
  return isIrisGroupTool(part) || isShellTool(part)
}
export type ContextKind = "files" | "commands"
function contextKind(part: PartType): ContextKind | undefined {
  if (isContextGroupTool(part)) return "files"
  if (isCommandTool(part)) return "commands"
  return undefined
}

export function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
      /** Absent = "files" (read/glob/grep/list), which is what every group was before #189316. */
      kind?: ContextKind
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if ((a.kind ?? "files") !== (b.kind ?? "files")) return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1
  let kind: ContextKind | undefined

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
      // Only a commands group carries a kind, so a files group compares equal to one built before it.
      ...(kind === "commands" ? { kind } : {}),
    })
    start = -1
  }

  parts.forEach((item, index) => {
    const k = contextKind(item.part)
    if (k) {
      // A file read after an IRIS call (or the reverse) starts a new group: they are different
      // kinds of work and each row's summary is only true of one kind.
      if (start >= 0 && k !== kind) flush(index - 1)
      if (start < 0) {
        start = index
        kind = k
      }
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}

/** The command an IRIS call ran, as the person would type it: `iris mail search "x"`, `iris help mail`. */
export function irisCallTrigger(part: ToolPart): { title: string; subtitle: string } {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const name = part.tool.replace(/^iris_os_/i, "")
  const command = typeof input.command === "string" ? input.command.trim() : ""
  if (name === "iris_run") return { title: "iris", subtitle: command }
  if (name === "iris_help") return { title: "iris help", subtitle: command }
  const first = Object.values(input).find((v): v is string => typeof v === "string" && v.trim().length > 0)
  return { title: name.replace(/_/g, " "), subtitle: first ?? "" }
}

/** Any command in a commands row: an IRIS call as above, a shell command as `$ <command>`. */
export function commandTrigger(part: ToolPart): { title: string; subtitle: string } {
  if (!isShellTool(part)) return irisCallTrigger(part)
  const input = (part.state.input ?? {}) as Record<string, unknown>
  return { title: "$", subtitle: typeof input.command === "string" ? input.command.trim() : "" }
}

function meta(part: ToolPart): Record<string, unknown> {
  return ("metadata" in part.state ? (part.state.metadata as Record<string, unknown>) : undefined) ?? {}
}

/** A shell exit code, when the command finished and reported one. */
export function exitOf(part: ToolPart): number | undefined {
  const e = meta(part).exit
  return typeof e === "number" ? e : undefined
}

/**
 * Failed = the call errored, or a shell command exited non-zero. A non-zero exit comes back as a
 * COMPLETED part — counting only `error` would fold a failed `ls` out of sight, which is the one
 * thing the folded row must never do.
 */
export function failed(part: ToolPart): boolean {
  if (part.state.status === "error") return true
  const e = exitOf(part)
  return isShellTool(part) && e !== undefined && e !== 0
}

export function running(part: ToolPart): boolean {
  return part.state.status === "pending" || part.state.status === "running"
}

/** How long a call took, in ms, once it has finished. */
export function durationOf(part: ToolPart): number | undefined {
  const t = (part.state as { time?: { start?: number; end?: number } }).time
  if (!t?.start || !t.end) return undefined
  return Math.max(0, t.end - t.start)
}

/** What a shell command printed (the tool's own preview of it), for the second click. */
export function outputOf(part: ToolPart): string | undefined {
  const o = meta(part).output
  return typeof o === "string" && o.trim() ? o : undefined
}

export function commandsSummary(parts: ToolPart[]) {
  const starts = parts.map((p) => (p.state as { time?: { start?: number } }).time?.start).filter((n): n is number => !!n)
  const ends = parts.map((p) => (p.state as { time?: { end?: number } }).time?.end).filter((n): n is number => !!n)
  const live = [...parts].reverse().find(running)
  return {
    ran: parts.length,
    failed: parts.filter(failed).length,
    allIris: parts.every(isIrisGroupTool),
    // Wall time of the run (first start to last end), not the sum — calls can overlap.
    ms: starts.length && ends.length && !live ? Math.max(...ends) - Math.min(...starts) : undefined,
    live: live ? commandTrigger(live) : undefined,
  }
}

/** Kept for #189316 callers: the IRIS-only summary. */
export function irisGroupSummary(parts: ToolPart[]) {
  return { ran: parts.length, failed: parts.filter(failed).length }
}

/** "41s", "1m 05s", "800ms". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

/**
 * What the Report button sends for a failed call (#189435): the tool, the command as the row shows
 * it, the error line and the output. Not for successful calls.
 */
export function commandReportOf(part: ToolPart): { tool: string; command: string; error: string; output?: string } | undefined {
  if (!failed(part)) return undefined
  const st = part.state
  const exit = exitOf(part)
  const error = st.status === "error" ? st.error : exit !== undefined ? `exit ${exit}` : "failed"
  const trigger = commandTrigger(part)
  const command = isShellTool(part) ? trigger.subtitle : [trigger.title, trigger.subtitle].filter(Boolean).join(" ")
  return { tool: part.tool, command: command || part.tool, error, output: outputOf(part) }
}

/** Constellation Gate's verdict on a turn (#189589), summed over its steps' step-finish parts. */
export interface GateSummary {
  scanned: number
  held: number
  flagged: number
  errors: number
  mode: string
}

/**
 * Undefined when no step was screened — a turn Gate never saw shows nothing, not "0 clean".
 * Takes any part: only step-finish parts carrying `gate` count.
 */
export function gateSummary(parts: ReadonlyArray<PartType>): GateSummary | undefined {
  let out: GateSummary | undefined
  for (const part of parts) {
    if (part.type !== "step-finish") continue
    const g = (part as { gate?: Partial<GateSummary> }).gate
    if (!g) continue
    out ??= { scanned: 0, held: 0, flagged: 0, errors: 0, mode: g.mode ?? "shadow" }
    out.scanned += g.scanned ?? 0
    out.held += g.held ?? 0
    out.flagged += g.flagged ?? 0
    out.errors += g.errors ?? 0
    if (g.mode === "enforce") out.mode = "enforce"
  }
  return out
}

/** The mark on the fold: one quiet line when clean, the count that matters when not. */
export function gateMarkText(g: GateSummary): { text: string; tone: "clean" | "held" | "flagged" | "unscanned" } {
  if (g.held > 0) return { text: `Gate held ${g.held}`, tone: "held" }
  if (g.flagged > 0) return { text: `Gate flagged ${g.flagged}`, tone: "flagged" }
  if (g.scanned > 0 && g.errors >= g.scanned) return { text: "Gate unavailable", tone: "unscanned" }
  return { text: `Gate · ${g.scanned - g.errors} clean`, tone: "clean" }
}
