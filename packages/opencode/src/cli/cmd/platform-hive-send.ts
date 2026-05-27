import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, dim, bold, success, highlight, FL_API } from "./iris-api"
import { hiveFetch, fetchNodes, resolveNode } from "./platform-hive-nodes"
import { Auth } from "../../auth"
import { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { basename, join } from "path"
import { homedir } from "os"
import { createCipheriv, createHash, randomBytes } from "crypto"

// ============================================================================
// iris hive send — send files, text, or links to another Hive node
// ============================================================================

const INLINE_TEXT_LIMIT = 100_000 // 100KB — anything bigger auto-escalates to file upload

// ── Phase 2: Edge encryption ────────────────────────────────────────────────
// Files are encrypted before uploading to CDN. Cloud only ever sees encrypted blobs.
// Key: SHA-256 of node_api_key from ~/.iris/config.json (both nodes share same user auth).
// IV: random 16 bytes, sent in task config so receiver can decrypt.
// Algorithm: AES-256-CBC.

function deriveEncryptionKey(): Buffer {
  try {
    const fs = require("fs")
    const configPath = join(homedir(), ".iris", "config.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    const secret = config.node_api_key || config.api_key || ""
    return createHash("sha256").update(secret).digest()
  } catch {
    throw new Error("Cannot derive encryption key — ~/.iris/config.json missing or invalid")
  }
}

function encryptFile(inputPath: string): { encryptedPath: string; iv: string } {
  const key = deriveEncryptionKey()
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-cbc", key, iv)

  const inputData = readFileSync(inputPath)
  const encrypted = Buffer.concat([cipher.update(inputData), cipher.final()])

  const encryptedPath = `${inputPath}.enc`
  writeFileSync(encryptedPath, encrypted)

  return { encryptedPath, iv: iv.toString("hex") }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(1)} ${units[i]}`
}

type InboxType = "file" | "text" | "link"

function detectType(input: string): InboxType {
  if (/^https?:\/\//i.test(input)) return "link"
  if (existsSync(input)) return "file"
  return "text"
}

/** TTL defaults: files=24h, text/links=7d */
function defaultExpiresAt(type: InboxType): string {
  const ms = type === "file" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
  return new Date(Date.now() + ms).toISOString()
}

async function resolveToken(): Promise<string> {
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) return stored.key
  if (process.env.FL_API_TOKEN) return process.env.FL_API_TOKEN
  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  return ""
}

async function uploadToCloud(filePath: string, filename: string): Promise<{ cdn_url: string; file_size: number }> {
  const fileBuffer = readFileSync(filePath)
  const blob = new Blob([new Uint8Array(fileBuffer)])
  const form = new FormData()
  form.append("file", blob, filename)
  form.append("type", "digital_product")
  form.append("title", `hive-send: ${filename}`)
  // Short expiration — daemon downloads immediately, CDN copy is just transit
  form.append("expires_days", "1")
  const userId = process.env.IRIS_USER_ID ?? "193"
  form.append("user_id", userId)

  const token = await resolveToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, {
    method: "POST",
    body: form,
    headers,
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`)
    throw new Error(`Upload failed: ${msg.slice(0, 300)}`)
  }

  const data = (await res.json()) as any
  const result = data?.data ?? data
  return {
    cdn_url: result.cdn_url ?? result.url ?? result.filepath ?? "",
    file_size: result.file_size ?? fileBuffer.length,
  }
}

function appendOutboxHistory(entry: Record<string, unknown>) {
  const dir = join(homedir(), ".iris", "hive", "outbox")
  mkdirSync(dir, { recursive: true })
  const historyPath = join(dir, ".history.jsonl")
  appendFileSync(historyPath, JSON.stringify(entry) + "\n")
}

interface DispatchResult { task_id: string; node_name: string; ok: boolean; error?: string }

