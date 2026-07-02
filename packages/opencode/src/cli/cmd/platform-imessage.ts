import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import { execSync, execFileSync } from "child_process"
import { isAvailable, diagnoseAccess, query as queryMessages, normalizeHandle, getContactCards, queryMessagesWithBody, listGroupChats, getGroupParticipants, readGroupMessages, resolveGroupChat, searchByHandle, isSelfAlias, resolveSelfHandle, readSelfConfig, writeSelfConfig, clearSelfConfig, detectSelfHandle } from "../lib/imessage"
import { resolveContactName, resolveContactNames, resolveHandleByName } from "../lib/contacts"

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
    if (!args.json) { UI.empty(); prompts.intro(`◈  iMessage Search — "${args.query}"`) }

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
    // First check local Contacts so personal contacts (not CRM leads) work by name.
    if (!isPhone) {
      const c = resolveHandleByName(args.query)
      if (c) {
        if (c.handle.includes("@")) {
          normalized = c.handle
        } else {
          normalized = normalizeHandle(c.handle)
          isPhone = true
        }
        resolvedName = c.name
        prompts.log.info(`Resolved "${args.query}" → ${c.name} (${c.handle})`)
      }
    }
    if (!isPhone && !resolvedName) {
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

    // Build WHERE clause — match chat_identifier by phone digits or email.
    // Use `normalized` (the resolved handle) for phones OR any resolved email;
    // only fall back to the raw query when nothing resolved.
    const matchTerm = isPhone || resolvedName ? normalized : args.query
    const whereClause = `c.chat_identifier LIKE '%${matchTerm.replace(/'/g, "''")}%'`

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
    if (!args.json) { UI.empty(); prompts.intro(`◈  iMessage Read — "${args.query}"`) }

    if (!isAvailable()) {
      prompts.log.error(diagnoseAccess())
      prompts.outro("Done")
      return
    }

    if (!args.query?.trim()) {
      prompts.log.error("Please provide a phone number, lead ID, or contact name")
      prompts.outro("Done")
      return
    }

    let digits = args.query.replace(/\D/g, "")
    let isPhone = digits.length >= 7
    let normalized = isPhone ? normalizeHandle(args.query) : args.query

    // If not a phone number, try to resolve as lead ID or name
    const isLeadId = /^\d+$/.test(args.query.trim()) && digits.length < 7
    // Local Contacts first so personal contacts resolve by name (not just leads).
    let readResolvedName: string | null = null
    if (!isPhone && !isLeadId) {
      const c = resolveHandleByName(args.query)
      if (c) {
        readResolvedName = c.name
        if (c.handle.includes("@")) {
          normalized = c.handle
        } else {
          normalized = normalizeHandle(c.handle)
          isPhone = true
        }
        if (!args.json) prompts.log.info(`Resolved "${args.query}" → ${c.name} (${c.handle})`)
      }
    }
    if ((isLeadId || !isPhone) && !readResolvedName) {
      try {
        const { irisFetch: _fetch } = await import("./iris-api")
        if (isLeadId) {
          const res = await _fetch(`/api/v1/leads/${args.query.trim()}`)
          if (res.ok) {
            const data = (await res.json()) as any
            const lead = data?.data ?? data
            if (lead?.phone) {
              const name = lead.name || lead.nickname || `Lead #${args.query}`
              if (!args.json) prompts.log.info(`Resolved lead #${args.query} → ${name} (${lead.phone})`)
              normalized = normalizeHandle(lead.phone)
              isPhone = true
            }
          }
        } else {
          const res = await _fetch(`/api/v1/leads?search=${encodeURIComponent(args.query)}&per_page=5`)
          if (res.ok) {
            const data = (await res.json()) as any
            const leads = data?.data?.data ?? data?.data ?? []
            const withPhone = Array.isArray(leads) ? leads.find((l: any) => l.phone) : null
            if (withPhone) {
              const name = withPhone.name || withPhone.nickname || args.query
              if (!args.json) prompts.log.info(`Resolved "${args.query}" → ${name} (${withPhone.phone})`)
              normalized = normalizeHandle(withPhone.phone)
              isPhone = true
            }
          }
        }
      } catch {}
    }

    const matchTerm = isPhone || readResolvedName ? normalized : args.query
    const whereClause = `c.chat_identifier LIKE '%${matchTerm.replace(/'/g, "''")}%'`

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
        return
      }

      // Prefer a resolved contact name; otherwise resolve from the handle.
      const them = readResolvedName ?? (isPhone ? await resolveContactName(normalized) : null) ?? "Them"
      const reversed = [...messages].reverse()
      printDivider()
      for (const msg of reversed) {
        const direction = msg.from_me ? bold("  You →") : bold(`← ${them}`)
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

      // Resolve handles → contact names in bulk (Contacts first, then CRM) (#58888).
      // Done before the JSON branch so programmatic consumers (MCP) get names too.
      const phones = chats.filter(c => /^\+?\d{10,}$/.test(c.identifier.replace(/[^+\d]/g, "")) || c.identifier.includes("@"))
      const phoneMap = await resolveContactNames(phones.map(c => c.identifier))

      if (args.json) {
        console.log(JSON.stringify(chats.map(c => ({ ...c, name: phoneMap.get(c.identifier) ?? null })), null, 2))
        return
      }

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
      .positional("handle", { type: "string", demandOption: true, describe: "phone number, lead ID, contact name, or 'me'/'self'" })
      .positional("message", { type: "string", demandOption: true, describe: "message text to send" })
      .option("phone", { type: "boolean", default: false, describe: "for 'me'/'self', target your phone (SMS) instead of your iMessage email" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iMessage Send → ${args.handle}`)

    if (process.platform !== "darwin") {
      prompts.log.error("iMessage is only available on macOS")
      prompts.outro("Done")
      return
    }

    // Resolve handle: could be phone, lead ID, contact name, or "me"/"self"
    let handle = args.handle.trim()

    // "me" / "self" → the user's own handle (env → ~/.iris/imessage-self.json → chat.db auto-detect)
    if (isSelfAlias(handle)) {
      const self = resolveSelfHandle(args.phone ? "phone" : "email")
      if (!self) {
        prompts.log.error(
          "Couldn't resolve your own handle. Set it with:\n" +
            "  iris imessage me --set-email you@icloud.com\n" +
            "  iris imessage me --set-phone +15551234567",
        )
        prompts.outro("Done")
        return
      }
      prompts.log.info(`Resolved "${args.handle}" → you (${self})`)
      handle = self
    }

    const digits = handle.replace(/\D/g, "")

    // Check if it's a lead ID (pure number, < 7 digits — not a phone)
    const isLeadId = /^\d+$/.test(handle) && digits.length < 7
    const isPhone = !isLeadId && digits.length >= 7

    // Local Contacts first — text a personal contact by name (not just leads).
    let sendResolved = false
    if (!isLeadId && !isPhone && !handle.includes("@")) {
      const c = resolveHandleByName(handle)
      if (c) {
        handle = c.handle
        sendResolved = true
        prompts.log.info(`Resolved "${args.handle}" → ${c.name} (${c.handle})`)
      }
    }

    if (!sendResolved && (isLeadId || (!isPhone && !handle.includes("@")))) {
      // Resolve from CRM
      try {
        const { irisFetch: _fetch } = await import("./iris-api")
        if (isLeadId) {
          const res = await _fetch(`/api/v1/leads/${handle}`)
          if (res.ok) {
            const data = (await res.json()) as any
            const lead = data?.data ?? data
            if (lead?.phone) {
              const name = lead.name || lead.nickname || `Lead #${handle}`
              prompts.log.info(`Resolved lead #${handle} → ${name} (${lead.phone})`)
              handle = lead.phone
            } else {
              prompts.log.error(`Lead #${handle} has no phone number`)
              prompts.outro("Done")
              return
            }
          } else {
            prompts.log.error(`Lead #${handle} not found`)
            prompts.outro("Done")
            return
          }
        } else {
          // Search by name
          const res = await _fetch(`/api/v1/leads?search=${encodeURIComponent(handle)}&per_page=5`)
          if (res.ok) {
            const data = (await res.json()) as any
            const leads = data?.data?.data ?? data?.data ?? []
            const withPhone = Array.isArray(leads) ? leads.find((l: any) => l.phone) : null
            if (withPhone) {
              const name = withPhone.name || withPhone.nickname || handle
              prompts.log.info(`Resolved "${handle}" → ${name} (${withPhone.phone})`)
              handle = withPhone.phone
            } else {
              prompts.log.error(`No lead with phone found for "${handle}"`)
              prompts.outro("Done")
              return
            }
          }
        }
      } catch {}
    }

    // Normalize phone — prepend +1 if 10 digits
    const finalDigits = handle.replace(/\D/g, "")
    if (finalDigits.length === 10) handle = `+1${finalDigits}`
    else if (finalDigits.length === 11 && finalDigits.startsWith("1")) handle = `+${finalDigits}`

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

