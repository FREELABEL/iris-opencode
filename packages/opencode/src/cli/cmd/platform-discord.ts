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

async function bridgeFetch(path: string, timeout = 10000): Promise<any> {
  const res = await fetch(`${BRIDGE_BASE}${path}`, {
    headers: bridgeHeaders(),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `HTTP ${res.status}`
    try {
      const err = JSON.parse(text) as any
      if (err?.error) message = err.error
    } catch {
      if (res.status === 404 && text.includes("Cannot GET")) {
        message = "Discord endpoints not available. Restart bridge: iris bridge restart"
      }
    }
    throw new Error(message)
  }
  return res.json()
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch {
    return iso
  }
}

const DiscordListCommand = cmd({
  command: "list",
  aliases: ["guilds", "servers"],
  describe: "list Discord servers the bot can see",
  builder: (yargs) =>
    yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Discord Servers") }

    try {
      const data = await bridgeFetch("/api/discord/guilds")
      const guilds = data?.guilds ?? []

      if (!guilds.length) {
        prompts.log.info("No Discord servers found. Is the bot connected?")
        prompts.log.info(dim("iris channels connect discord"))
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(guilds, null, 2)); return }

      printDivider()
      for (const g of guilds) {
        console.log(`  ${bold(g.name)}  ${dim(g.id)}`)
        console.log(`    ${dim(`${g.member_count} members · bot: ${g.bot_username}`)}`)
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${guilds.length} server${guilds.length === 1 ? "" : "s"}\n  ${dim("iris discord channels <guild-id>")}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else {
        prompts.log.error(err.message)
      }
      prompts.outro("Done")
    }
  },
})

const DiscordChannelsCommand = cmd({
  command: "channels <guild>",
  aliases: ["ch"],
  describe: "list text channels in a Discord server",
  builder: (yargs) =>
    yargs
      .positional("guild", { type: "string", demandOption: true, describe: "guild/server ID" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Discord Channels`) }

    try {
      const data = await bridgeFetch(`/api/discord/channels?guild_id=${encodeURIComponent(args.guild)}`)
      const channels = data?.channels ?? []
      const guildName = data?.guild?.name ?? args.guild

      if (!channels.length) {
        prompts.log.info(`No text channels found in ${guildName}`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      if (!args.json) prompts.log.info(bold(guildName))

      let lastCategory: string | null = null
      printDivider()
      for (const ch of channels) {
        if (ch.parent_name !== lastCategory) {
          if (lastCategory !== null) console.log()
          console.log(`  ${bold(ch.parent_name || "No Category")}`)
          lastCategory = ch.parent_name
        }
        console.log(`    # ${ch.name}  ${dim(ch.id)}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${channels.length} channel${channels.length === 1 ? "" : "s"}\n  ${dim("iris discord read <channel-id>")}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else {
        prompts.log.error(err.message)
      }
      prompts.outro("Done")
    }
  },
})

const DiscordReadCommand = cmd({
  command: "read <channel>",
  describe: "read recent messages from a Discord channel",
  builder: (yargs) =>
    yargs
      .positional("channel", { type: "string", demandOption: true, describe: "channel ID" })
      .option("limit", { type: "number", default: 20, describe: "number of messages" })
      .option("before", { type: "string", describe: "fetch messages before this message ID" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Discord Read`) }

    try {
      let url = `/api/discord/messages?channel_id=${encodeURIComponent(args.channel)}&limit=${args.limit}`
      if (args.before) url += `&before=${encodeURIComponent(args.before)}`

      const data = await bridgeFetch(url)
      const messages = data?.messages ?? []
      const channelName = data?.channel?.name ?? args.channel
      const guildName = data?.channel?.guild_id ? ` in ${data.channel.guild_id}` : ""

      if (!messages.length) {
        prompts.log.info(`No messages in #${channelName}`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      prompts.log.info(`#${bold(channelName)}${guildName ? dim(guildName) : ""}`)

      // Display oldest first
      const reversed = [...messages].reverse()
      printDivider()
      for (const msg of reversed) {
        const time = formatTimestamp(msg.timestamp)
        const author = msg.author.bot ? dim(msg.author.username) : bold(msg.author.username)
        const content = msg.content || dim("[no text content]")
        console.log(`  ${dim(time)}  ${author}  ${content.length > 200 ? content.slice(0, 200) + "..." : content}`)
        if (msg.attachments?.length) {
          for (const a of msg.attachments) {
            console.log(`    ${dim(`📎 ${a.name}`)}`)
          }
        }
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else {
        prompts.log.error(err.message)
      }
      prompts.outro("Done")
    }
  },
})

const DiscordSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search Discord messages by keyword",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "search keyword" })
      .option("channel", { type: "string", describe: "limit to a specific channel ID" })
      .option("guild", { type: "string", describe: "limit to a specific guild ID" })
      .option("limit", { type: "number", default: 20, describe: "max results" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Discord Search — "${args.query}"`) }

    try {
      let url = `/api/discord/search?q=${encodeURIComponent(args.query)}&limit=${args.limit}`
      if (args.channel) url += `&channel_id=${encodeURIComponent(args.channel)}`
      if (args.guild) url += `&guild_id=${encodeURIComponent(args.guild)}`

      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Searching messages...")

      const data = await bridgeFetch(url, 30000) // longer timeout for search
      const messages = data?.messages ?? []

      if (sp) sp.stop(`Scanned ${data?.total_scanned ?? 0} messages`)

      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      printDivider()
      for (const msg of messages) {
        const time = formatTimestamp(msg.timestamp)
        const where = msg.channel_name ? dim(`#${msg.channel_name}`) : ""
        console.log(`  ${dim(time)}  ${bold(msg.author.username)} ${where}`)
        console.log(`    ${msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content}`)
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} result${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("fetch failed")) {
        prompts.log.error("Bridge not running. Start with: iris bridge start")
      } else {
        prompts.log.error(err.message)
      }
      prompts.outro("Done")
    }
  },
})

export const PlatformDiscordCommand = cmd({
  command: "discord",
  aliases: ["dc"],
  describe: "read Discord messages via bridge bot (requires bridge + bot connected)",
  builder: (yargs) =>
    yargs
      .command(DiscordListCommand)
      .command(DiscordChannelsCommand)
      .command(DiscordReadCommand)
      .command(DiscordSearchCommand)
      .strict(false),
  async handler() {
    return DiscordListCommand.handler({} as any)
  },
})
