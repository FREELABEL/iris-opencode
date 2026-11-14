import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, dim, bold, success, highlight, FL_API, writeJson } from "./iris-api"
import { hiveFetch, fetchNodes } from "./platform-hive-nodes"
import { deliverToInbox, resolveOwnOrPeerNode, senderNodeName } from "./platform-hive-peer"
import { Auth } from "../../auth"
import { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { basename, join } from "path"
import { homedir } from "os"
import { createCipheriv, createHash, randomBytes, randomUUID } from "crypto"
import { ENVELOPE_VERSION, generateDek, sealContent, wrapDek } from "../lib/envelope"
import { tmpdir } from "os"
import { NoNodeKeyError, decideSeal, e2eMode, nodeKeyFetch, sealedConfigFields, type TargetsOutcome } from "./hive-e2e"

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

// ── Phase 3: envelope encryption (ihw.v1) — ON BY DEFAULT ───────────────────
//
// The legacy path below encrypts with SHA-256(the SENDER's own node_api_key), a key the platform
// can derive. The envelope path seals under a fresh per-transfer DEK and wraps that DEK to the
// RECIPIENT's registered public key (plus any escrow holders policy requires), so only the
// recipient can read it. Our servers store ciphertext they cannot open.
//
// Default (hive-e2e.ts → e2eMode): seal whenever the recipient has published a key; if it hasn't,
// fall back to legacy WITH A WARNING naming the command to run there. `--envelope` refuses instead
// of falling back; `--no-envelope` turns sealing off. The daemon reads both formats.

interface EnvelopeTarget { type: string; id: string; public_key: string }

/** Ask which public keys a transfer to this node must be wrapped to. Never throws. */
async function lookupTargets(
  recipientNodeId: string,
  opts: { tenant?: string; class?: string },
): Promise<{ outcome: TargetsOutcome; targets: EnvelopeTarget[] }> {
  const params = new URLSearchParams({ recipient_type: "node", recipient_id: recipientNodeId })
  if (opts.tenant) params.set("tenant", opts.tenant)
  if (opts.class) params.set("class", opts.class)
  let res: Response
  try {
    res = await nodeKeyFetch(`/api/v6/hive/transfers/targets?${params.toString()}`)
  } catch (e: any) {
    if (e instanceof NoNodeKeyError) return { outcome: { ok: false, code: "no_node_key", message: e.message }, targets: [] }
    return { outcome: { ok: false, code: "other", message: e?.message ?? String(e) }, targets: [] }
  }
  const body: any = await res.json().catch(() => ({}))
  if (res.ok && Array.isArray(body?.targets) && body.targets.length > 0) {
    return { outcome: { ok: true }, targets: body.targets }
  }
  // Surfaced verbatim: "no_recipient_key" is the common case and its message says what to run.
  const message = body?.message ?? `could not resolve envelope targets (HTTP ${res.status})`
  if (body?.error === "no_recipient_key") return { outcome: { ok: false, code: "no_recipient_key", message }, targets: [] }
  if (res.status === 401) return { outcome: { ok: false, code: "no_node_key", message }, targets: [] }
  if (res.status === 409 && typeof body?.error === "string" && body.error.startsWith("escrow_")) {
    return { outcome: { ok: false, code: "server_policy", message }, targets: [] }
  }
  return { outcome: { ok: false, code: "other", message }, targets: [] }
}

/**
 * Seal bytes for ONE recipient node and record the wraps server-side. Returns the ciphertext and
 * the task-config fields the daemon needs to open it.
 *
 * Order is deliberate: the wraps are recorded BEFORE the task is created. Reversed, a failure
 * between the two would hand the recipient a task pointing at a blob whose DEK was never granted
 * to anyone — an unopenable delivery that looks successful.
 *
 * The envelope id is generated here rather than reusing the task id, because the AAD must be
 * fixed at seal time and the task does not exist yet.
 */
async function sealForRecipient(
  plaintext: Buffer,
  recipientNodeId: string,
  targets: EnvelopeTarget[],
  opts: { tenant?: string; class?: string },
): Promise<{ ciphertext: Buffer; fields: Record<string, unknown> }> {
  const envelopeId = randomUUID()
  const dek = generateDek()
  const sealed = sealContent(plaintext, dek, envelopeId)

  const wraps = targets.map((t) => {
    const w = wrapDek(dek, Buffer.from(t.public_key, "base64"), envelopeId, t.id)
    return {
      target_id: t.id,
      eph_public: w.ephPublic.toString("base64"),
      nonce: w.nonce.toString("base64"),
      wrapped_dek: w.ciphertext.toString("base64"),
      tag: w.tag.toString("base64"),
    }
  })
  dek.fill(0)

  const recordRes = await nodeKeyFetch(`/api/v6/hive/transfers/${envelopeId}/wraps`, {
    method: "POST",
    body: JSON.stringify({ recipient_type: "node", recipient_id: recipientNodeId, tenant: opts.tenant, class: opts.class, wraps }),
  })
  if (!recordRes.ok) {
    const body: any = await recordRes.json().catch(() => ({}))
    throw new Error(body?.message ?? `could not record envelope wraps (HTTP ${recordRes.status})`)
  }

  return {
    ciphertext: sealed.ciphertext,
    fields: {
      encrypted: true,
      envelope_version: ENVELOPE_VERSION,
      envelope_id: envelopeId,
      envelope_nonce: sealed.nonce.toString("base64"),
      envelope_tag: sealed.tag.toString("base64"),
      envelope_target: `node:${recipientNodeId}`,
      // encryption_iv is deliberately ABSENT: the daemon picks the format by envelope_version.
    },
  }
}

/** Upload bytes through a temp file and remove it whatever happens. */
async function uploadBytes(bytes: Buffer, filename: string): Promise<{ cdn_url: string; file_size: number }> {
  const tmp = join(tmpdir(), `iris_hive_send_${randomUUID()}`)
  writeFileSync(tmp, bytes, { mode: 0o600 })
  try {
    return await uploadToCloud(tmp, filename)
  } finally {
    try { require("fs").unlinkSync(tmp) } catch {}
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

interface DispatchResult { task_id: string; node_name: string; ok: boolean; error?: string; sealed?: boolean }

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
          ...sealedConfigFields(payload),
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

/**
 * Which node, and what to send. Two forms, both supported:
 *
 *   iris hive send <content> --to <node>        the documented form
 *   iris hive send <node> <message...>          the form people type first (#189372)
 *
 * `--to` always wins, and with it every positional is content — so an unquoted sentence
 * (`iris hive send hello there --to mac`) sends the whole sentence instead of dropping "there".
 * Pure, so the parsing is tested without a network.
 */
export function resolveSendArgs(
  content: unknown,
  rest: unknown,
  to: unknown,
): { target: string; content: string } | { error: string } {
  const words = [content, ...(Array.isArray(rest) ? rest : rest == null ? [] : [rest])]
    .map((w) => String(w ?? ""))
    .filter((w) => w.length > 0)
  const flag = typeof to === "string" ? to.trim() : ""
  if (flag) {
    if (words.length === 0) return { error: "Nothing to send. Usage: iris hive send <file|url|text> --to <node>" }
    return { target: flag, content: words.join(" ") }
  }
  if (words.length >= 2) return { target: words[0], content: words.slice(1).join(" ") }
  return { error: "No target node. Usage: iris hive send <file|url|text> --to <node>   or   iris hive send <node> <message>" }
}

export const HiveSendCommand = cmd({
  command: "send <content> [rest..]",
  describe: "send a file, text, or link to another Hive node",
  builder: (yargs) =>
    yargs
      .positional("content", { describe: "file path, URL, or text message — or the node, when --to is omitted", type: "string", demandOption: true })
      .positional("rest", { describe: "the message, in the `iris hive send <node> <message>` form", type: "string", array: true })
      .option("to", { describe: "target node name/id, or 'all'", type: "string" })
      .example("iris hive send ./notes.md --to studio-mac", "send a file")
      .example("iris hive send studio-mac \"build is green\"", "send text, node first")
      .option("message", { alias: "m", describe: "optional message (for file/link sends)", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("envelope", {
        describe:
          "end-to-end encryption (on by default when the recipient has a key). --envelope: refuse to send without it. --no-envelope: turn it off",
        type: "boolean",
      })
      .option("tenant", { describe: "tenant slug, for escrow policy resolution", type: "string" })
      .option("class", { describe: "transfer class for escrow policy: phi, financial, general", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Hive Send") }

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) { prompts.outro("Done"); return }

    const parsedArgs = resolveSendArgs(argv.content, argv.rest, argv.to)
    if ("error" in parsedArgs) {
      if (argv.json) console.log(JSON.stringify({ success: false, error: parsedArgs.error }))
      else prompts.log.error(parsedArgs.error)
      process.exit(1)
    }
    const { content, target } = parsedArgs
    const message = argv.message as string | undefined
    const type = detectType(content)

    // Sender name via the shared resolver. This used to read config.node_name directly, which
    // does not exist in ~/.iris/config.json — so every `hive send` arrived as "From: Unknown".
    const senderName = await senderNodeName(userId)

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
      // Your own node, or a PEER's node behind an active connection (epic #184516). The peer path
      // goes through the relay, which only carries text — so a file to a peer is refused here,
      // plainly, rather than uploaded and never delivered.
      const resolved = await resolveOwnOrPeerNode(userId, target)
      if (!resolved) {
        if (!argv.json) prompts.log.error(`No node matching "${target}" among your nodes or your peers' online nodes. Run: iris hive nodes list`)
        process.exit(1)
      }
      if (resolved.kind === "peer") {
        if (type === "file") {
          if (!argv.json) prompts.log.error(`"${resolved.node.name}" belongs to ${resolved.peerName}. Files to a peer's node are not routed yet — send text or a link, or share the file another way.`)
          else console.log(JSON.stringify({ success: false, error: "peer_file_unsupported" }))
          process.exit(1)
        }
        const sp2 = argv.json ? null : prompts.spinner()
        sp2?.start(`Sending to ${resolved.node.name} (${resolved.peerName})…`)
        const r = await deliverToInbox(userId, resolved, {
          text: type === "link" ? (message ? `${content}\n\n${message}` : content) : content,
          inboxType: "message",
        })
        if (!r.ok) { sp2?.stop("Failed", 1); if (!argv.json) prompts.log.error(r.error ?? "send failed"); process.exit(1) }
        sp2?.stop(success(`Sent to ${bold(resolved.node.name)} ${dim(`(${resolved.peerName}, via relay)`)}`))
        appendOutboxHistory({ id: r.taskId ?? "", to_node: resolved.node.name, type, content: content.substring(0, 200), sent_at: new Date().toISOString(), via: "relay" })
        if (argv.json) { await writeJson({ sent: 1, failed: 0, results: [{ task_id: r.taskId ?? "", node_name: resolved.node.name, ok: true, via: "relay" }] }); return }
        console.log(`  ${dim("they read it with:")} iris hive inbox`)
        prompts.outro("Done")
        return
      }
      targetNodes = [resolved.node]
    }

    const sp = argv.json ? null : prompts.spinner()

    // ── What is being sent, independent of who to ──────────────────────────────
    let fileName = ""
    let fileSize = 0
    if (type === "file") {
      fileName = basename(content)
      fileSize = statSync(content).size
      if (fileSize > 95 * 1024 * 1024) {
        if (!argv.json) prompts.log.error("File exceeds 95MB limit. Use cloud:upload for large files.")
        process.exit(1)
      }
    }

    const mode = e2eMode(argv.envelope)
    const envOpts = { tenant: argv.tenant as string | undefined, class: argv.class as string | undefined }
    const notes: string[] = []

    /**
     * Build the delivery for ONE recipient. Each recipient has its own key, so a sealed send to
     * `--to all` seals and uploads once per node.
     */
    const buildPayload = async (node: { id: string; name: string }): Promise<Record<string, unknown> | { error: string }> => {
      const payload: Record<string, unknown> = {
        sender_name: senderName,
        inbox_type: type,
        expires_at: defaultExpiresAt(type),
      }

      const lookup = mode === "off" ? null : await lookupTargets(node.id, envOpts)
      const decision = decideSeal(mode, lookup?.outcome ?? null, node.name, {
        explicitPolicy: Boolean(envOpts.tenant || envOpts.class),
      })
      if ("error" in decision) return { error: decision.error }
      if ("warning" in decision) notes.push(decision.warning)

      if (decision.seal) {
        // END TO END. Text and links are sealed as a small file, because the inbox stores a
        // message's text in the task itself, which our servers can read. The recipient reads it
        // with `iris hive inbox read <n>` exactly as before.
        let plaintext: Buffer
        let name: string
        if (type === "file") {
          plaintext = readFileSync(content)
          name = fileName
        } else if (type === "link") {
          plaintext = Buffer.from(message ? `${content}\n\n${message}\n` : `${content}\n`, "utf-8")
          name = "link.txt"
        } else {
          plaintext = Buffer.from(content, "utf-8")
          name = "message.txt"
        }
        const env = await sealForRecipient(plaintext, node.id, lookup!.targets, envOpts)
        const uploaded = await uploadBytes(env.ciphertext, `${name}.env`)
        payload.inbox_type = "file"
        payload.file_url = uploaded.cdn_url
        payload.file_name = name
        payload.file_size = plaintext.length // original size, not sealed size
        payload.expires_at = defaultExpiresAt("file")
        // The prompt travels in the clear. Only the file name goes in it, never the content.
        payload.prompt = type === "file" ? (message || `File: ${fileName}`) : "End-to-end encrypted message"
        Object.assign(payload, env.fields)
        return payload
      }

      // LEGACY (no recipient key, or --no-envelope).
      if (type === "file") {
        const enc = encryptFile(content)
        try {
          const uploaded = await uploadToCloud(enc.encryptedPath, `${fileName}.enc`)
          payload.file_url = uploaded.cdn_url
        } finally {
          try { require("fs").unlinkSync(enc.encryptedPath) } catch {}
        }
        payload.file_name = fileName
        payload.file_size = fileSize
        payload.prompt = message || `File: ${fileName}`
        payload.encryption_iv = enc.iv
        payload.encrypted = true
      } else if (type === "link") {
        payload.url = content
        payload.prompt = message || content
      } else if (Buffer.byteLength(content, "utf-8") > INLINE_TEXT_LIMIT) {
        // Auto-escalate to file upload (also encrypted)
        const tmpPath = join(tmpdir(), `iris_hive_send_${Date.now()}.txt`)
        writeFileSync(tmpPath, content, "utf-8")
        let encryptedPath: string | null = null
        try {
          const enc = encryptFile(tmpPath)
          encryptedPath = enc.encryptedPath
          const uploaded = await uploadToCloud(encryptedPath, "message.txt.enc")
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
      return payload
    }

    const nodeLabel = targetNodes.length === 1
      ? bold(targetNodes[0].name)
      : `${targetNodes.length} nodes`
    sp?.start(`Encrypting + sending to ${nodeLabel}…`)

    const results: DispatchResult[] = await Promise.all(
      targetNodes.map(async (n): Promise<DispatchResult> => {
        try {
          const built = await buildPayload(n)
          if ("error" in built) return { task_id: "", node_name: n.name, ok: false, error: String(built.error) }
          const r = await dispatchToNode(userId, n.id, n.name, built)
          return { ...r, sealed: built.envelope_version ? true : false }
        } catch (e: any) {
          // FAIL CLOSED: a seal that started and broke is never retried in a weaker scheme.
          return { task_id: "", node_name: n.name, ok: false, error: e?.message ?? String(e) }
        }
      }),
    )

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
        type,
        e2e: r.sealed === true,
        content: type === "file" ? basename(content) : content.substring(0, 200),
        sent_at: new Date().toISOString(),
      })
    }

    const warnings = [...new Set(notes)]
    if (argv.json) {
      await writeJson({ sent: ok.length, failed: failed.length, results, ...(warnings.length ? { warnings } : {}) })
      if (ok.length === 0) process.exit(1)
      return
    }

    for (const w of warnings) prompts.log.warn(w)
    for (const r of ok) {
      const how = r.sealed ? dim("end-to-end encrypted") : highlight("NOT end-to-end encrypted")
      console.log(`  ${success("✓")} ${r.node_name}  task=${r.task_id.slice(0, 8)}  ${how}`)
    }
    for (const r of failed) {
      console.log(`  ${dim("✗")} ${r.node_name}  ${r.error}`)
    }

    prompts.outro("Done")
    if (ok.length === 0) process.exit(1)
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
      await writeJson(items)
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