async function dispatchToNode(
  userId: number,
  nodeId: string,
  nodeName: string,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  try {
    const res = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        title: `hive send: ${String(payload.inbox_type)} to ${nodeName}`,
        type: "message",
        node_id: nodeId,
        prompt: String(payload.prompt ?? ""),
        config: {
          sender_name: payload.sender_name,
          hive_inbox: true,
          inbox_type: payload.inbox_type,
          ...(payload.file_url ? { file_url: payload.file_url } : {}),
          ...(payload.file_name ? { file_name: payload.file_name } : {}),
          ...(payload.file_size ? { file_size: payload.file_size } : {}),
          ...(payload.url ? { url: payload.url } : {}),
          ...(payload.encrypted ? { encrypted: true, encryption_iv: payload.encryption_iv } : {}),
          expires_at: payload.expires_at,
        },
      }),
    })
    if (!res.ok) {
      return { task_id: "", node_name: nodeName, ok: false, error: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as { task: { id: string } }
    return { task_id: data.task.id, node_name: nodeName, ok: true }
  } catch (err: any) {
    return { task_id: "", node_name: nodeName, ok: false, error: err.message }
  }
}

// ============================================================================
// Command
// ============================================================================

export const HiveSendCommand = cmd({
  command: "send <content>",
  describe: "send a file, text, or link to another Hive node",
  builder: (yargs) =>
    yargs
      .positional("content", { describe: "file path, URL, or text message", type: "string", demandOption: true })
      .option("to", { describe: "target node name/id, or 'all'", type: "string", demandOption: true })
      .option("message", { alias: "m", describe: "optional message (for file/link sends)", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Hive Send") }

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) { prompts.outro("Done"); return }

    const content = String(argv.content)
    const target = String(argv.to)
    const message = argv.message as string | undefined
    const type = detectType(content)

    // Read sender node name from config
    let senderName = "Unknown"
    try {
      const fs = require("fs")
      const configPath = join(homedir(), ".iris", "config.json")
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
        senderName = config.node_name || config.name || "Unknown"
      }
    } catch {}

    // Resolve target nodes
    let targetNodes: { id: string; name: string }[]

    if (target.toLowerCase() === "all") {
      const allNodes = await fetchNodes(userId)
      // Filter to online nodes, exclude self
      targetNodes = allNodes
        .filter((n) => n.connection_status === "online" && n.name !== senderName)
      if (targetNodes.length === 0) {
        if (!argv.json) prompts.log.error("No other online nodes found.")
        process.exit(1)
      }
    } else {
      const node = await resolveNode(userId, target)
      if (!node) {
        if (!argv.json) prompts.log.error(`No node matching "${target}". Run: iris hive nodes list`)
        process.exit(1)
      }
      targetNodes = [node]
    }

    const sp = argv.json ? null : prompts.spinner()

    // Build payload based on type
    const payload: Record<string, unknown> = {
      sender_name: senderName,
      inbox_type: type,
      expires_at: defaultExpiresAt(type),
    }

    if (type === "file") {
      const filePath = content
      const fileName = basename(filePath)
      const fileSize = statSync(filePath).size

      if (fileSize > 95 * 1024 * 1024) {
        if (!argv.json) prompts.log.error("File exceeds 95MB limit. Use cloud:upload for large files.")
        process.exit(1)
      }

      // Phase 2: Encrypt before upload — cloud only sees encrypted blob
      sp?.start(`Encrypting + uploading ${fileName} (${formatBytes(fileSize)})…`)
      let encryptedPath: string | null = null
      try {
        const enc = encryptFile(filePath)
        encryptedPath = enc.encryptedPath
        const uploaded = await uploadToCloud(encryptedPath, `${fileName}.enc`)
        sp?.stop(success(`Encrypted + uploaded ${formatBytes(fileSize)}`))

        payload.file_url = uploaded.cdn_url
        payload.file_name = fileName
        payload.file_size = fileSize // original size, not encrypted size
        payload.prompt = message || `File: ${fileName}`
        payload.encryption_iv = enc.iv
        payload.encrypted = true
      } finally {
        // Clean up temp encrypted file
        if (encryptedPath) try { require("fs").unlinkSync(encryptedPath) } catch {}
      }
    } else if (type === "link") {
      payload.url = content
      payload.prompt = message || content
    } else {
      // Text — check inline size cap
      if (Buffer.byteLength(content, "utf-8") > INLINE_TEXT_LIMIT) {
        // Auto-escalate to file upload (also encrypted)
        sp?.start("Text exceeds 100KB — encrypting + uploading as file…")
        const tmpPath = `/tmp/iris_hive_send_${Date.now()}.txt`
        let encryptedPath: string | null = null
        writeFileSync(tmpPath, content, "utf-8")
        try {
          const enc = encryptFile(tmpPath)
          encryptedPath = enc.encryptedPath
          const uploaded = await uploadToCloud(encryptedPath, "message.txt.enc")
          sp?.stop(success("Encrypted + uploaded as file"))
          payload.inbox_type = "file"
          payload.file_url = uploaded.cdn_url
          payload.file_name = "message.txt"
          payload.file_size = Buffer.byteLength(content, "utf-8")
          payload.prompt = message || "Large text message (sent as file)"
          payload.expires_at = defaultExpiresAt("file")
          payload.encryption_iv = enc.iv
          payload.encrypted = true
        } finally {
          try { require("fs").unlinkSync(tmpPath) } catch {}
          if (encryptedPath) try { require("fs").unlinkSync(encryptedPath) } catch {}
        }
      } else {
        payload.prompt = content
      }
    }

    // Dispatch to target node(s)
    const nodeLabel = targetNodes.length === 1
      ? bold(targetNodes[0].name)
      : `${targetNodes.length} nodes`
    sp?.start(`Sending to ${nodeLabel}…`)

    let results: DispatchResult[]
    if (targetNodes.length === 1) {
      const r = await dispatchToNode(userId, targetNodes[0].id, targetNodes[0].name, payload)
      results = [r]
    } else {
      // Broadcast — allSettled for safety
      results = await Promise.all(
        targetNodes.map((n) => dispatchToNode(userId, n.id, n.name, payload)),
      )
    }

    const ok = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)

    sp?.stop(ok.length > 0
      ? success(`Sent to ${ok.length}/${results.length} node(s)`)
      : "All sends failed",
    )

    // Record to outbox history
    for (const r of ok) {
      appendOutboxHistory({
        id: r.task_id,
        to_node: r.node_name,
        type: payload.inbox_type,
        content: type === "file" ? basename(content) : content.substring(0, 200),
        sent_at: new Date().toISOString(),
      })
    }

    if (argv.json) {
      console.log(JSON.stringify({ sent: ok.length, failed: failed.length, results }, null, 2))
      return
    }

    for (const r of ok) {
      console.log(`  ${success("✓")} ${r.node_name}  task=${r.task_id.slice(0, 8)}`)
    }
    for (const r of failed) {
      console.log(`  ${dim("✗")} ${r.node_name}  ${r.error}`)
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// iris hive sent — show outbox history
// ============================================================================

export const HiveSentCommand = cmd({
  command: "sent",
  describe: "show outbox history (what you sent)",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max items", type: "number", default: 20 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const historyPath = join(homedir(), ".iris", "hive", "outbox", ".history.jsonl")

    if (!existsSync(historyPath)) {
      if (argv.json) { console.log("[]"); return }
      console.log(dim("  No sent items yet."))
      return
    }

    const raw = readFileSync(historyPath, "utf-8").trim()
    if (!raw) {
      if (argv.json) { console.log("[]"); return }
      console.log(dim("  No sent items yet."))
      return
    }

    const items = raw.split("\n").map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean).reverse().slice(0, argv.limit as number)

    if (argv.json) {
      console.log(JSON.stringify(items, null, 2))
      return
    }

    console.log()
    console.log(bold("  Recent sends"))
    console.log(dim("  " + "─".repeat(70)))
    for (const item of items) {
      const ago = timeAgo(item.sent_at)
      const preview = String(item.content ?? "").substring(0, 40)
      console.log(`  ${dim(item.type?.padEnd(5) ?? "?")}  ${bold(item.to_node ?? "?")}  ${preview}  ${dim(ago)}`)
    }
    console.log()
  },
})

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
