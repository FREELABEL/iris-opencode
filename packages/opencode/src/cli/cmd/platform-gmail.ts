import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import { getToken, getLabels, listMessages, searchMessages, getThread } from "../lib/gmail"

async function requireToken(): Promise<string | null> {
  const token = await getToken()
  if (!token) {
    prompts.log.error("No Gmail connected. Connect via: iris channels connect gmail")
    prompts.log.info(dim("Or set GMAIL_ACCESS_TOKEN env var for manual testing"))
  }
  return token
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ""
  try {
    const d = new Date(dateStr)
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch { return dateStr }
}

function extractName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1].trim() : from.split("@")[0]
}

const GmailInboxCommand = cmd({
  command: "inbox",
  aliases: ["list", "ls"],
  describe: "list recent Gmail messages",
  builder: (yargs) =>
    yargs
      .option("query", { type: "string", default: "in:inbox", describe: "Gmail search query (e.g., is:unread, from:alex)" })
      .option("limit", { type: "number", default: 15, describe: "max messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Gmail Inbox") }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Fetching messages...")

      const messages = await listMessages(token, args.query as string, args.limit as number)

      if (sp) sp.stop(`${messages.length} message(s)`)

      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(messages, null, 2)); return }

      printDivider()
      for (const msg of messages) {
        const unread = msg.is_unread ? success("●") : dim("○")
        const from = extractName(msg.from)
        const date = formatDate(msg.date)
        console.log(`  ${unread} ${bold(from.padEnd(20).slice(0, 20))}  ${msg.subject.slice(0, 50)}  ${dim(date)}`)
        if (msg.snippet) console.log(`    ${dim(msg.snippet.slice(0, 80))}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${messages.length} message${messages.length === 1 ? "" : "s"}\n  ${dim("iris gmail read <message-id>")}`)
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

const GmailReadCommand = cmd({
  command: "read <id>",
  describe: "read a Gmail message or thread by ID",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true, describe: "message or thread ID" })
      .option("thread", { type: "boolean", default: false, describe: "load full thread" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Gmail Read") }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      if (args.thread) {
        const thread = await getThread(token, args.id)
        if (!thread) {
          prompts.log.error(`Thread ${args.id} not found`)
          prompts.outro("Done")
          return
        }

        if (args.json) { console.log(JSON.stringify(thread, null, 2)); return }

        prompts.log.info(`Thread: ${thread.messages[0]?.subject || thread.snippet}`)
        printDivider()
        for (const msg of thread.messages) {
          const from = extractName(msg.from)
          const date = formatDate(msg.date)
          console.log(`  ${bold(from)}  ${dim(date)}`)
          const body = msg.body_text || msg.snippet
          console.log(`    ${body.slice(0, 300).replace(/\n/g, "\n    ")}${body.length > 300 ? "..." : ""}`)
          console.log()
        }
        printDivider()
        prompts.outro(`${success("✓")} ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} in thread`)
      } else {
        const { getMessageById } = await import("../lib/gmail")
        const msg = await getMessageById(token, args.id)
        if (!msg) {
          prompts.log.error(`Message ${args.id} not found`)
          prompts.outro("Done")
          return
        }

        if (args.json) { console.log(JSON.stringify(msg, null, 2)); return }

        printDivider()
        console.log(`  ${bold("From:")}    ${msg.from}`)
        console.log(`  ${bold("To:")}      ${msg.to}`)
        console.log(`  ${bold("Subject:")} ${msg.subject}`)
        console.log(`  ${bold("Date:")}    ${msg.date}`)
        console.log(`  ${bold("Labels:")}  ${msg.labels.join(", ")}`)
        console.log()
        const body = msg.body_text || msg.snippet
        console.log(`  ${body.replace(/\n/g, "\n  ")}`)
        printDivider()
        if (msg.thread_id) prompts.log.info(dim(`Thread: iris gmail read ${msg.thread_id} --thread`))
        prompts.outro(success("✓"))
      }
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

const GmailSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search Gmail with Gmail query syntax",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "Gmail search (e.g., from:alex subject:meeting is:unread)" })
      .option("limit", { type: "number", default: 20, describe: "max results" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Gmail Search — "${args.query}"`) }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Searching...")

      const messages = await searchMessages(token, args.query, args.limit as number)

      if (sp) sp.stop(`${messages.length} result(s)`)

      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify(messages, null, 2)); return }

      printDivider()
      for (const msg of messages) {
        const unread = msg.is_unread ? success("●") : dim("○")
        const from = extractName(msg.from)
        const date = formatDate(msg.date)
        console.log(`  ${unread} ${bold(from.padEnd(20).slice(0, 20))}  ${msg.subject.slice(0, 50)}  ${dim(date)}`)
        console.log(`    ${dim(msg.snippet.slice(0, 80))}`)
        console.log(`    ${dim(`id:${msg.id}  thread:${msg.thread_id}`)}`)
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

const GmailLabelsCommand = cmd({
  command: "labels",
  aliases: ["folders"],
  describe: "list Gmail labels with message counts",
  builder: (yargs) =>
    yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Gmail Labels") }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const labels = await getLabels(token)

      if (args.json) { console.log(JSON.stringify(labels, null, 2)); return }

      // Sort: system labels first, then user labels
      const system = labels.filter(l => l.type === "system").sort((a, b) => a.name.localeCompare(b.name))
      const user = labels.filter(l => l.type !== "system").sort((a, b) => a.name.localeCompare(b.name))

      printDivider()
      for (const l of [...system, ...user]) {
        const unread = l.messages_unread > 0 ? success(` (${l.messages_unread} unread)`) : ""
        const total = dim(`${l.messages_total} msgs`)
        const isUser = l.type !== "system" ? dim(" [custom]") : ""
        console.log(`  ${bold(l.name)}  ${total}${unread}${isUser}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} ${labels.length} label${labels.length === 1 ? "" : "s"}`)
    } catch (err: any) {
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

const GmailUnreadCommand = cmd({
  command: "unread",
  describe: "show unread Gmail messages",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 10, describe: "max messages" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    // Delegate to inbox with is:unread query
    return GmailInboxCommand.handler({ ...args, query: "is:unread" } as any)
  },
})

export const PlatformGmailCommand = cmd({
  command: "gmail",
  describe: "read Gmail messages via Google API (requires Gmail OAuth connection)",
  builder: (yargs) =>
    yargs
      .command(GmailInboxCommand)
      .command(GmailReadCommand)
      .command(GmailSearchCommand)
      .command(GmailLabelsCommand)
      .command(GmailUnreadCommand)
      .strict(false),
  async handler() {
    return GmailInboxCommand.handler({} as any)
  },
})
