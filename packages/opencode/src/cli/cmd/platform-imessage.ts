import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import { execSync } from "child_process"
import { isAvailable, query as queryMessages, normalizeHandle, getContactCards } from "../lib/imessage"
import { resolveContactName, resolveContactNames } from "../lib/contacts"

const ImessageSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search iMessages by phone number or contact name",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "phone number (last 10 digits) or chat identifier" })
      .option("days", { type: "number", default: 30, describe: "search last N days" })
      .option("since", { type: "string", describe: "search from date (YYYY-MM-DD)" })
      .option("limit", { type: "number", default: 50, describe: "max messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Search — "${args.query}"`)

    if (!isAvailable()) {
      prompts.log.error("iMessage not available. Requires macOS + Full Disk Access in System Settings.")
      prompts.outro("Done")
      return
    }

    // Normalize phone number — strip everything except digits
    const digits = args.query.replace(/\D/g, "")
    let isPhone = digits.length >= 7
    let normalized = isPhone ? normalizeHandle(args.query) : args.query

    // If not a phone number, try to resolve as lead name → phone or email (#58890)
    if (!isPhone) {
      try {
        const { irisFetch: _fetch } = await import("./iris-api")
        const leadRes = await _fetch(`/api/v1/leads?search=${encodeURIComponent(args.query)}&per_page=5`)
        if (leadRes.ok) {
          const leadData = (await leadRes.json()) as any
          const leads = leadData?.data?.data ?? leadData?.data ?? []
          if (Array.isArray(leads)) {
            // Try phone first, then email as iMessage handle
            const withPhone = leads.find((l: any) => l.phone)
            const withEmail = leads.find((l: any) => l.email)
            if (withPhone) {
              const resolvedDigits = withPhone.phone.replace(/\D/g, "")
              if (resolvedDigits.length >= 7) {
                normalized = normalizeHandle(withPhone.phone)
                isPhone = true
                prompts.log.info(`Resolved "${args.query}" → ${withPhone.name || "?"} (${withPhone.phone})`)
              }
            } else if (withEmail) {
              // iMessage can use email as Apple ID handle
              normalized = withEmail.email
              prompts.log.info(`Resolved "${args.query}" → ${withEmail.name || "?"} (${withEmail.email})`)
            }
          }
        }
      } catch {}
    }

    // Build WHERE clause — match chat_identifier by phone digits or email
    const whereClause = isPhone
      ? `c.chat_identifier LIKE '%${normalized}%'`
      : `c.chat_identifier LIKE '%${args.query.replace(/'/g, "''")}%'`

    // --since takes priority over --days (#58884)
    const cutoffSeconds = args.since
      ? Math.max(0, Math.floor((Date.now() - new Date(String(args.since)).getTime()) / 1000))
      : (args.days as number) * 86400
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

      // Resolve contact name from leads (#58888)
      const contactName = await resolveContactName(digits || String(args.query)) ?? "Them"

      // Display in chronological order (oldest first)
      const reversed = [...messages].reverse()
      printDivider()
      for (const msg of reversed) {
        const direction = msg.from_me ? bold("You →") : bold(`← ${contactName}`)
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

    if (!isAvailable()) {
      prompts.log.error("iMessage not available. Requires macOS + Full Disk Access.")
      prompts.outro("Done")
      return
    }

    const digits = args.query.replace(/\D/g, "")
    const isPhone = digits.length >= 7
    const normalized = isPhone ? normalizeHandle(args.query) : args.query
    const whereClause = isPhone
      ? `c.chat_identifier LIKE '%${normalized}%'`
      : `c.chat_identifier LIKE '%${args.query.replace(/'/g, "''")}%'`

    // --since takes priority over --days (#58884)
    const cutoffSeconds = args.since
      ? Math.max(0, Math.floor((Date.now() - new Date(String(args.since)).getTime()) / 1000))
      : (args.days as number) * 86400
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
      .option("days", { type: "number", default: 30, describe: "recent conversations in last N days" })
      .option("since", { type: "string", describe: "from date (YYYY-MM-DD)" })
      .option("limit", { type: "number", default: 50, describe: "max conversations" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Recent iMessage Chats")

    if (!isAvailable()) {
      prompts.log.error("iMessage not available. Requires macOS + Full Disk Access.")
      prompts.outro("Done")
      return
    }

    // --since takes priority over --days (#58884)
    const cutoffSeconds = args.since
      ? Math.max(0, Math.floor((Date.now() - new Date(String(args.since)).getTime()) / 1000))
      : (args.days as number) * 86400
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

      // Resolve phone numbers → lead names in bulk (#58888)
      const phones = chats.filter(c => /^\+?\d{10,}$/.test(c.identifier.replace(/[^+\d]/g, "")))
      const phoneMap = await resolveContactNames(phones.map(c => c.identifier))

      printDivider()
      for (const chat of chats) {
        const name = phoneMap.get(chat.identifier)
        const label = name ? `${bold(name)} ${dim(chat.identifier)}` : bold(chat.identifier)
        console.log(`  ${label}  ${dim(`${chat.message_count} msgs`)}  ${dim(chat.last_message)}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${chats.length} conversation${chats.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(`Query failed: ${err.message?.slice(0, 200)}`)
      prompts.outro("Done")
    }
  },
})

const ImessageSendCommand = cmd({
  command: "send <handle> <message>",
  aliases: ["text", "msg"],
  describe: "send an iMessage to a phone number or contact",
  builder: (yargs) =>
    yargs
      .positional("handle", { type: "string", demandOption: true, describe: "phone number or Apple ID email" })
      .positional("message", { type: "string", demandOption: true, describe: "message text to send" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Send → ${args.handle}`)

    if (process.platform !== "darwin") {
      prompts.log.error("iMessage is only available on macOS")
      prompts.outro("Done")
      return
    }

    // Normalize phone — prepend +1 if 10 digits
    let handle = args.handle.trim()
    const digits = handle.replace(/\D/g, "")
    if (digits.length === 10) handle = `+1${digits}`
    else if (digits.length === 11 && digits.startsWith("1")) handle = `+${digits}`

    // Escape message for AppleScript — replace backslashes and double quotes
    const escapedMessage = args.message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')

    const script = `
tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set theBuddy to participant "${handle}" of targetService
    send "${escapedMessage}" to theBuddy
end tell`

    const sp = prompts.spinner()
    sp.start(`Sending to ${handle}…`)

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        timeout: 15000,
      })
      sp.stop(success(`Sent to ${handle}`))
      console.log(`  ${dim(args.message.length > 100 ? args.message.slice(0, 100) + "…" : args.message)}`)
      prompts.outro("Done")
    } catch (err: any) {
      sp.stop("Failed", 1)
      prompts.log.error(`Send failed: ${err.message?.slice(0, 200)}`)
      prompts.outro("Done")
    }
  },
})

