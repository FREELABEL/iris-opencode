import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import { execSync } from "child_process"
import { isAvailable, diagnoseAccess, query as queryMessages, normalizeHandle, getContactCards, queryMessagesWithBody, listGroupChats, getGroupParticipants, readGroupMessages, resolveGroupChat } from "../lib/imessage"
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
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    // Normalize phone number — strip everything except digits
    const digits = args.query.replace(/\D/g, "")
    let isPhone = digits.length >= 7
    let normalized = isPhone ? normalizeHandle(args.query) : args.query

    // If not a phone number, try to resolve as lead name → phone or email (#58890)
    let resolvedName: string | null = null
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
                resolvedName = withPhone.name || withPhone.nickname || null
                prompts.log.info(`Resolved "${args.query}" → ${resolvedName || "?"} (${withPhone.phone})`)
              }
            } else if (withEmail) {
              // iMessage can use email as Apple ID handle
              normalized = withEmail.email
              resolvedName = withEmail.name || withEmail.nickname || null
              prompts.log.info(`Resolved "${args.query}" → ${resolvedName || "?"} (${withEmail.email})`)
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
    try {
      const messages = queryMessagesWithBody(whereClause, cutoffSeconds, args.limit as number)
      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}" in the last ${args.days} days`)
        prompts.outro("Done")
        return
      }

      if (args.json) {
        console.log(JSON.stringify(messages, null, 2))
        prompts.outro("Done")
        return
      }

      // Use already-resolved name from lead lookup, or resolve from phone digits (#58888)
      const contactName = resolvedName ?? await resolveContactName(digits || String(args.query)) ?? "Them"

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
      prompts.log.error(diagnoseAccess())
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
    try {
      const messages = queryMessagesWithBody(whereClause, cutoffSeconds, args.last as number)
      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        prompts.outro("Done")
        return
      }

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
      prompts.log.error(diagnoseAccess())
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

    // Clean up stray backslash escapes from upstream (MCP/shell) then escape for AppleScript
    const cleanMessage = args.message.replace(/\\([^\\])/g, "$1")
    const escapedMessage = cleanMessage
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
      console.log(`  ${dim(cleanMessage.length > 100 ? cleanMessage.slice(0, 100) + "…" : cleanMessage)}`)
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
      prompts.log.error(diagnoseAccess())
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

const ImessageMentionsCommand = cmd({
  command: "mentions",
  aliases: ["@", "wakeword"],
  describe: "query @heyiris mentions from iMessage logs",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 30, describe: "look back N days" })
      .option("sender", { type: "string", describe: "filter by sender phone or name" })
      .option("lead", { type: "number", describe: "filter by lead ID" })
      .option("limit", { type: "number", default: 50, describe: "max mentions" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  @heyiris Mentions")

    const mentionsDir = `${require("os").homedir()}/.iris/mentions`
    const { existsSync, readdirSync, readFileSync } = require("fs")

    if (!existsSync(mentionsDir)) {
      prompts.log.error(`Mentions directory not found: ${mentionsDir}`)
      prompts.outro("Done")
      return
    }

    // Read all JSONL files within date range
    const cutoff = new Date(Date.now() - (args.days as number) * 86400 * 1000)
    const files = readdirSync(mentionsDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .sort()
      .filter((f: string) => {
        const dateStr = f.replace(".jsonl", "")
        return new Date(dateStr) >= cutoff
      })

    if (!files.length) {
      prompts.log.info(`No mention logs in the last ${args.days} days`)
      prompts.outro("Done")
      return
    }

    // Parse all mentions
    let mentions: any[] = []
    for (const file of files) {
      const lines = readFileSync(`${mentionsDir}/${file}`, "utf-8").split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          mentions.push(JSON.parse(line))
        } catch {}
      }
    }

    // Apply filters
    if (args.sender) {
      const s = String(args.sender).toLowerCase()
      mentions = mentions.filter((m: any) =>
        m.sender?.includes(s) || m.lead_name?.toLowerCase().includes(s)
      )
    }
    if (args.lead) {
      mentions = mentions.filter((m: any) => m.lead_id === args.lead)
    }

    // Sort newest first, apply limit
    mentions.sort((a: any, b: any) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    mentions = mentions.slice(0, args.limit as number)

    if (!mentions.length) {
      prompts.log.info("No mentions found matching filters")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(mentions, null, 2))
      prompts.outro("Done")
      return
    }

    // Group by sender for summary
    const bySender = new Map<string, number>()
    for (const m of mentions) {
      const key = m.lead_name || m.sender || "unknown"
      bySender.set(key, (bySender.get(key) || 0) + 1)
    }

    prompts.log.info(bold(`${mentions.length} mention${mentions.length === 1 ? "" : "s"} from ${bySender.size} sender${bySender.size === 1 ? "" : "s"}`))
    for (const [sender, count] of bySender) {
      console.log(`    ${dim(`${count}x`)} ${sender}`)
    }
    console.log()

    printDivider()
    for (const m of mentions) {
      const sender = m.lead_name ? bold(m.lead_name) : bold(m.sender || "?")
      const leadTag = m.lead_id ? dim(` #${m.lead_id}`) : ""
      const date = dim(new Date(m.ts).toLocaleString())
      const groupTag = m.is_group ? dim(" [group]") : ""
      console.log(`  ${date}  ${sender}${leadTag}${groupTag}`)
      console.log(`    ${m.text}`)
      console.log()
    }
    printDivider()
    prompts.outro(`${success("✓")} ${mentions.length} mention${mentions.length === 1 ? "" : "s"}`)
  },
})

