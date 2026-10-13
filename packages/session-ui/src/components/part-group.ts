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
export type ContextKind = "files" | "iris"
function contextKind(part: PartType): ContextKind | undefined {
  if (isContextGroupTool(part)) return "files"
  if (isIrisGroupTool(part)) return "iris"
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
      // Only an IRIS group carries a kind, so a files group compares equal to one built before it.
      ...(kind === "iris" ? { kind } : {}),
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

export function irisGroupSummary(parts: ToolPart[]) {
  return { ran: parts.length, failed: parts.filter((p) => p.state.status === "error").length }
}

