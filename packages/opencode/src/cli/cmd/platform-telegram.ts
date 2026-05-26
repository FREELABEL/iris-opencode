import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success, getBridgeToken, BRIDGE_URL } from "./iris-api"

const BRIDGE_BASE = BRIDGE_URL

function bridgeHeaders(): Record<string, string> {
  const token = getBridgeToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers["X-Bridge-Key"] = token
  return headers
}

async function bridgeFetch(path: string, opts: RequestInit = {}, timeout = 10000): Promise<any> {
  const res = await fetch(`${BRIDGE_BASE}${path}`, {
    headers: { ...bridgeHeaders(), ...(opts.headers as Record<string, string> || {}) },
    signal: AbortSignal.timeout(timeout),
    ...opts,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `HTTP ${res.status}`
    try { const err = JSON.parse(text) as any; if (err?.error) message = err.error } catch {
      if (res.status === 404 && text.includes("Cannot")) message = "Telegram endpoints not available. Restart bridge: iris bridge restart"
    }
    throw new Error(message)
  }
  return res.json()
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch { return iso }
}

const TelegramChatsCommand = cmd({
  command: "chats",
  aliases: ["list", "ls"],
  describe: "list recent Telegram chats (from message cache)",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Telegram Chats") }

    try {
      const data = await bridgeFetch("/api/telegram/chats")
      const chats = data?.chats ?? []

      if (!chats.length) {
        prompts.log.info("No cached messages yet. Send a message to the bot first.")
        if (data.bot_username) prompts.log.info(dim(`Bot: @${data.bot_username}`))
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      if (data.bot_username) prompts.log.info(dim(`Bot: @${data.bot_username}`))
      printDivider()
      for (const ch of chats) {
        const type = ch.type === "private" ? "" : dim(` [${ch.type}]`)
        console.log(`  ${bold(ch.title)}${type}  ${dim(`${ch.message_count} msgs`)}  ${dim(formatTimestamp(ch.last_date))}`)
        console.log(`    ${dim(`id:${ch.id}`)}  ${dim(ch.last_message.slice(0, 80))}`)
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${chats.length} chat${chats.length === 1 ? "" : "s"}\n  ${dim("iris telegram read <chat-id>")}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else { prompts.log.error(err.message) }
      prompts.outro("Done")
    }
  },
})

const TelegramReadCommand = cmd({
  command: "read <chat>",
  describe: "read cached messages from a Telegram chat",
  builder: (yargs) =>
    yargs
      .positional("chat", { type: "string", demandOption: true, describe: "chat ID" })
      .option("limit", { type: "number", default: 20, describe: "number of messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Telegram Read`) }

    try {
      const data = await bridgeFetch(`/api/telegram/messages?chat_id=${encodeURIComponent(args.chat)}&limit=${args.limit}`)
      const messages = data?.messages ?? []

      if (!messages.length) {
        prompts.log.info("No cached messages for this chat. Messages are cached as they arrive — send the bot a message first.")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      printDivider()
      for (const msg of messages) {
        const sender = msg.from?.is_bot ? dim(msg.from.username || "bot") : bold(msg.from?.first_name || msg.from?.username || "?")
        console.log(`  ${dim(formatTimestamp(msg.timestamp))}  ${sender}  ${msg.text}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else { prompts.log.error(err.message) }
      prompts.outro("Done")
    }
  },
})

const TelegramSendCommand = cmd({
  command: "send <chat> <message>",
  aliases: ["msg"],
  describe: "send a message via the Telegram bot",
  builder: (yargs) =>
    yargs
      .positional("chat", { type: "string", demandOption: true, describe: "chat ID" })
      .positional("message", { type: "string", demandOption: true, describe: "message text" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Telegram Send → ${args.chat}`)

    try {
      const data = await bridgeFetch("/api/telegram/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: args.chat, text: args.message }),
      })

      if (data.ok) {
        prompts.log.success(`Sent (message_id: ${data.message_id})`)
      } else {
        prompts.log.error("Send failed")
      }
    } catch (err: any) {
      prompts.log.error(err.message)
    }
    prompts.outro("Done")
  },
})

const TelegramInfoCommand = cmd({
  command: "info",
  aliases: ["status"],
  describe: "show Telegram bot connection status",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Telegram Info") }

    try {
      const data = await bridgeFetch("/api/telegram/info")

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      if (data.connected) {
        console.log(`  ${success("● connected")}  @${bold(data.username)}`)
        console.log(`  ${dim(`${data.cached_chats} chats cached, ${data.cached_messages} messages`)}`)
      } else {
        console.log(`  ${dim("○ not connected")}`)
        console.log(`  ${dim("Connect: iris channels connect telegram")}`)
      }
    } catch (err: any) {
      prompts.log.error(err.message)
    }
    prompts.outro("Done")
  },
})

export const PlatformTelegramCommand = cmd({
  command: "telegram",
  aliases: ["tg"],
  describe: "read Telegram messages via bridge bot (cached as they arrive)",
  builder: (yargs) =>
    yargs
      .command(TelegramChatsCommand)
      .command(TelegramReadCommand)
      .command(TelegramSendCommand)
      .command(TelegramInfoCommand)
      .strict(false),
  async handler() {
    return TelegramInfoCommand.handler({} as any)
  },
})