const ImessageContactsCommand = cmd({
  command: "contacts",
  aliases: ["vcards", "cards"],
  describe: "list contact cards (vCards) shared via iMessage",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 90, describe: "look back N days" })
      .option("chat", { type: "string", describe: "filter by chat/phone number" })
      .option("limit", { type: "number", default: 20 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  iMessage Contact Cards")

    if (!isAvailable()) {
      prompts.log.error("iMessage not available. Requires macOS + Full Disk Access.")
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start("Scanning attachments…")

    const cards = getContactCards({
      days: args.days as number,
      limit: args.limit as number,
      chat: args.chat as string | undefined,
    })

    sp.stop(`${cards.length} contact card(s)`)

    if (args.json) {
      console.log(JSON.stringify(cards, null, 2))
      prompts.outro("Done")
      return
    }

    if (cards.length === 0) {
      prompts.log.info("No contact cards found in recent messages")
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const card of cards) {
      console.log(`  ${bold(card.full_name)}  ${dim(card.date)}`)
      if (card.phones.length > 0) console.log(`    ${dim("Phone:")} ${card.phones.join(", ")}`)
      if (card.emails.length > 0) console.log(`    ${dim("Email:")} ${card.emails.join(", ")}`)
      if (card.company) console.log(`    ${dim("Org:")}   ${card.company}`)
      console.log(`    ${dim("From:")}  ${card.sent_by}`)
      console.log()
    }
    printDivider()
    prompts.outro(dim("iris leads create --name \"...\" --phone \"...\" --email \"...\""))
  },
})

export const PlatformImessageCommand = cmd({
  command: "imessage",
  aliases: ["sms", "messages"],
  describe: "read and send iMessages via macOS Messages.app (requires Full Disk Access)",
  builder: (yargs) =>
    yargs
      .command(ImessageSearchCommand)
      .command(ImessageReadCommand)
      .command(ImessageChatsCommand)
      .command(ImessageSendCommand)
      .command(ImessageContactsCommand)
      .demandCommand(),
  async handler() {},
})
