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
 * WHAT IT DELIBERATELY DOES NOT DO. It does not open, render or mark anything read. A footer
 * badge that consumed the message would make the count lie the moment you glanced at it. This
 * answers one question — *is there something waiting?* — and leaves the answer to `hive inbox`.
 */

const INBOX_DIR = join(homedir(), ".iris", "hive", "inbox")
const MANIFEST = join(INBOX_DIR, ".manifest.jsonl")

/** Mirrors the shape platform-hive-inbox.ts writes. Only what the badge needs is typed. */
interface ManifestRow {
  read?: boolean
  from_user?: string
  received_at?: string
}

export interface HiveInboxState {
  /** Unread count. Null means NOT MEASURED — never render it as zero. */
  unread: number | null
  /** The most recent unread sender, for a one-line hint. */
  from?: string
  /** True when the manifest exists but could not be parsed — a real fault, not an empty inbox. */
  unreadable: boolean
}

const EMPTY: HiveInboxState = { unread: 0, unreadable: false }

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
    return { unread: null, unreadable: true }
  }

  const lines = raw.split("\n").filter((l) => l.trim())
  if (!lines.length) return EMPTY

  let unread = 0
  let bad = 0
  let from: string | undefined
  let newest = ""

  for (const line of lines) {
    let row: ManifestRow
    try {
      row = JSON.parse(line) as ManifestRow
    } catch {
      bad++
      continue
    }
    if (row.read) continue
    unread++
    const at = String(row.received_at ?? "")
    if (at >= newest) {
      newest = at
      from = row.from_user
    }
  }

  // Every line unparseable is a corrupt manifest, not an empty one.
  if (bad && bad === lines.length) return { unread: null, unreadable: true }

  return { unread, from, unreadable: false }
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
      const sig = existsSync(MANIFEST) ? (() => { const s = statSync(MANIFEST); return `${s.mtimeMs}:${s.size}` })() : "none"
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
