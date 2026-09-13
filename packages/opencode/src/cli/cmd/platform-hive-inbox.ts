import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, writeJson, requireAuth, requireUserId } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { deliverToInbox, resolveOwnOrPeerNode } from "./platform-hive-peer"
// Reused rather than reimplemented: `7d`, `36h`, `90m`, `30s`, `2w`, bare number = days, and
// null when unparseable. A second duration format would be a second thing to get wrong.
import { parseDuration } from "./platform-atlas-store"
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import { execSync } from "child_process"

// ============================================================================
// iris hive inbox — local inbox for received files, text, and links
// ============================================================================

const INBOX_DIR = join(homedir(), ".iris", "hive", "inbox")
const MANIFEST_PATH = join(INBOX_DIR, ".manifest.jsonl")
const PRUNE_DAYS = 14

interface InboxItem {
  id: string
  task_id?: string | null
  file: string
  // file/text/link from `hive send`; message/handoff/job are agent-to-agent work (epic #184516):
  // a custom message, a work item delivered for this agent, and an executed handoff's result.
  type: "file" | "text" | "link" | "message" | "handoff" | "job"
  from_node: string
  from_user?: string
  received_at: string
  size_bytes?: number
  read: boolean
  original_name?: string
  message?: string
  url?: string
  /** The work-item reference on a handoff/job, e.g. bloq:item:1234 / atlas:item:12345. */
  item?: string | null
  /** pending (delivered, not run) · completed · failed — on handoff/job. */
  status?: string | null
  /** The executed job's output (truncated by the daemon). */
  result?: string | null
  /**
   * Burn-after-read: delete the body and this manifest row the first time the item is opened.
   * Absent on everything written before this shipped, so `undefined` must behave as false.
   */
  burn?: boolean
}

/** What the list shows in the Name column: the work item for handoffs/jobs, a type tag for messages. */
function displayName(item: InboxItem): string {
  if (item.type === "handoff" || item.type === "job") {
    const st = item.status ? ` [${item.status}]` : ""
    return `${item.type === "job" ? "JOB" : "HANDOFF"} ${item.item ?? "?"}${st}`
  }
  if (item.type === "message") return `MSG ${(item.message ?? "").substring(0, 24)}`
  return item.original_name ?? item.file ?? "?"
}

function ensureInboxDir() {
  mkdirSync(INBOX_DIR, { recursive: true })
}

function readManifest(): InboxItem[] {
  if (!existsSync(MANIFEST_PATH)) return []
  const raw = readFileSync(MANIFEST_PATH, "utf-8").trim()
  if (!raw) return []
  return raw.split("\n").map((line) => {
    try { return JSON.parse(line) as InboxItem } catch { return null }
  }).filter(Boolean) as InboxItem[]
}

