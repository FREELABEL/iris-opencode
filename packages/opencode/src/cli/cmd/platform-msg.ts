import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, dim, bold, success, highlight } from "./iris-api"

const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

async function hiveFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

// ============================================================================
// iris msg nodes — list all Hive nodes
// ============================================================================

const MsgNodesCommand = cmd({
  command: "nodes",
  aliases: ["peers", "ls"],
  describe: "list all Hive nodes and their status",
  builder: (yargs) =>
    yargs
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Nodes")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading nodes...")

    try {
      const res = await hiveFetch(`/api/v6/nodes?user_id=${userId}`)
      const ok = await handleApiError(res, "List nodes")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const nodes = (json.nodes ?? json.data ?? json) as Record<string, unknown>[]

      spinner.stop(`${nodes.length} node(s)`)

      if (args.json) {
        console.log(JSON.stringify(nodes, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      if (nodes.length === 0) {
        console.log(dim("  No nodes registered. Run: iris-daemon start"))
      } else {
        // Header
        console.log(`  ${bold("NAME".padEnd(24))} ${"STATUS".padEnd(12)} LAST SEEN`)
        console.log(dim("  " + "-".repeat(56)))
        for (const n of nodes) {
          const name = String(n.name ?? "unknown")
          const status = String(n.connection_status ?? "offline")
          const lastSeen = n.last_heartbeat_at ? timeAgo(String(n.last_heartbeat_at)) : dim("never")
          const statusStr = status === "online"
            ? `${UI.Style.TEXT_SUCCESS}● online${UI.Style.TEXT_NORMAL}`
            : dim("○ offline")
          console.log(`  ${bold(name.padEnd(24))} ${statusStr.padEnd(status === "online" ? 20 : 12)} ${lastSeen}`)
        }
      }
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// iris msg send <name> [message] — send a P2P message
// ============================================================================

const MsgSendCommand = cmd({
  command: "send <name> [message..]",
  describe: "send a message to a Hive node",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "recipient node name", type: "string", demandOption: true })
      .positional("message", { describe: "message text", type: "string" })
      .option("user-id", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Send Message")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Resolve message text (positional array or interactive prompt)
    let messageText = Array.isArray(args.message) ? args.message.join(" ") : (args.message || "")
    if (!messageText.trim()) {
      const input = await prompts.text({ message: "Message:", placeholder: "Type your message..." })
      if (prompts.isCancel(input) || !input) { prompts.outro("Cancelled"); return }
      messageText = String(input)
    }

    const spinner = prompts.spinner()
    spinner.start("Finding recipient...")

    try {
      // List nodes to resolve name -> node_id
      const nodesRes = await hiveFetch(`/api/v6/nodes?user_id=${userId}`)
      const nodesOk = await handleApiError(nodesRes, "List nodes")
      if (!nodesOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const nodesJson = await nodesRes.json() as Record<string, unknown>
      const nodes = (nodesJson.nodes ?? nodesJson.data ?? nodesJson) as Record<string, unknown>[]

      // Fuzzy match by name (case-insensitive, prefix match)
      const target = String(args.name).toLowerCase()
      const match = nodes.find(n => {
        const name = String(n.name ?? "").toLowerCase()
        return name === target || name.startsWith(target)
      })

      if (!match) {
        spinner.stop("Not found", 1)
        prompts.log.error(`No node matching "${args.name}". Available: ${nodes.map(n => String(n.name)).join(", ") || "none"}`)
        prompts.outro("Done")
        return
      }

      const recipientNodeId = String(match.id)
      const recipientName = String(match.name)

      // Get sender node name (first node that isn't the recipient, or fallback)
      const senderNode = nodes.find(n => String(n.id) !== recipientNodeId) || nodes[0]
      const senderName = senderNode ? String(senderNode.name) : "unknown"
      const senderNodeId = senderNode ? String(senderNode.id) : ""

      spinner.message(`Sending to ${recipientName}...`)

      // Dispatch message task
      const res = await hiveFetch(`/api/v6/nodes/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          title: `Message from ${senderName}`,
          prompt: messageText,
          type: "message",
          node_id: recipientNodeId,
          config: { sender_name: senderName, sender_node_id: senderNodeId },
          timeout_seconds: 30,
          priority: 10,
        }),
      })

      const sendOk = await handleApiError(res, "Send message")
      if (!sendOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const status = String(match.connection_status ?? "offline")
      spinner.stop(success(`Sent to ${recipientName}`))

      if (status !== "online") {
        prompts.log.warn(`${recipientName} is offline -- message will deliver when they reconnect`)
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// iris msg list — recent message history
// ============================================================================

const MsgListCommand = cmd({
  command: "list",
  aliases: ["history"],
  describe: "show recent messages",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 20 })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Message History")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading messages...")

    try {
      const params = new URLSearchParams({
        user_id: String(userId),
        type: "message",
        limit: String(args.limit),
      })
      const res = await hiveFetch(`/api/v6/nodes/tasks?${params}`)
      const ok = await handleApiError(res, "List messages")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const tasks = (json.tasks ?? json.data ?? json) as Record<string, unknown>[]

      // Filter to message type only (API may not support type filter)
      const messages = tasks.filter(t => t.type === "message")

      spinner.stop(`${messages.length} message(s)`)

      if (args.json) {
        console.log(JSON.stringify(messages, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      if (messages.length === 0) {
        console.log(dim("  No messages yet. Send one with: iris msg send <node> \"hello\""))
      } else {
        for (const m of messages) {
          const config = (m.config ?? {}) as Record<string, unknown>
          const sender = String(config.sender_name ?? "unknown")
          const preview = String(m.prompt ?? m.title ?? "").substring(0, 80)
          const time = m.created_at ? timeAgo(String(m.created_at)) : ""
          const status = String(m.status ?? "")
          const statusIcon = status === "completed" ? dim("v") : status === "pending" || status === "assigned" ? highlight("...") : dim("x")
          const node = (m.node ?? {}) as Record<string, unknown>
          const to = node.name ? ` -> ${String(node.name)}` : ""

          console.log(`  ${statusIcon} ${dim(time.padEnd(12))} ${bold(sender)}${dim(to)}`)
          console.log(`    ${preview}`)
          console.log()
        }
      }
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// Helpers
// ============================================================================

function timeAgo(isoDate: string): string {
  try {
    const diff = Date.now() - new Date(isoDate).getTime()
    if (diff < 0) return "just now"
    const secs = Math.floor(diff / 1000)
    if (secs < 5) return "just now"
    if (secs < 60) return `${secs}s ago`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  } catch {
    return ""
  }
}

// ============================================================================
// Parent command: iris msg
// ============================================================================

export const PlatformMsgCommand = cmd({
  command: "msg",
  aliases: ["message"],
  describe: "send messages between Hive nodes",
  builder: (yargs) =>
    yargs
      .command(MsgSendCommand)
      .command(MsgNodesCommand)
      .command(MsgListCommand)
      .demandCommand(1, "Run iris msg --help for available subcommands"),
  handler() {},
})
