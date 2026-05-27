import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
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
  type: "file" | "text" | "link"
  from_node: string
  from_user?: string
  received_at: string
  size_bytes?: number
  read: boolean
  original_name?: string
  message?: string
  url?: string
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
      console.log(JSON.stringify(items, null, 2))
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
      const name = (item.original_name ?? item.file ?? "?").substring(0, 30).padEnd(30)
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

    if (item.type === "link") {
      console.log()
      console.log(`  ${bold("Link from")} ${item.from_node}`)
      console.log(`  ${highlight(item.url ?? "")}`)
      if (item.message) console.log(`  ${dim(item.message)}`)
      console.log()
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
      console.log(JSON.stringify(items, null, 2))
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
      const name = (item.original_name ?? item.file ?? "?").substring(0, 30).padEnd(30)
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
