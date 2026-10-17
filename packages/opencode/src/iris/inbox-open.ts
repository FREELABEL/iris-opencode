/**
 * Open one Hive inbox message from the app (#189763) — the desktop's `iris hive inbox read <n>`.
 *
 * Same rules as the CLI, because a message read in the app and in the terminal must end in the
 * same state: opening marks it read, and a `burn` message is deleted AFTER its body has been
 * returned — the reader sees it once, then there is nothing left to read a second time.
 *
 * `index` is the 1-based MANIFEST line (what /iris/inbox lists), so unparseable lines are kept
 * as they are and never renumber anything.
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"

type Result<T> = { measured: boolean; reason?: string; data: T }

export interface InboxMessage {
  index: number
  type: string
  from: string
  receivedAt?: string
  /** The text: a message's own text, or a small text file's contents. Null for binaries and big files. */
  body: string | null
  url: string | null
  /** Where the file is on disk, when there is one — for "show in Finder". */
  file: string | null
  size: number | null
  /** It was a burn-after-reading message and is now gone. */
  burned: boolean
}

const BODY_MAX = 64 * 1024
const dir = () => path.join(homedir(), ".iris", "hive", "inbox")

/**
 * Pure: the manifest after opening line `index` — marked read, or removed when it burns.
 * Null when the line does not exist or is not JSON. Exported for tests.
 */
export function openLine(raw: string, index: number): { row: Record<string, any>; next: string } | null {
  const lines = raw.split("\n")
  // Lines as /iris/inbox counts them: non-empty ones, numbered from 1.
  const live = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim())
  const hit = live[index - 1]
  if (!hit) return null
  let row: Record<string, any>
  try {
    row = JSON.parse(hit.l)
  } catch {
    return null
  }
  const out = [...lines]
  if (row.burn === true) out.splice(hit.i, 1)
  else out[hit.i] = JSON.stringify({ ...row, read: true })
  return { row, next: out.join("\n") }
}

/** Pure: a file's contents as text, or null when it is binary or too big to show. Exported for tests. */
export function asText(buf: Buffer): string | null {
  if (buf.length > BODY_MAX || buf.includes(0)) return null
  return buf.toString("utf-8")
}

export function openInboxMessage(index: number): Result<{ message: InboxMessage | null }> {
  const manifest = path.join(dir(), ".manifest.jsonl")
  if (!existsSync(manifest)) return { measured: true, reason: "the inbox is empty", data: { message: null } }
  try {
    const opened = openLine(readFileSync(manifest, "utf-8"), index)
    if (!opened) return { measured: false, reason: `no message ${index} in the inbox`, data: { message: null } }
    const { row } = opened
    const filePath = typeof row.file === "string" && row.file ? path.join(dir(), path.basename(row.file)) : null
    let body: string | null = row.type === "message" ? (row.message ?? null) : null
    let size: number | null = typeof row.size_bytes === "number" ? row.size_bytes : null
    if (body === null && filePath && existsSync(filePath)) {
      size = statSync(filePath).size
      if (size <= BODY_MAX) body = asText(readFileSync(filePath))
    }
    const burned = row.burn === true
    // Body read first, THEN the manifest written: a crash in between leaves it unread, not lost.
    const tmp = `${manifest}.${process.pid}.tmp`
    writeFileSync(tmp, opened.next)
    renameSync(tmp, manifest)
    if (burned && filePath) {
      try {
        unlinkSync(filePath)
      } catch {}
    }
    return {
      measured: true,
      data: {
        message: {
          index,
          type: String(row.type ?? "file"),
          from: String(row.from_node ?? row.from_user ?? "a peer"),
          receivedAt: row.received_at,
          body,
          url: typeof row.url === "string" ? row.url : null,
          file: burned ? null : filePath,
          size,
          burned,
        },
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { message: null } }
  }
}
