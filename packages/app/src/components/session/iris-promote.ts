/**
 * PROMOTE (#186584, epic #186508 component 3): documents this session made show up in
 * Genesis › Artifacts without the agent calling the artifact tool.
 *
 * THE SOURCE IS THE SESSION'S CHANGED FILES, not the write/edit tools. The epic's first plan
 * hooked those tools, and it would have missed the case that prompted this ticket: a .xlsx
 * built by a python script run through Shell never passes through write/edit. Every user turn's
 * `summary.diffs` is a snapshot diff of the worktree, so it sees a file however it was made.
 *
 * Pure, so the rules are tested without a session.
 */

export type FileKind = "sheet" | "csv" | "docx" | "pdf" | "markdown" | "html"

const KIND_BY_EXT: Record<string, FileKind> = {
  xlsx: "sheet",
  xlsm: "sheet",
  csv: "csv",
  tsv: "csv",
  docx: "docx",
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
}

export interface PromotedFile {
  /** Stable id in the Artifacts list — never collides with a tool artifact's id. */
  id: string
  /** Project-relative path, as the diff reports it. */
  path: string
  name: string
  kind: FileKind
  status: "added" | "modified"
  /** The user turn whose diff last touched it; newest first in the list. */
  messageID: string
  order: number
}

interface DiffLike {
  file?: string
  status?: "added" | "deleted" | "modified"
}
interface MessageLike {
  id: string
  role: string
  summary?: { diffs?: DiffLike[] } | unknown
}

export function fileKind(path: string): FileKind | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? KIND_BY_EXT[m[1].toLowerCase()] : undefined
}

/**
 * Only paths inside the project. The diff reports project-relative paths; anything absolute or
 * climbing out is refused rather than resolved, so a promoted row can never read outside it.
 */
export function safeRelative(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path)) return false
  return !path.split(/[\\/]/).some((seg) => seg === "..")
}

const IGNORED = [/^node_modules\//, /(^|\/)\.git\//, /^\.iris\/artifacts\//]

/** The documents this session made or changed, newest turn first, deletions dropped. */
export function promotedFiles(messages: MessageLike[]): PromotedFile[] {
  const latest = new Map<string, PromotedFile>()
  let order = 0
  for (const msg of messages) {
    if (msg.role !== "user") continue
    const diffs = (msg.summary as { diffs?: DiffLike[] } | undefined)?.diffs
    if (!Array.isArray(diffs)) continue
    order++
    for (const d of diffs) {
      const path = d.file
      if (!path || !safeRelative(path) || IGNORED.some((re) => re.test(path))) continue
      if (d.status === "deleted") {
        latest.delete(path)
        continue
      }
      const kind = fileKind(path)
      if (!kind) continue
      const prev = latest.get(path)
      latest.set(path, {
        id: `file:${path}`,
        path,
        name: path.split("/").pop() ?? path,
        kind,
        // A file added in one turn and edited in the next was still made by this session.
        status: prev?.status === "added" ? "added" : d.status === "added" ? "added" : "modified",
        messageID: msg.id,
        order,
      })
    }
  }
  return [...latest.values()].sort((a, b) => b.order - a.order || a.path.localeCompare(b.path))
}

/** A change signature per file, so the viewer re-reads when a later turn touches it again. */
export const fileRevision = (f: PromotedFile) => `${f.messageID}:${f.order}`