function writeManifest(items: InboxItem[]) {
  ensureInboxDir()
  writeFileSync(MANIFEST_PATH, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""))
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[i]}`
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Phase 3: Send read receipt — notify sender that item was read */
async function sendReadReceipt(item: InboxItem) {
  if (!item.task_id) return
  try {
    await hiveFetch(`/api/v6/nodes/tasks/${item.task_id}/read`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    })
  } catch { /* non-critical — read receipt is best-effort */ }
}

/**
 * Burn-after-read: once a `burn` item has been opened, delete its body and drop its row.
 *
 * Deliberately destructive and deliberately silent about the content — the whole point is that
 * there is nothing left to read a second time. It runs AFTER the item has been rendered, so the
 * reader still sees it once; running it earlier would delete the thing the user asked for.
 *
 * `burn` is absent on every item written before this shipped, so undefined must behave as false.
 */
function burnIfRequested(item: InboxItem, items: InboxItem[]): void {
  if (item.burn !== true) return
  try {
    const filePath = join(INBOX_DIR, item.file)
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    /* the manifest row still goes — a body we could not unlink must not keep a readable row */
  }
  writeManifest(items.filter((i) => i.id !== item.id))
  console.log(`  ${dim("burned — this item is gone and cannot be read again")}`)
}

/** Auto-prune items older than PRUNE_DAYS */
function autoPrune(items: InboxItem[]): InboxItem[] {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000
  const keep: InboxItem[] = []
  const pruned: string[] = []

  for (const item of items) {
    if (new Date(item.received_at).getTime() < cutoff) {
      // Delete file from disk
      const filePath = join(INBOX_DIR, item.file)
      try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}
      pruned.push(item.file)
    } else {
      keep.push(item)
    }
  }

  if (pruned.length > 0) {
    writeManifest(keep)
  }

  return keep
}

/** Check inbox total size and warn if over threshold */
function checkDiskUsage(items: InboxItem[]): number {
  let total = 0
  for (const item of items) {
    total += item.size_bytes ?? 0
  }
  return total
}

// ============================================================================
// iris hive inbox (list)
// ============================================================================

const HiveInboxListCommand = cmd({
  command: "$0",
  describe: "list inbox items",
  builder: (yargs) =>
    yargs
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("unread", { describe: "show only unread items", type: "boolean", default: false }),
  async handler(argv) {
    ensureInboxDir()
    let items = readManifest()
    items = autoPrune(items)

    if (argv.unread) {
      items = items.filter((i) => !i.read)
    }

    if (argv.json) {
      await writeJson(items)
      return
    }

    if (items.length === 0) {
      console.log(dim("  Inbox empty."))
      return
    }

    const totalSize = checkDiskUsage(items)
    if (totalSize > 500 * 1024 * 1024) {
      console.log(`  ${highlight("Warning:")} inbox is ${formatBytes(totalSize)}. Run: iris hive inbox clear --read`)
    }

    console.log()
    console.log(bold("  #   Status  Name                           From                   Age        Size"))
    console.log(dim("  " + "─".repeat(85)))

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const num = String(i + 1).padStart(3)
      const badge = item.read ? "     " : `${success("NEW")}  `
      const name = displayName(item).substring(0, 30).padEnd(30)
      const from = (item.from_node ?? "?").substring(0, 22).padEnd(22)
      const ago = timeAgo(item.received_at).padEnd(10)
      const size = item.type === "link" ? "link".padEnd(8) : formatBytes(item.size_bytes).padEnd(8)
      console.log(`  ${num}  ${badge} ${name} ${from} ${ago} ${size}`)
      if (item.message && item.message !== item.file) {
        console.log(`       ${dim(item.message.substring(0, 70))}`)
      }
    }
    console.log()
    const unread = items.filter((i) => !i.read).length
    console.log(dim(`  ${items.length} item(s), ${unread} unread.`))
    console.log()
  },
})

// ============================================================================
// iris hive inbox open <n>
// ============================================================================

const HiveInboxOpenCommand = cmd({
  command: "open <number>",
  describe: "open an inbox item (file or link)",
  builder: (yargs) =>
    yargs
      .positional("number", { describe: "item number (from list)", type: "number", demandOption: true }),
  async handler(argv) {
    const items = readManifest()
    const idx = Number(argv.number) - 1
    if (idx < 0 || idx >= items.length) {
      console.error(`Invalid item number. Inbox has ${items.length} item(s).`)
      process.exit(1)
    }

    const item = items[idx]

    // Mark as read + send read receipt
    if (!item.read) {
      item.read = true
      writeManifest(items)
      sendReadReceipt(item).catch(() => {})
    }
    // Burn runs at the END of this handler (see the finally-style call after rendering), not
    // here: deleting before the body is printed would destroy the thing being opened.

    if (item.type === "link" && item.url) {
      console.log(`  Opening: ${highlight(item.url)}`)
      try { execSync(`open "${item.url.replace(/"/g, '')}"`, { stdio: "ignore" }) } catch {}
    } else {
      const filePath = join(INBOX_DIR, item.file)
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`)
        process.exit(1)
      }
      console.log(`  Opening: ${highlight(item.file)}`)
      try { execSync(`open "${filePath.replace(/"/g, '')}"`, { stdio: "ignore" }) } catch {}
    }

    // Every path above has now shown the item, so this is the last honest moment to destroy it.
    burnIfRequested(item, items)
  },
})

// ============================================================================
// iris hive inbox read <n>
// ============================================================================