// ─────────────────────────────────────────────────────────────────────────────
// @heyiris Mention Responder — research unprocessed mentions with Claude, draft
// client replies, queue for human approval, send on approve. Subcommands of
// `iris imessage mentions`. State: ~/.iris/mention-responder/{processed.json,queue.jsonl}
// ─────────────────────────────────────────────────────────────────────────────
const MR_DIR = `${require("os").homedir()}/.iris/mention-responder`
const MR_PROCESSED = `${MR_DIR}/processed.json`
const MR_QUEUE = `${MR_DIR}/queue.jsonl`
const MR_MENTIONS = `${require("os").homedir()}/.iris/mentions`
const MR_REPO = process.env.FREELABEL_REPO || `${require("os").homedir()}/Sites/freelabel`

function mrEnsure() { require("fs").mkdirSync(MR_DIR, { recursive: true }) }
function mrKey(m: any): string {
  return require("crypto").createHash("sha1").update(`${m.ts}|${m.sender}|${m.text || ""}`).digest("hex").slice(0, 12)
}
function mrProcessed(): Set<string> {
  try { return new Set(JSON.parse(require("fs").readFileSync(MR_PROCESSED, "utf-8"))) } catch { return new Set() }
}
function mrSaveProcessed(s: Set<string>) { mrEnsure(); require("fs").writeFileSync(MR_PROCESSED, JSON.stringify([...s])) }
function mrLoadQueue(): any[] {
  try {
    return require("fs").readFileSync(MR_QUEUE, "utf-8").split("\n").filter(Boolean)
      .map((l: string) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function mrRewrite(rows: any[]) { mrEnsure(); require("fs").writeFileSync(MR_QUEUE, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")) }
function mrAppend(row: any) { mrEnsure(); require("fs").appendFileSync(MR_QUEUE, JSON.stringify(row) + "\n") }

function mrReadMentions(days: number, client?: string, includeSelf = false): any[] {
  const { existsSync, readdirSync, readFileSync } = require("fs")
  if (!existsSync(MR_MENTIONS)) return []
  const cutoff = new Date(Date.now() - days * 86400 * 1000)
  const files = readdirSync(MR_MENTIONS).filter((f: string) => f.endsWith(".jsonl")).sort()
    .filter((f: string) => new Date(f.replace(".jsonl", "")) >= cutoff)
  const out: any[] = []
  for (const f of files) {
    for (const line of readFileSync(`${MR_MENTIONS}/${f}`, "utf-8").split("\n").filter(Boolean)) {
      try {
        const m = JSON.parse(line)
        if (!m.text || !m.text.trim()) continue
        if (!includeSelf && m.is_from_me) continue
        if (client && !`${m.lead_name || ""} ${m.sender || ""}`.toLowerCase().includes(client.toLowerCase())) continue
        out.push(m)
      } catch {}
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1))
}

// Pull recent conversation around a mention so Claude knows WHICH project the
// client is talking about (the single message line rarely names it). Returns a
// chronological transcript, newest last, with our short canned acks filtered out.
function mrThreadContext(m: any): string {
  if (!m.sender) return ""
  let msgs: any[] = []
  try { msgs = searchByHandle(m.sender, 7, 16) } catch { return "" }
  const name = m.lead_name || "Client"
  const lines: string[] = []
  for (const x of msgs.slice().reverse()) {
    const t = (x.text || "").replace(/\s+/g, " ").trim()
    if (!t) continue
    if (x.from_me && t.length < 40) continue // drop our emoji ack noise ("🫡 Logged…")
    lines.push(`${x.from_me ? "IRIS/team" : name}: ${t.slice(0, 220)}`)
  }
  return lines.slice(-14).join("\n")
}

// Run Claude headless inside the freelabel repo (read-only tools) to triage +
// investigate one mention, returning { category, severity, summary,
// internal_findings, client_reply, needs_human } or { error }.
function mrResearch(m: any): any {
  const thread = mrThreadContext(m)
  const contextBlock = thread
    ? `RECENT CONVERSATION (chronological, most recent last — use this to determine WHICH project/site/app the client means):
"""
${thread}
"""

`
    : ""

  // Image attachments (screenshots) the client sent with the mention. Claude is
  // vision-capable via the Read tool, so list readable image paths and tell it
  // to look — a screenshot often names the project better than any words.
  const { existsSync } = require("fs")
  const images = (m.attachments || [])
    .filter((a: any) => a && a.path && (a.mimeType || "").startsWith("image/") && existsSync(a.path))
  const imageBlock = images.length
    ? `ATTACHED SCREENSHOT${images.length > 1 ? "S" : ""} (${images.length}) — READ each with the Read tool BEFORE answering; they usually show exactly what the client means and which screen/project it is:
${images.map((a: any) => `- ${a.path}`).join("\n")}

`
    : ""
  const prompt = `You are IRIS, the AI operator for the Freelabel / HeyIRIS platform, triaging a client message that @mentioned you over iMessage. You are running inside the freelabel monorepo at ${MR_REPO} and may read/grep the codebase to investigate before answering.

CLIENT: ${m.lead_name || "Unknown"} (${m.sender})
SENT: ${m.ts}

${contextBlock}${imageBlock}THE MESSAGE TO ACT ON:
"""
${m.text}
"""

CRITICAL — identify the right project first: a single message rarely names its project. Infer the active project from the RECENT CONVERSATION above (e.g. a "pathways-*" link or words like "patient portal" / "case progress" mean the Pathways project — NOT a similarly-named repo like Saddle Pass). Do not pattern-match a stray word to the wrong codebase. If the project is still genuinely ambiguous after reading the context, set needs_human=true and ask which project in client_reply rather than guessing.

Steps:
1. Classify. category = bug | feature_request | question | task | status_check | other. severity = low | medium | high. Write a one-line summary.
2. Scope to the project identified from context, then investigate (read code, grep, check page JSON) and write concise internal_findings: the right files, root cause, and what it'd take. State which project you concluded and why.
3. Draft client_reply: warm, concise, FIRST PERSON as IRIS, NO markdown, <= 600 chars, address the client by first name. If it's a real bug: acknowledge + what you found + the next step / rough ETA. If it needs a human decision, or you are not confident, set needs_human=true and make client_reply a brief honest holding response (don't fabricate a fix).

Return ONLY a single JSON object, no prose, no code fences:
{"category":"","severity":"","summary":"","internal_findings":"","client_reply":"","needs_human":false}`

  const cargs = ["-p", prompt, "--output-format", "json", "--allowedTools", "Read,Grep,Glob", "--max-turns", process.env.CLAUDE_MAX_TURNS || "15"]
  if (process.env.CLAUDE_MODEL) cargs.push("--model", process.env.CLAUDE_MODEL)
  let raw: string
  try {
    raw = execFileSync("claude", cargs, { cwd: MR_REPO, encoding: "utf-8", timeout: 300000, maxBuffer: 20 * 1024 * 1024 })
  } catch (e: any) {
    return { error: `claude failed: ${(e.stderr || e.message || "").toString().slice(0, 300)}` }
  }
  let text = raw
  try { const env = JSON.parse(raw); if (env && typeof env.result === "string") text = env.result } catch {}
  const s = text.indexOf("{"), e = text.lastIndexOf("}")
  if (s === -1 || e === -1) return { error: "no JSON in claude output" }
  try {
    const o = JSON.parse(text.slice(s, e + 1))
    return {
      category: o.category || "other", severity: o.severity || "low", summary: o.summary || "",
      internal_findings: o.internal_findings || "", client_reply: (o.client_reply || "").trim(),
      needs_human: o.needs_human !== false,
    }
  } catch (err: any) { return { error: `parse failed: ${err.message}` } }
}

// Send an iMessage via AppleScript (same path as `iris imessage send`).
function mrSend(handle: string, text: string): void {
  let h = handle.trim()
  const d = h.replace(/\D/g, "")
  if (d.length === 10) h = `+1${d}`
  else if (d.length === 11 && d.startsWith("1")) h = `+${d}`
  const clean = text.replace(/\\([^\\])/g, "$1")
  const esc = clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const script = `
tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set theBuddy to participant "${h}" of targetService
    send "${esc}" to theBuddy
end tell`
  execFileSync("osascript", ["-e", script], { encoding: "utf-8", timeout: 15000 })
}

const MentionsRespondCommand = cmd({
  command: "respond",
  aliases: ["sweep", "draft"],
  describe: "research unprocessed @heyiris mentions with Claude and draft client replies (queued for approval)",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 5, describe: "max mentions to process this run" })
      .option("days", { type: "number", default: 30, describe: "look back N days" })
      .option("client", { type: "string", describe: "only mentions from this sender phone or name" })
      .option("dry-run", { type: "boolean", default: false, describe: "preview what would be processed (no Claude, no queue)" })
      .option("include-self", { type: "boolean", default: false, describe: "include your own @heyiris messages" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mention Respond")
    const processed = mrProcessed()
    const pending = mrReadMentions(args.days as number, args.client as string, args["include-self"] as boolean)
      .filter((m) => !processed.has(mrKey(m)))

    if (!pending.length) { prompts.log.info("No unprocessed mentions in range"); prompts.outro("Done"); return }

    if (args["dry-run"]) {
      prompts.log.info(bold(`${pending.length} unprocessed — would process up to ${args.limit}`))
      printDivider()
      pending.slice(0, args.limit as number).forEach((m, i) =>
        console.log(`  ${dim(String(i + 1).padStart(2))}. ${bold(m.lead_name || m.sender)} ${dim(m.ts.slice(0, 16))}\n      ${(m.text || "").replace(/\n+/g, " ").slice(0, 100)}`))
      printDivider()
      prompts.outro(dim("dry-run — nothing researched or queued"))
      return
    }

    const slice = pending.slice(0, args.limit as number)
    // mrResearch runs `claude` SYNCHRONOUSLY (up to 5 min each), which blocks the event
    // loop and freezes any spinner — making the command look hung (#137259). Print an
    // explicit status line BEFORE each blocking call and the elapsed time after, so the
    // user always sees forward progress and never assumes it's frozen.
    prompts.log.info(`Researching ${slice.length} mention${slice.length === 1 ? "" : "s"} with Claude — each can take 1-5 min (it reads/greps the repo). Progress prints per mention:`)
    let done = 0
    for (let i = 0; i < slice.length; i++) {
      const m = slice[i]
      const id = mrKey(m)
      const label = `${m.lead_name || m.sender} ${dim(m.ts.slice(0, 16))}`
      process.stdout.write(`  ${dim(`[${i + 1}/${slice.length}]`)} researching ${label} … `)
      const t0 = Date.now()
      const r = mrResearch(m)
      const secs = Math.round((Date.now() - t0) / 1000)
      if (r.error) { console.log(`${dim(`(${secs}s)`)} ✗ ${r.error}`); continue }
      mrAppend({
        id, status: "pending", created: new Date().toISOString(),
        sender: m.sender, lead_id: m.lead_id, lead_name: m.lead_name, chat: m.chat, message: m.text,
        category: r.category, severity: r.severity, summary: r.summary,
        internal_findings: r.internal_findings, draft_reply: r.client_reply, needs_human: r.needs_human,
      })
      processed.add(id); mrSaveProcessed(processed)
      console.log(`${dim(`(${secs}s)`)} ${success("✓")} ${dim(`[${r.category}/${r.severity}]`)} ${r.needs_human ? "⚑ needs-human" : "auto-ok"} ${dim(id)}`)
      done++
    }
    prompts.outro(`${success("✓")} Queued ${done} draft${done === 1 ? "" : "s"} — review: ${bold("iris imessage mentions drafts")}`)
  },
})

const MentionsDraftsCommand = cmd({
  command: "drafts",
  aliases: ["review", "queue"],
  describe: "list drafted replies awaiting approval",
  builder: (yargs) =>
    yargs
      .option("all", { type: "boolean", default: false, describe: "include sent/rejected" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const rows = mrLoadQueue().filter((r) => args.all || r.status === "pending")
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); return }
    UI.empty(); prompts.intro("◈  Mention Drafts")
    if (!rows.length) { prompts.log.info(args.all ? "Queue is empty" : "No pending drafts (use --all)"); prompts.outro("Done"); return }
    printDivider()
    for (const r of rows) {
      const st = r.status === "pending" ? r.status.toUpperCase() : r.status === "sent" ? success("SENT") : dim(r.status.toUpperCase())
      console.log(`  ${bold(r.id)}  ${st}  ${bold(r.lead_name || r.sender)}  ${dim(`[${r.category}/${r.severity}]`)}${r.needs_human ? " ⚑human" : ""}`)
      console.log(`    ${dim("msg:")}   ${(r.message || "").replace(/\n+/g, " ").slice(0, 88)}`)
      console.log(`    ${dim("reply:")} ${(r.draft_reply || "").replace(/\n+/g, " ").slice(0, 100)}`)
      console.log()
    }
    printDivider()
    prompts.outro(dim("show <id> · approve <id|all> · reject <id>"))
  },
})

const MentionsShowCommand = cmd({
  command: "show <id>",
  describe: "show a draft's full message, findings, and reply",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    const r = mrLoadQueue().find((x) => x.id === args.id)
    if (!r) { UI.empty(); prompts.log.error(`No draft ${args.id}`); return }
    UI.empty(); prompts.intro(`◈  Draft ${r.id}`)
    console.log(`  ${bold("client")}   ${r.lead_name || ""} (${r.sender})  lead #${r.lead_id || "—"}`)
    console.log(`  ${bold("status")}   ${r.status}`)
    console.log(`  ${bold("class")}    ${r.category} / ${r.severity}${r.needs_human ? "  ⚑ needs human" : ""}`)
    console.log(`  ${bold("summary")}  ${r.summary}`)
    console.log(`\n  ${dim("— message —")}\n  ${(r.message || "").replace(/\n/g, "\n  ")}`)
    console.log(`\n  ${dim("— internal findings —")}\n  ${(r.internal_findings || "").replace(/\n/g, "\n  ")}`)
    console.log(`\n  ${dim("— draft reply —")}\n  ${success((r.draft_reply || "").replace(/\n/g, "\n  "))}`)
    prompts.outro(dim(`approve ${r.id} · reject ${r.id}`))
  },
})

const MentionsApproveCommand = cmd({
  command: "approve <id>",
  describe: "send a drafted reply to the client (id, or 'all' for pending non-needs-human)",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    if (process.platform !== "darwin") { prompts.log.error("iMessage send requires macOS"); return }
    const rows = mrLoadQueue()
    const targets = args.id === "all"
      ? rows.filter((r) => r.status === "pending" && !r.needs_human)
      : rows.filter((r) => r.id === args.id)
    UI.empty(); prompts.intro("◈  Mention Approve")
    if (!targets.length) {
      prompts.log.warn(args.id === "all" ? "Nothing auto-approvable (needs-human drafts must be approved by id)" : `No draft ${args.id}`)
      prompts.outro("Done"); return
    }
    for (const r of targets) {
      if (r.status === "sent") { prompts.log.info(`${r.id} already sent`); continue }
      try {
        mrSend(r.sender, r.draft_reply)
        r.status = "sent"; r.sent_at = new Date().toISOString()
        prompts.log.success(`Sent → ${r.lead_name || r.sender}`)
      } catch (err: any) {
        prompts.log.error(`${r.id}: ${err.message?.slice(0, 160)}`)
      }
    }
    mrRewrite(rows)
    prompts.outro("Done")
  },
})

const MentionsRejectCommand = cmd({
  command: "reject <id>",
  describe: "discard a drafted reply (won't send)",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    const rows = mrLoadQueue(); const r = rows.find((x) => x.id === args.id)
    UI.empty()
    if (!r) { prompts.log.error(`No draft ${args.id}`); return }
    r.status = "rejected"; mrRewrite(rows)
    prompts.log.info(`${args.id} rejected`)
  },
})