const ImessageGroupsCommand = cmd({
  command: "groups",
  aliases: ["group-chats", "gc"],
  describe: "list group chats with names and participants",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 90, describe: "look back N days" })
      .option("limit", { type: "number", default: 30, describe: "max groups" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  iMessage Group Chats")

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    const groups = listGroupChats(args.days as number, args.limit as number)
    if (!groups.length) {
      prompts.log.info("No group chats found")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      // Enrich with participants for JSON output
      const enriched = groups.map(g => ({
        ...g,
        members: getGroupParticipants(g.guid),
      }))
      console.log(JSON.stringify(enriched, null, 2))
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const group of groups) {
      const name = bold(group.display_name || "(unnamed)")
      const meta = dim(`${group.participants} members · ${group.message_count} msgs · ${group.last_message}`)
      console.log(`  ${name}`)
      console.log(`    ${meta}`)
      console.log(`    ${dim(group.chat_identifier)}`)
      console.log()
    }
    printDivider()
    prompts.outro(`${success("✓")} ${groups.length} group chat${groups.length === 1 ? "" : "s"}\n  ${dim("iris imessage read-group <name-or-id>")}`)
  },
})

const ImessageReadGroupCommand = cmd({
  command: "read-group <query>",
  aliases: ["rg"],
  describe: "read messages from a group chat",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "group name or chat identifier" })
      .option("last", { type: "number", default: 20, describe: "number of recent messages" })
      .option("days", { type: "number", default: 30, describe: "search last N days" })
      .option("members", { type: "boolean", default: false, describe: "show participant list" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Group — "${args.query}"`)

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    // Resolve group by name or ID
    const group = resolveGroupChat(args.query)
    if (!group) {
      prompts.log.error(`No group chat matching "${args.query}"`)
      prompts.log.info(dim("Use: iris imessage groups — to list available group chats"))
      prompts.outro("Done")
      return
    }

    prompts.log.info(`${bold(group.display_name)} — ${group.participants} members, ${group.message_count} total msgs`)

    // Show members if requested
    if (args.members) {
      const members = getGroupParticipants(group.guid)
      const phoneMap = await resolveContactNames(members)
      prompts.log.info(bold("Members:"))
      for (const member of members) {
        const name = phoneMap.get(member)
        console.log(`    ${name ? `${bold(name)} ${dim(member)}` : dim(member)}`)
      }
      console.log()
    }

    const cutoffSeconds = (args.days as number) * 86400
    const messages = readGroupMessages(group.guid, cutoffSeconds, args.last as number)

    if (!messages.length) {
      prompts.log.info(`No messages in the last ${args.days} days`)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify({ group, messages }, null, 2))
      prompts.outro("Done")
      return
    }

    // Resolve sender names
    const senderHandles = [...new Set(messages.filter(m => !m.from_me && m.chat_identifier).map(m => m.chat_identifier!))]
    const nameMap = await resolveContactNames(senderHandles)

    const reversed = [...messages].reverse()
    printDivider()
    for (const msg of reversed) {
      const sender = msg.from_me
        ? bold("  You →")
        : bold(`← ${nameMap.get(msg.chat_identifier || "") || msg.chat_identifier || "?"}`)
      console.log(`  ${dim(msg.date)}  ${sender}  ${msg.text}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
  },
})

const ImessageSendGroupCommand = cmd({
  command: "send-group <query> <message>",
  aliases: ["sg"],
  describe: "send a message to a group chat",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "group name or chat identifier" })
      .positional("message", { type: "string", demandOption: true, describe: "message text to send" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Send Group — "${args.query}"`)

    if (process.platform !== "darwin") {
      prompts.log.error("iMessage is only available on macOS")
      prompts.outro("Done")
      return
    }

    // Resolve group
    const group = resolveGroupChat(args.query)
    if (!group) {
      prompts.log.error(`No group chat matching "${args.query}"`)
      prompts.log.info(dim("Use: iris imessage groups — to list available group chats"))
      prompts.outro("Done")
      return
    }

    prompts.log.info(`Sending to ${bold(group.display_name)} (${group.participants} members)`)

    const cleanMessage = args.message.replace(/\\([^\\])/g, "$1")
    const escapedMessage = cleanMessage
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')

    // AppleScript: send to group chat by guid
    const script = `
tell application "Messages"
    set targetChat to chat id "${group.guid}"
    send "${escapedMessage}" to targetChat
end tell`

    const sp = prompts.spinner()
    sp.start(`Sending to ${group.display_name}…`)

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        timeout: 15000,
      })
      sp.stop(success(`Sent to ${group.display_name}`))
      console.log(`  ${dim(cleanMessage.length > 100 ? cleanMessage.slice(0, 100) + "…" : cleanMessage)}`)
      prompts.outro("Done")
    } catch (err: any) {
      sp.stop("Failed", 1)
      prompts.log.error(`Send failed: ${err.message?.slice(0, 200)}`)
      prompts.outro("Done")
    }
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
      .command(ImessageMentionsCommand)
      .command(ImessageGroupsCommand)
      .command(ImessageReadGroupCommand)
      .command(ImessageSendGroupCommand)
      .demandCommand(),
  async handler() {},
})