const HiveInboxReadCommand = cmd({
  command: "read <number>",
  describe: "print text content of an inbox item to terminal",
  builder: (yargs) =>
    yargs
      .positional("number", { describe: "item number (from list)", type: "number", demandOption: true }),
  async handler(argv) {
    const items = readManifest()
    const idx = Number(argv.number) - 1
    if (idx < 0 || idx >= items.length) {
      console.error(`Invalid item number. Inbox has ${items.length} item(s).`)
      process.exit(1)
    }

    const item = items[idx]

    // Mark as read + send read receipt
    if (!item.read) {
      item.read = true
      writeManifest(items)
      sendReadReceipt(item).catch(() => {})
    }
    // Burn runs at the END of this handler (see the finally-style call after rendering), not
    // here: deleting before the body is printed would destroy the thing being opened.

    if (item.type === "link") {
      console.log()
      console.log(`  ${bold("Link from")} ${item.from_node}`)
      console.log(`  ${highlight(item.url ?? "")}`)
      if (item.message) console.log(`  ${dim(item.message)}`)
      console.log()
      // This path RETURNS early, so it needs its own burn. A single call at the bottom of the
      // handler would silently spare every link — the failure would be "burn quietly did
      // nothing for one type", which is indistinguishable from working.
      burnIfRequested(item, items)
      return
    }

    const filePath = join(INBOX_DIR, item.file)
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`)
      process.exit(1)
    }

    console.log()
    console.log(`  ${bold("From:")} ${item.from_node}  ${dim(timeAgo(item.received_at))}`)
    if (item.message && item.type === "file") {
      console.log(`  ${bold("Message:")} ${item.message}`)
    }
    console.log(dim("  " + "─".repeat(60)))
    console.log(readFileSync(filePath, "utf-8"))
    console.log(dim("  " + "─".repeat(60)))
    console.log()

    // Body has been printed. Now it can go.
    burnIfRequested(item, items)
  },
})

// ============================================================================
// iris hive inbox clear
// ============================================================================

const HiveInboxClearCommand = cmd({
  command: "clear",
  describe: "delete inbox items",
  builder: (yargs) =>
    yargs
      .option("read", { describe: "only clear read items", type: "boolean", default: false })
      .option("older", { describe: "clear items older than duration (e.g. 7d)", type: "string" })
      .option("yes", { alias: "y", describe: "skip confirmation", type: "boolean", default: false }),
  async handler(argv) {
    const items = readManifest()
    if (items.length === 0) {
      console.log(dim("  Inbox already empty."))
      return
    }

    let toRemove: InboxItem[]
    let toKeep: InboxItem[]

    if (argv.older) {
      const match = String(argv.older).match(/^(\d+)\s*d/)
      const days = match ? parseInt(match[1], 10) : 7
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      toRemove = items.filter((i) => new Date(i.received_at).getTime() < cutoff)
      toKeep = items.filter((i) => new Date(i.received_at).getTime() >= cutoff)
    } else if (argv.read) {
      toRemove = items.filter((i) => i.read)
      toKeep = items.filter((i) => !i.read)
    } else {
      toRemove = items
      toKeep = []
    }

    if (toRemove.length === 0) {
      console.log(dim("  Nothing to clear."))
      return
    }

    if (!argv.yes) {
      const ok = await prompts.confirm({ message: `Delete ${toRemove.length} item(s)?` })
      if (!ok) return
    }

    // Delete files
    for (const item of toRemove) {
      const filePath = join(INBOX_DIR, item.file)
      try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}
    }

    writeManifest(toKeep)
    console.log(success(`  Cleared ${toRemove.length} item(s). ${toKeep.length} remaining.`))
  },
})

// ============================================================================
// iris hive inbox count
// ============================================================================

const HiveInboxCountCommand = cmd({
  command: "count",
  describe: "show inbox item count (for scripts/status bars)",
  builder: (yargs) =>
    yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const items = readManifest()
    const unread = items.filter((i) => !i.read).length
    const read = items.length - unread

    if (argv.json) {
      console.log(JSON.stringify({ total: items.length, unread, read }))
      return
    }

    console.log(`${unread} new, ${read} read`)
  },
})

// ============================================================================
// iris hive inbox send --target <node> <message..>
//
// The client-facing verb for "tell your agent to check the hive inbox" (epic #184516). A thin
// door onto the same substrate `iris hive send` uses — a message task in the recipient's inbox —
// but it reaches a PEER's node too, through the relay on an active connection. Text only: files
// and links keep their richer path in `iris hive send`.
// ============================================================================

const HiveInboxSendCommand = cmd({
  command: "send [message..]",
  describe: "send a message to an agent's hive inbox — your node, or a peer's",
  builder: (yargs) =>
    yargs
      .positional("message", { describe: "message text", type: "string" })
      .option("target", { alias: ["to", "t"], describe: "target node — yours, or a peer's", type: "string", demandOption: true })
      .option("expires", { describe: "how long it stays deliverable: 30m, 4h, 7d (default 7d)", type: "string" })
      .option("burn", { describe: "delete it from their inbox the first time it is read", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Hive Inbox — send") }

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) { prompts.outro("Done"); return }

    let text = Array.isArray(argv.message) ? argv.message.join(" ") : String(argv.message ?? "")
    if (!text.trim()) {
      // ONLY a real terminal gets a prompt (#184561). A non-TTY caller — an agent, a pipe, CI —
      // used to reach prompts.text() and block forever on a stdin that never produces a line:
      // measured as a HANG, not an error, which consumes the caller and emits no signal at all.
      // --json means a machine is asking, so it never prompts either. This is the sibling of
      // #184552, where the same shape exits 0 having silently discarded the message.
      if (argv.json || !process.stdin.isTTY) {
        console.error(`No message given. Pass it as an argument:\n  iris hive inbox send --target ${argv.target ?? "<node>"} "your message"`)
        process.exit(1)
      }
      const input = await prompts.text({ message: "Message:", placeholder: "Type your message..." })
      if (prompts.isCancel(input) || !input) { prompts.outro("Cancelled"); return }
      text = String(input)
    }

    const target = await resolveOwnOrPeerNode(userId, String(argv.target))
    if (!target) {
      prompts.log.error(`No node matching "${argv.target}" among your nodes or your peers' online nodes.`)
      process.exit(1)
    }

    // Refuse an unparseable TTL rather than silently falling back to 7 days: "--expires soon"
    // quietly becoming a week is the kind of accepted-and-ignored input this whole area has
    // been full of.
    let ttlMs: number | undefined
    if (argv.expires !== undefined) {
      const parsed = parseDuration(String(argv.expires))
      if (parsed === null || parsed <= 0) {
        console.error(`Could not read --expires "${argv.expires}". Use 30m, 4h, 7d, or a bare number of days.`)
        process.exit(1)
      }
      ttlMs = parsed
    }

    const sp = argv.json ? null : prompts.spinner()
    sp?.start(`Sending to ${target.node.name}…`)
    const r = await deliverToInbox(userId, target, {
      text,
      inboxType: "message",
      ttlMs,
      burn: Boolean(argv.burn),
    })
    if (!r.ok) { sp?.stop("Failed", 1); prompts.log.error(r.error ?? "send failed"); process.exit(1) }

    const via = target.kind === "peer" ? dim(` (${target.peerName}, via relay)`) : ""
    sp?.stop(success(`Sent to ${bold(target.node.name)}${via}`))
    if (target.node.connection_status && target.node.connection_status !== "online") {
      prompts.log.warn(`${target.node.name} is offline — it delivers when they reconnect`)
    }
    if (argv.json) { await writeJson({ ok: true, task_id: r.taskId, node: target.node.name, via: target.kind }); return }
    console.log(`  ${dim("they read it with:")} iris hive inbox`)
    prompts.outro("Done")
  },
})

