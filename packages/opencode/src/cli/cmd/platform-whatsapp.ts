import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import {
  isAvailable, diagnoseAccess,
  listChats, searchChats, readMessages, searchByPhone, searchByName,
  listGroups, getGroupMembers, resolveGroupChat,
  normalizePhone, extractPhone,
} from "../lib/whatsapp"

const WhatsappListCommand = cmd({
  command: "list",
  aliases: ["ls", "chats"],
  describe: "list recent WhatsApp conversations",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 30, describe: "recent conversations in last N days" })
      .option("limit", { type: "number", default: 50, describe: "max conversations" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  WhatsApp Conversations") }

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    const chats = listChats(args.days as number, args.limit as number)
    if (!chats.length) {
      prompts.log.info("No recent WhatsApp conversations")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(chats, null, 2))
      return
    }

    printDivider()
    for (const chat of chats) {
      const phone = extractPhone(chat.jid)
      const label = chat.name !== phone
        ? `${bold(chat.name)} ${dim(phone)}`
        : bold(phone)
      const unread = chat.unread_count > 0 ? ` ${success(`${chat.unread_count} new`)}` : ""
      console.log(`  ${label}  ${dim(`${chat.message_count} msgs`)}  ${dim(chat.last_message_date)}${unread}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${chats.length} conversation${chats.length === 1 ? "" : "s"}`)
  },
})

const WhatsappSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search WhatsApp conversations by phone number or contact name",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "phone number, contact name, or lead name" })
      .option("days", { type: "number", default: 90, describe: "search last N days" })
      .option("limit", { type: "number", default: 50, describe: "max messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  WhatsApp Search — "${args.query}"`) }

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    const digits = args.query.replace(/\D/g, "")
    let isPhone = digits.length >= 7

    // If not a phone number, try to resolve as lead name
    let resolvedPhone: string | null = null
    if (!isPhone) {
      try {
        const { irisFetch: _fetch } = await import("./iris-api")
        const leadRes = await _fetch(`/api/v1/leads?search=${encodeURIComponent(args.query)}&per_page=5`)
        if (leadRes.ok) {
          const leadData = (await leadRes.json()) as any
          const leads = leadData?.data?.data ?? leadData?.data ?? []
          if (Array.isArray(leads)) {
            const withPhone = leads.find((l: any) => l.phone)
            if (withPhone) {
              resolvedPhone = withPhone.phone
              const name = withPhone.name || withPhone.nickname || "?"
              if (!args.json) prompts.log.info(`Resolved "${args.query}" → ${name} (${withPhone.phone})`)
              isPhone = true
            }
          }
        }
      } catch {}
    }

    // Search messages — try name first (catches groups), then phone
    let messages = searchByName(args.query, args.days as number, args.limit as number)
    if (!messages.length && isPhone) {
      messages = searchByPhone(resolvedPhone || args.query, args.days as number, args.limit as number)
    }

    if (!messages.length) {
      // Fall back: show matching chats instead of messages
      const chats = searchChats(args.query, args.days as number, 10)
      if (chats.length) {
        if (args.json) { console.log(JSON.stringify(chats, null, 2)); return }
        prompts.log.info(`No messages, but found ${chats.length} matching chat(s):`)
        printDivider()
        for (const chat of chats) {
          console.log(`  ${bold(chat.name)} ${dim(extractPhone(chat.jid))}  ${dim(`pk:${chat.pk}`)}  ${dim(chat.last_message_date)}`)
        }
        printDivider()
        prompts.log.info(dim("Use: iris whatsapp read <pk> — to read messages"))
      } else {
        prompts.log.info(`No WhatsApp conversations matching "${args.query}"`)
      }
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(messages, null, 2))
      return
    }

    const reversed = [...messages].reverse()
    printDivider()
    for (const msg of reversed) {
      const direction = msg.from_me ? bold("  You →") : bold(`← ${msg.push_name || "Them"}`)
      console.log(`  ${dim(msg.date)}  ${direction}  ${msg.text}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
  },
})

const WhatsappReadCommand = cmd({
  command: "read <query>",
  describe: "read a WhatsApp conversation (by chat PK, phone, or name)",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "chat PK, phone number, or contact name" })
      .option("last", { type: "number", default: 20, describe: "number of recent messages" })
      .option("days", { type: "number", default: 30, describe: "search last N days" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  WhatsApp Read — "${args.query}"`) }

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    const digits = args.query.replace(/\D/g, "")
    const isPk = /^\d+$/.test(args.query.trim()) && digits.length < 5
    const isPhone = !isPk && digits.length >= 7

    let messages: any[] = []

    if (isPk) {
      messages = readMessages(parseInt(args.query, 10), args.days as number, args.last as number)
    } else if (isPhone) {
      messages = searchByPhone(args.query, args.days as number, args.last as number)
    } else {
      // Try lead resolution first
      try {
        const { irisFetch: _fetch } = await import("./iris-api")
        const isLeadId = /^\d+$/.test(args.query.trim()) && digits.length < 7
        if (isLeadId) {
          const res = await _fetch(`/api/v1/leads/${args.query.trim()}`)
          if (res.ok) {
            const data = (await res.json()) as any
            const lead = data?.data ?? data
            if (lead?.phone) {
              if (!args.json) prompts.log.info(`Resolved lead #${args.query} → ${lead.name || "?"} (${lead.phone})`)
              messages = searchByPhone(lead.phone, args.days as number, args.last as number)
            }
          }
        } else {
          const res = await _fetch(`/api/v1/leads?search=${encodeURIComponent(args.query)}&per_page=5`)
          if (res.ok) {
            const data = (await res.json()) as any
            const leads = data?.data?.data ?? data?.data ?? []
            const withPhone = Array.isArray(leads) ? leads.find((l: any) => l.phone) : null
            if (withPhone) {
              if (!args.json) prompts.log.info(`Resolved "${args.query}" → ${withPhone.name || "?"} (${withPhone.phone})`)
              messages = searchByPhone(withPhone.phone, args.days as number, args.last as number)
            }
          }
        }
      } catch {}

      // Fall back to name search in WhatsApp DB
      if (!messages.length) {
        messages = searchByName(args.query, args.days as number, args.last as number)
      }
    }

    if (!messages.length) {
      prompts.log.info(`No messages matching "${args.query}"`)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(messages, null, 2))
      return
    }

    const reversed = [...messages].reverse()
    printDivider()
    for (const msg of reversed) {
      const direction = msg.from_me ? bold("  You →") : bold(`← ${msg.push_name || "Them"}`)
      console.log(`  ${dim(msg.date)}  ${direction}  ${msg.text}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
  },
})

const WhatsappGroupsCommand = cmd({
  command: "groups",
  aliases: ["gc"],
  describe: "list WhatsApp group chats",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 90, describe: "look back N days" })
      .option("limit", { type: "number", default: 30, describe: "max groups" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  WhatsApp Group Chats") }

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    const groups = listGroups(args.days as number, args.limit as number)
    if (!groups.length) {
      prompts.log.info("No group chats found")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      const enriched = groups.map(g => ({
        ...g,
        members: getGroupMembers(g.pk),
      }))
      console.log(JSON.stringify(enriched, null, 2))
      return
    }

    printDivider()
    for (const group of groups) {
      console.log(`  ${bold(group.name)}`)
      console.log(`    ${dim(`${group.member_count} members · ${group.message_count} msgs · ${group.last_message_date}`)}`)
      console.log(`    ${dim(`pk:${group.pk}`)}`)
      console.log()
    }
    printDivider()
    prompts.outro(`${success("✓")} ${groups.length} group${groups.length === 1 ? "" : "s"}\n  ${dim("iris whatsapp read-group <name>")}`)
  },
})

const WhatsappReadGroupCommand = cmd({
  command: "read-group <query>",
  aliases: ["rg"],
  describe: "read messages from a WhatsApp group chat",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "group name or PK" })
      .option("last", { type: "number", default: 20, describe: "number of recent messages" })
      .option("days", { type: "number", default: 30, describe: "search last N days" })
      .option("members", { type: "boolean", default: false, describe: "show member list" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  WhatsApp Group — "${args.query}"`) }

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    // Resolve group by name or PK
    let groupPk: number | null = null
    let groupName = args.query

    const isPk = /^\d+$/.test(args.query.trim()) && args.query.trim().length < 5
    if (isPk) {
      groupPk = parseInt(args.query, 10)
      // Resolve group name from PK
      try {
        const nameResult = require("../lib/whatsapp").query(
          `SELECT ZPARTNERNAME FROM ZWACHATSESSION WHERE Z_PK = ${groupPk}`
        )
        if (nameResult) groupName = nameResult
      } catch {}
    } else {
      const group = resolveGroupChat(args.query)
      if (!group) {
        prompts.log.error(`No group chat matching "${args.query}"`)
        prompts.log.info(dim("Use: iris whatsapp groups — to list available groups"))
        prompts.outro("Done")
        return
      }
      groupPk = group.pk
      groupName = group.name
    }

    if (!args.json) prompts.log.info(bold(groupName))

    // Show members if requested
    if (args.members) {
      const members = getGroupMembers(groupPk)
      if (members.length) {
        prompts.log.info(bold("Members:"))
        for (const m of members) {
          const admin = m.is_admin ? ` ${success("admin")}` : ""
          console.log(`    ${m.name}${admin}`)
        }
        console.log()
      }
    }

    const messages = readMessages(groupPk, args.days as number, args.last as number)
    if (!messages.length) {
      prompts.log.info(`No messages in the last ${args.days} days`)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      const group = resolveGroupChat(args.query)
      console.log(JSON.stringify({ group, messages }, null, 2))
      return
    }

    // Build JID→name map from group members
    const members = getGroupMembers(groupPk)
    const nameMap = new Map<string, string>()
    for (const m of members) nameMap.set(m.jid, m.name)

    const reversed = [...messages].reverse()
    printDivider()
    for (const msg of reversed) {
      const senderName = nameMap.get(msg.from_jid) || extractPhone(msg.from_jid) || "?"
      const sender = msg.from_me
        ? bold("  You →")
        : bold(`← ${senderName}`)
      console.log(`  ${dim(msg.date)}  ${sender}  ${msg.text}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}`)
  },
})

export const PlatformWhatsappCommand = cmd({
  command: "whatsapp",
  aliases: ["wa"],
  describe: "read WhatsApp messages via local macOS database (requires Full Disk Access)",
  builder: (yargs) =>
    yargs
      .command(WhatsappListCommand)
      .command(WhatsappSearchCommand)
      .command(WhatsappReadCommand)
      .command(WhatsappGroupsCommand)
      .command(WhatsappReadGroupCommand)
      .strict(false),
  async handler() {
    // Default: show list
    return WhatsappListCommand.handler({} as any)
  },
})
