import { createSignal, onCleanup, onMount } from "solid-js"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The Hive inbox, surfaced where you are already looking.
 *
 * WHY THIS EXISTS. The inbox is pull-based: the daemon writes a message into
 * ~/.iris/hive/inbox and nothing tells the session it arrived. On 2026-09-11 a client's agent
 * was sent four messages that changed what it was building, and they sat unread until someone
 * on a call said the words "run iris hive inbox read" out loud. The channel worked perfectly.
 * The only broken part was that a person had to already know a message existed.
 *
 * WHY IT READS A FILE AND NOT AN API. The inbox is local. The daemon has already delivered and
 * written it; `hive inbox` reads the same manifest. So this costs a stat() and, only when the
 * file actually changed, one small read. No network, no auth, nothing to be slow or fail.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not open anything or mark anything read. It lists
 * what is waiting — sender, kind, age, one line of subject — because a count plus the words
 * "run iris hive inbox read" is the same instruction the call was already giving out loud. But
 * reading a body is still `hive inbox read <n>`: a panel that consumed a message by being
 * looked at would make the unread count lie the moment you glanced at it, and burn-after-read
 * items would be destroyed by a passing glance.
 */

const INBOX_DIR = join(homedir(), ".iris", "hive", "inbox")
const MANIFEST = join(INBOX_DIR, ".manifest.jsonl")

/** Mirrors the shape platform-hive-inbox.ts writes. Only what the panel needs is typed. */
interface ManifestRow {
  read?: boolean
  from_user?: string
  from_node?: string
  received_at?: string
  type?: string
  message?: string
  original_name?: string
  file?: string
  item?: string | null
  status?: string | null
}

/** One message, as the sidebar renders it. */
export interface HiveInboxItem {
  /** 1-based, matching the number `iris hive inbox read <n>` takes. */
  index: number
  read: boolean
  type: string
  from: string
  /** Relative age — "2h ago". */
  age: string
  /** What it is: the work item for a handoff, the text for a message, the filename otherwise. */
  label: string
}

export interface HiveInboxState {
  /** Unread count. Null means NOT MEASURED — never render it as zero. */
  unread: number | null
  /** The most recent unread sender, for a one-line hint. */
  from?: string
  /** True when the manifest exists but could not be parsed — a real fault, not an empty inbox. */
  unreadable: boolean
  /** Newest first, unread first. Empty when unreadable — the flag above says which. */
  items: HiveInboxItem[]
}

const EMPTY: HiveInboxState = { unread: 0, unreadable: false, items: [] }

function timeAgo(iso: string | undefined): string {
  if (!iso) return ""
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ""
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/** The same one-line summary `iris hive inbox list` prints, so the two cannot disagree. */
function describe(row: ManifestRow): string {
  const type = row.type ?? "file"
  if (type === "handoff" || type === "job") {
    return `${row.item ?? "?"}${row.status ? ` [${row.status}]` : ""}`
  }
  if (type === "message") return row.message ?? "(no text)"
  return row.original_name ?? row.file ?? "?"
}

export function readHiveInbox(): HiveInboxState {
  // No directory means this machine has never received anything. That is a genuine zero, not
  // a failure, and the badge should stay silent.
  if (!existsSync(MANIFEST)) return EMPTY

  let raw: string
  try {
    raw = readFileSync(MANIFEST, "utf-8")
  } catch {
    // Present and unreadable is NOT the same as empty, and reporting zero here would be the
    // exact failure this codebase keeps paying for: a surface that cannot tell absent from
    // not-measured, showing the reassuring one.
    return { unread: null, unreadable: true, items: [] }
  }

  const lines = raw.split("\n").filter((l) => l.trim())
  if (!lines.length) return EMPTY

  let unread = 0
  let bad = 0
  let from: string | undefined
  let newest = ""
  const items: HiveInboxItem[] = []

  for (let i = 0; i < lines.length; i++) {
    let row: ManifestRow
    try {
      row = JSON.parse(lines[i]) as ManifestRow
    } catch {
      bad++
      continue
    }
    // The index is the manifest POSITION, not the position in this array — it is what
    // `iris hive inbox read <n>` takes, and renumbering the rows we happened to keep would
    // print a number that opens a different message.
    items.push({
      index: i + 1,
      read: Boolean(row.read),
      type: row.type ?? "file",
      from: row.from_node ?? row.from_user ?? "a peer",
      age: timeAgo(row.received_at),
      label: describe(row),
    })
    if (row.read) continue
    unread++
    const at = String(row.received_at ?? "")
    if (at >= newest) {
      newest = at
      from = row.from_user ?? row.from_node
    }
  }

  // Every line unparseable is a corrupt manifest, not an empty one.
  if (bad && bad === lines.length) return { unread: null, unreadable: true, items: [] }

  // Unread first, then newest first. What is waiting on you outranks what you have seen.
  items.sort((a, b) => (a.read === b.read ? b.index - a.index : a.read ? 1 : -1))

  return { unread, from, unreadable: false, items }
}

/**
 * Poll the manifest, cheaply.
 *
 * stat() every few seconds, and only re-read when mtime or size actually moved. A message can
 * arrive at any point during a long session, so a value read once at mount would be stale for
 * exactly the case this exists to catch.
 */
export function useHiveInbox(intervalMs = 5000) {
  const [state, setState] = createSignal<HiveInboxState>(EMPTY)
  let lastSig = ""

  function tick() {
    try {
      const sig = existsSync(MANIFEST)
        ? (() => {
            const s = statSync(MANIFEST)
            return `${s.mtimeMs}:${s.size}`
          })()
        : "none"
      if (sig === lastSig) return
      lastSig = sig
      setState(readHiveInbox())
    } catch {
      // A stat that throws is a filesystem problem, not an inbox fact. Leave the last known
      // value alone rather than flashing a zero at someone mid-task.
    }
  }

  onMount(() => {
    tick()
    const timer = setInterval(tick, intervalMs)
    onCleanup(() => clearInterval(timer))
  })

  return state
}