// ============================================================================
// iris hive inbox (root command)
// ============================================================================

export const HiveInboxCommand = cmd({
  command: "inbox [action]",
  describe: "view and manage your Hive inbox",
  builder: (yargs) =>
    yargs
      .command(HiveInboxOpenCommand)
      .command(HiveInboxReadCommand)
      .command(HiveInboxClearCommand)
      .command(HiveInboxCountCommand)
      .command(HiveInboxSendCommand)
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("unread", { describe: "show only unread items", type: "boolean", default: false }),
  async handler(argv) {
    // Default action: list inbox
    ensureInboxDir()
    let items = readManifest()
    items = autoPrune(items)

    if (argv.unread) {
      items = items.filter((i: InboxItem) => !i.read)
    }

    if (argv.json) {
      await writeJson(items)
      return
    }

    if (items.length === 0) {
      console.log(dim("  Inbox empty."))
      return
    }

    const totalSize = checkDiskUsage(items)
    if (totalSize > 500 * 1024 * 1024) {
      console.log(`  ${highlight("Warning:")} inbox is ${formatBytes(totalSize)}. Run: iris hive inbox clear --read`)
    }

    console.log()
    console.log(bold("  #   Status  Name                           From                   Age        Size"))
    console.log(dim("  " + "─".repeat(85)))

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const num = String(i + 1).padStart(3)
      const badge = item.read ? "     " : `${success("NEW")}  `
      const name = displayName(item).substring(0, 30).padEnd(30)
      const from = (item.from_node ?? "?").substring(0, 22).padEnd(22)
      const ago = timeAgo(item.received_at).padEnd(10)
      const size = item.type === "link" ? "link".padEnd(8) : formatBytes(item.size_bytes).padEnd(8)
      console.log(`  ${num}  ${badge} ${name} ${from} ${ago} ${size}`)
      if (item.message && item.message !== item.file) {
        console.log(`       ${dim(item.message.substring(0, 70))}`)
      }
    }
    console.log()
    const unread = items.filter((i: InboxItem) => !i.read).length
    console.log(dim(`  ${items.length} item(s), ${unread} unread.`))
    console.log()
  },
})
