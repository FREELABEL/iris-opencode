import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import {
  getToken, listChannels, getMessages, searchMessages, listUsers,
  type SlackChannel,
} from "../lib/slack"

async function requireToken(): Promise<string | null> {
  const token = await getToken()
  if (!token) {
    prompts.log.error("No Slack connected. Run: iris channels connect slack")
  }
  return token
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch { return iso }
}

const SlackListCommand = cmd({
  command: "list",
  aliases: ["channels", "ls"],
  describe: "list Slack channels",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 50, describe: "max channels" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Slack Channels") }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Fetching channels...")

      const channels = await listChannels(token, args.limit as number)

      if (sp) sp.stop(`${channels.length} channel(s)`)

      if (!channels.length) {
        prompts.log.info("No channels found")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(channels, null, 2)); return }

      printDivider()
      for (const ch of channels) {
        const lock = ch.is_private ? "🔒" : "#"
        const members = dim(`${ch.num_members} members`)
        const topic = ch.topic ? dim(` — ${ch.topic.slice(0, 60)}`) : ""
        console.log(`  ${lock} ${bold(ch.name)}  ${members}${topic}`)
        console.log(`    ${dim(ch.id)}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${channels.length} channel${channels.length === 1 ? "" : "s"}\n  ${dim("iris slack read <channel-id-or-name>")}`)
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

const SlackReadCommand = cmd({
  command: "read <channel>",
  describe: "read recent messages from a Slack channel",
  builder: (yargs) =>
    yargs
      .positional("channel", { type: "string", demandOption: true, describe: "channel ID or name" })
      .option("limit", { type: "number", default: 20, describe: "number of messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Slack Read`) }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      // Resolve channel name to ID if needed
      let channelId = args.channel
      if (!channelId.startsWith("C") && !channelId.startsWith("D") && !channelId.startsWith("G")) {
        const channels = await listChannels(token, 500)
        const match = channels.find((ch: SlackChannel) => ch.name === channelId || ch.name === channelId.replace("#", ""))
        if (match) {
          channelId = match.id
          if (!args.json) prompts.log.info(`Resolved #${args.channel} → ${channelId}`)
        } else {
          prompts.log.error(`Channel "${args.channel}" not found. Run: iris slack list`)
          prompts.outro("Done")
          return
        }
      }

      const messages = await getMessages(token, channelId, args.limit as number)

      if (!messages.length) {
        prompts.log.info(`No messages in this channel`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(messages, null, 2)); return }

      // Display oldest first
      const reversed = [...messages].reverse()
      printDivider()
      for (const msg of reversed) {
        const time = formatTimestamp(msg.timestamp)
        const thread = msg.reply_count ? dim(` [${msg.reply_count} replies]`) : ""
        const text = msg.text.length > 200 ? msg.text.slice(0, 200) + "..." : msg.text
        console.log(`  ${dim(time)}  ${bold(msg.username)}${thread}  ${text}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

const SlackSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search Slack messages by keyword",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "search keyword" })
      .option("limit", { type: "number", default: 20, describe: "max results" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Slack Search — "${args.query}"`) }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Searching...")

      const messages = await searchMessages(token, args.query, args.limit as number)

      if (sp) sp.stop("Done")

      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        prompts.log.info(dim("Note: search requires the search:read OAuth scope"))
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(messages, null, 2)); return }

      printDivider()
      for (const msg of messages) {
        const time = formatTimestamp(msg.timestamp)
        console.log(`  ${dim(time)}  ${bold(msg.username)}`)
        console.log(`    ${msg.text.length > 200 ? msg.text.slice(0, 200) + "..." : msg.text}`)
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} result${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

const SlackUsersCommand = cmd({
  command: "users",
  aliases: ["members"],
  describe: "list Slack workspace members",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 100, describe: "max users" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Slack Users") }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const users = await listUsers(token, args.limit as number)

      if (!users.length) {
        prompts.log.info("No users found")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(users, null, 2)); return }

      printDivider()
      for (const u of users) {
        const role = u.is_admin ? ` ${success("admin")}` : ""
        const bot = u.is_bot ? dim(" [bot]") : ""
        console.log(`  ${bold(u.display_name || u.real_name)}${role}${bot}  ${dim(u.id)}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${users.length} user${users.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

export const PlatformSlackCommand = cmd({
  command: "slack",
  aliases: ["sl"],
  describe: "read Slack messages and channels (requires Slack OAuth connection)",
  builder: (yargs) =>
    yargs
      .command(SlackListCommand)
      .command(SlackReadCommand)
      .command(SlackSearchCommand)
      .command(SlackUsersCommand)
      .strict(false),
  async handler() {
    return SlackListCommand.handler({} as any)
  },
})
