import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import { execSync } from "child_process"
import { existsSync } from "fs"

// macOS iMessage integration — reads directly from ~/Library/Messages/chat.db (SQLite)
// No bridge dependency needed — just macOS + Full Disk Access permission

const MESSAGES_DB = `${process.env.HOME}/Library/Messages/chat.db`

function queryMessages(sql: string): string {
  return execSync(`sqlite3 "${MESSAGES_DB}" "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 10000,
  }).trim()
}

const ImessageSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search iMessages by phone number or contact name",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "phone number (last 10 digits) or chat identifier" })
      .option("days", { type: "number", default: 7, describe: "search last N days" })
      .option("limit", { type: "number", default: 20, describe: "max messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Search — "${args.query}"`)

    if (process.platform !== "darwin") {
      prompts.log.error("iMessage is only available on macOS")
      prompts.outro("Done")
      return
    }

    if (!existsSync(MESSAGES_DB)) {
      prompts.log.error(`Messages database not found at ${MESSAGES_DB}. Grant Full Disk Access in System Settings.`)
      prompts.outro("Done")
      return
    }

    // Normalize phone number — strip everything except digits
    const digits = args.query.replace(/\D/g, "")
    const isPhone = digits.length >= 7

    // Build WHERE clause — match chat_identifier by phone digits or name
    const whereClause = isPhone
      ? `c.chat_identifier LIKE '%${digits.slice(-10)}%'`
      : `c.chat_identifier LIKE '%${args.query.replace(/'/g, "''")}%'`

    const cutoffSeconds = args.days * 86400
    const sql = `
      SELECT
        m.rowid,
        datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as msg_date,
        m.is_from_me,
        REPLACE(REPLACE(m.text, char(10), ' '), char(13), ' ') as text
      FROM message m
      JOIN chat_message_join cmj ON m.rowid = cmj.message_id
      JOIN chat c ON cmj.chat_id = c.rowid
      WHERE ${whereClause}
        AND m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoffSeconds}
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.date DESC
      LIMIT ${args.limit};
    `.replace(/\n/g, " ").trim()

    try {
      const raw = queryMessages(sql)
      if (!raw) {
        prompts.log.info(`No messages matching "${args.query}" in the last ${args.days} days`)
        prompts.outro("Done")
        return
      }

      const messages = raw.split("\n").map((line) => {
        const [id, date, fromMe, ...textParts] = line.split("|")
        return { id, date, from_me: fromMe === "1", text: textParts.join("|") }
      })

      if (args.json) {
        console.log(JSON.stringify(messages, null, 2))
        prompts.outro("Done")
        return
      }

      // Display in chronological order (oldest first)
      const reversed = [...messages].reverse()
      printDivider()
      for (const msg of reversed) {
        const direction = msg.from_me ? bold("You →") : bold("← Them")
        const dateStr = dim(msg.date)
        console.log(`  ${dateStr}  ${direction}  ${msg.text}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      if (err.message?.includes("authorization") || err.message?.includes("not permitted")) {
        prompts.log.error("Permission denied. Grant Full Disk Access to your terminal in System Settings > Privacy > Full Disk Access.")
      } else {
        prompts.log.error(`Query failed: ${err.message?.slice(0, 200)}`)
      }
      prompts.outro("Done")
    }
  },
})

const ImessageReadCommand = cmd({
  command: "read <query>",
  describe: "read recent iMessages from a contact (full conversation)",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "phone number or chat identifier" })
      .option("last", { type: "number", default: 10, describe: "number of recent messages" })
      .option("days", { type: "number", default: 30, describe: "search last N days" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Read — "${args.query}"`)

    if (process.platform !== "darwin" || !existsSync(MESSAGES_DB)) {
      prompts.log.error("iMessage database not available")
      prompts.outro("Done")
      return
    }

    const digits = args.query.replace(/\D/g, "")
    const isPhone = digits.length >= 7
    const whereClause = isPhone
      ? `c.chat_identifier LIKE '%${digits.slice(-10)}%'`
      : `c.chat_identifier LIKE '%${args.query.replace(/'/g, "''")}%'`

    const cutoffSeconds = args.days * 86400
    const sql = `
      SELECT
        m.rowid,
        datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as msg_date,
        m.is_from_me,
        REPLACE(REPLACE(m.text, char(10), ' '), char(13), ' ') as text
      FROM message m
      JOIN chat_message_join cmj ON m.rowid = cmj.message_id
      JOIN chat c ON cmj.chat_id = c.rowid
      WHERE ${whereClause}
        AND m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoffSeconds}
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.date DESC
      LIMIT ${args.last};
    `.replace(/\n/g, " ").trim()

    try {
      const raw = queryMessages(sql)
      if (!raw) {
        prompts.log.info(`No messages matching "${args.query}"`)
        prompts.outro("Done")
        return
      }

      const messages = raw.split("\n").map((line) => {
        const [id, date, fromMe, ...textParts] = line.split("|")
        return { id, date, from_me: fromMe === "1", text: textParts.join("|") }
      })

      if (args.json) {
        console.log(JSON.stringify(messages, null, 2))
        prompts.outro("Done")
        return
      }

      const reversed = [...messages].reverse()
      printDivider()
      for (const msg of reversed) {
        const direction = msg.from_me ? bold("  You →") : bold("← Them")
        const dateStr = dim(msg.date)
        console.log(`  ${dateStr}  ${direction}  ${msg.text}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(`Query failed: ${err.message?.slice(0, 200)}`)
      prompts.outro("Done")
    }
  },
})

const ImessageChatsCommand = cmd({
  command: "chats",
  aliases: ["contacts", "ls"],
  describe: "list recent iMessage conversations",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 7, describe: "recent conversations in last N days" })
      .option("limit", { type: "number", default: 20, describe: "max conversations" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Recent iMessage Chats")

    if (process.platform !== "darwin" || !existsSync(MESSAGES_DB)) {
      prompts.log.error("iMessage database not available")
      prompts.outro("Done")
      return
    }

    const cutoffSeconds = args.days * 86400
    const sql = `
      SELECT
        c.chat_identifier,
        COUNT(m.rowid) as msg_count,
        MAX(datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime')) as last_msg
      FROM chat c
      JOIN chat_message_join cmj ON c.rowid = cmj.chat_id
      JOIN message m ON cmj.message_id = m.rowid
      WHERE m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoffSeconds}
      GROUP BY c.chat_identifier
      ORDER BY MAX(m.date) DESC
      LIMIT ${args.limit};
    `.replace(/\n/g, " ").trim()

    try {
      const raw = queryMessages(sql)
      if (!raw) {
        prompts.log.info("No recent conversations")
        prompts.outro("Done")
        return
      }

      const chats = raw.split("\n").map((line) => {
        const [identifier, count, lastMsg] = line.split("|")
        return { identifier, message_count: parseInt(count || "0"), last_message: lastMsg }
      })

      if (args.json) {
        console.log(JSON.stringify(chats, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const chat of chats) {
        console.log(`  ${bold(chat.identifier)}  ${dim(`${chat.message_count} msgs`)}  ${dim(chat.last_message)}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${chats.length} conversation${chats.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(`Query failed: ${err.message?.slice(0, 200)}`)
      prompts.outro("Done")
    }
  },
})

export const PlatformImessageCommand = cmd({
  command: "imessage",
  aliases: ["sms", "messages"],
  describe: "read iMessages from macOS Messages.app (requires Full Disk Access)",
  builder: (yargs) =>
    yargs
      .command(ImessageSearchCommand)
      .command(ImessageReadCommand)
      .command(ImessageChatsCommand)
      .demandCommand(),
  async handler() {},
})