const ImessageMentionsCommand = cmd({
  command: "mentions",
  aliases: ["@", "wakeword"],
  describe: "query @heyiris mentions, or respond/draft/approve replies (subcommands)",
  builder: (yargs) =>
    yargs
      .command(MentionsRespondCommand)
      .command(MentionsDraftsCommand)
      .command(MentionsShowCommand)
      .command(MentionsApproveCommand)
      .command(MentionsRejectCommand)
      .option("days", { type: "number", default: 30, describe: "look back N days" })
      .option("sender", { type: "string", describe: "filter by sender phone or name" })
      .option("lead", { type: "number", describe: "filter by lead ID" })
      .option("limit", { type: "number", default: 50, describe: "max mentions" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    // If a subcommand (respond/drafts/show/approve/reject) ran, yargs invoked it
    // already and this default handler is skipped. Reaching here = bare `mentions`.
    if (!args.json) { UI.empty(); prompts.intro("◈  @heyiris Mentions") }

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
  command: "groups [query]",
  aliases: ["group-chats", "gc"],
  describe: "list group chats with names and participants (optional [query] filters by name/participant)",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", describe: "filter groups by name or participant (substring, case-insensitive)" })
      .option("days", { type: "number", default: 90, describe: "look back N days" })
      .option("limit", { type: "number", default: 30, describe: "max groups" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  iMessage Group Chats") }

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

    // Resolve member handles -> contact names once for all groups
    const membersByGuid = new Map<string, string[]>()
    for (const g of groups) membersByGuid.set(g.guid, getGroupParticipants(g.guid))
    const allHandles = [...new Set([...membersByGuid.values()].flat())]
    const nameMap = await resolveContactNames(allHandles)

    const memberInfo = (guid: string) =>
      (membersByGuid.get(guid) || []).map(h => ({ handle: h, name: nameMap.get(h) ?? null }))

    // A real, user-set group name (listGroupChats backfills "(unnamed group)")
    const realName = (dn: string) => (dn && dn !== "(unnamed group)" ? dn : null)

    // Synthesize a label from member first-names when the group has no display_name
    const synthName = (guid: string) => {
      const parts = memberInfo(guid).map(m => (m.name || m.handle).split(" ")[0])
      return parts.length ? parts.join(", ") : "(unnamed group)"
    }

    // Optional [query] filter — match on the resolved group label OR any participant name/handle
    const q = (args.query ? String(args.query) : "").trim().toLowerCase()
    const matchesQuery = (guid: string, displayName: string) => {
      if (!q) return true
      const label = (realName(displayName) ?? synthName(guid)).toLowerCase()
      if (label.includes(q)) return true
      return memberInfo(guid).some(m => (m.name || "").toLowerCase().includes(q) || (m.handle || "").toLowerCase().includes(q))
    }
    const filtered = groups.filter(g => matchesQuery(g.guid, g.display_name))
    if (!filtered.length) {
      if (args.json) { console.log("[]"); return }
      prompts.log.info(`No group chats match ${bold(String(args.query))}`)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      // Enrich with resolved participants for JSON output
      const enriched = filtered.map(g => ({
        ...g,
        display_name: realName(g.display_name) ?? synthName(g.guid),
        members: memberInfo(g.guid),
      }))
      console.log(JSON.stringify(enriched, null, 2))
      return
    }

    printDivider()
    for (const group of filtered) {
      const name = bold(realName(group.display_name) ?? synthName(group.guid))
      const meta = dim(`${group.participants} members · ${group.message_count} msgs · ${group.last_message}`)
      const memberNames = memberInfo(group.guid).map(m => m.name || m.handle).join(", ")
      console.log(`  ${name}`)
      console.log(`    ${meta}`)
      if (memberNames) console.log(`    ${dim(memberNames)}`)
      console.log(`    ${dim(group.chat_identifier)}`)
      console.log()
    }
    printDivider()
    const label = q ? ` matching ${bold(String(args.query))}` : ""
    prompts.outro(`${success("✓")} ${filtered.length} group chat${filtered.length === 1 ? "" : "s"}${label}\n  ${dim("iris imessage read-group <name-or-id>")}`)
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
    if (!args.json) { UI.empty(); prompts.intro(`◈  iMessage Group — "${args.query}"`) }

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

const ImessageMeCommand = cmd({
  command: "me",
  aliases: ["self"],
  describe: "view or set your own handle (used by `send me …`)",
  builder: (yargs) =>
    yargs
      .option("set-email", { type: "string", describe: "set your iMessage email/Apple ID" })
      .option("set-phone", { type: "string", describe: "set your phone number (for SMS)" })
      .option("clear", { type: "boolean", default: false, describe: "clear saved self config" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (args.clear) {
      clearSelfConfig()
      if (args.json) { console.log(JSON.stringify({ cleared: true })); return }
      UI.empty(); prompts.intro("◈  iMessage — Me"); prompts.log.success("Cleared saved self config"); prompts.outro("Done")
      return
    }

    const patch: { email?: string; phone?: string } = {}
    if (args["set-email"] !== undefined) patch.email = String(args["set-email"]).trim()
    if (args["set-phone"] !== undefined) {
      let p = String(args["set-phone"]).trim()
      const d = p.replace(/\D/g, "")
      if (d.length === 10) p = `+1${d}`
      else if (d.length === 11 && d.startsWith("1")) p = `+${d}`
      patch.phone = p
    }
    if (patch.email !== undefined || patch.phone !== undefined) writeSelfConfig(patch)

    const cfg = readSelfConfig()
    const detected = detectSelfHandle()
    const effective = resolveSelfHandle("email")

    if (args.json) {
      console.log(JSON.stringify({ saved: cfg, detected, effective }))
      return
    }

    UI.empty()
    prompts.intro("◈  iMessage — Me")
    printDivider()
    console.log(`  ${dim("Saved email:")}  ${cfg.email || dim("(unset)")}`)
    console.log(`  ${dim("Saved phone:")}  ${cfg.phone || dim("(unset)")}`)
    console.log(`  ${dim("Detected:")}     ${dim("email")} ${detected.email || dim("—")}  ${dim("phone")} ${detected.phone || dim("—")}`)
    printDivider()
    console.log(`  ${dim("`send me …` will use:")} ${effective ? bold(effective) : dim("(nothing — set one above)")}`)
    if (!cfg.email && !cfg.phone) {
      console.log(`  ${dim("Set with:")} iris imessage me --set-email you@icloud.com`)
    }
    prompts.outro("Done")
  },
})

export const PlatformImessageCommand = cmd({
  command: "imessage",
  aliases: ["sms", "messages"],
  describe: "read and send iMessages via macOS Messages.app (requires Full Disk Access)",
  builder: (yargs) =>
    yargs
      .command(ImessageMeCommand)
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
