import os from "os"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success, writeJson } from "./iris-api"
import { getToken, getLabels, listMessages, searchMessages, getThread, lastError, setGmailAccount, lastGmailAccount, nextPageToken } from "../lib/gmail"

async function requireToken(): Promise<string | null> {
  const token = await getToken()
  if (!token) {
    // Report the ACTUAL reason. This used to be a hardcoded "No Gmail connected"
    // regardless of state — it was printed even when the account was connected and
    // merely expired, and even when the credential endpoint did not exist (#178282).
    prompts.log.error(lastError())
    // GMAIL_ACCESS_TOKEN is no longer read — auth lives on the backend now, so
    // advertising it would send people down a path that does nothing.
    // NOT list-connected: it reads a store that cannot see Composio-backed connections, so
    // it will happily confirm "nothing connected" for a working account and send people into
    // a reconnect loop. Point at the call that proves it either way.
    prompts.log.info(dim("Verify by using it:  iris integrations exec gmail fetch_emails max_results=5"))
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
      .option("limit", { type: "number", default: 50, describe: "how many messages (up to 500 per call)" })
      .option("page-token", { type: "string", describe: "continue after a previous call (printed when there is more)" })
      .option("all", { type: "boolean", default: false, describe: "keep paging until there are no more (stops at 5000)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Gmail Inbox") }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Fetching messages...")

      const messages = await listMessages(token, args.query as string, args.limit as number, { pageToken: (args as any)["page-token"], all: Boolean((args as any).all) })

      if (sp) sp.stop(`${messages.length} message(s)`)

      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        printMailboxLine()
        prompts.outro("Done")
        return
      }

      if (args.json) { await writeJson(messages); moreHint(true); return }

      printDivider()
      for (const msg of messages) {
        const unread = msg.is_unread ? success("●") : dim("○")
        const from = extractName(msg.from)
        const date = formatDate(msg.date)
        console.log(`  ${unread} ${bold(from.padEnd(20).slice(0, 20))}  ${msg.subject.slice(0, 50)}  ${dim(date)}`)
        if (msg.snippet) console.log(`    ${dim(msg.snippet.slice(0, 80))}`)
      }
      printDivider()
      printMailboxLine()
      moreHint(false)
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
          // Honest refusal: the backend has no thread fetch yet, and this used to return the
          // newest inbox messages labelled as the thread.
          const msg = "Reading a whole thread isn't supported yet. Read one message with: iris gmail read <message-id>"
          if (args.json) { await writeJson({ success: false, error: msg }); process.exitCode = 1; return }
          prompts.log.error(msg)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }

        if (args.json) { await writeJson(thread); return }

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
        printMailboxLine()
        prompts.outro(`${success("✓")} ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} in thread`)
      } else {
        const { getMessageById } = await import("../lib/gmail")
        const msg = await getMessageById(token, args.id)
        if (!msg) {
          prompts.log.error(`Message ${args.id} not found`)
          prompts.outro("Done")
          return
        }

        if (args.json) { await writeJson(msg); return }

        printDivider()
        console.log(`  ${bold("From:")}    ${msg.from}`)
        console.log(`  ${bold("To:")}      ${msg.to}`)
        console.log(`  ${bold("Subject:")} ${msg.subject}`)
        console.log(`  ${bold("Date:")}    ${msg.date}`)
        console.log(`  ${bold("Labels:")}  ${msg.labels.join(", ")}`)
        console.log()
        const body = msg.body_text || msg.snippet
        console.log(`  ${body.replace(/\n/g, "\n  ")}`)
        if (msg.attachments?.length) {
          console.log()
          console.log(`  ${bold("Attachments:")}`)
          for (const a of msg.attachments) console.log(`    ${a.filename}  ${dim(`${a.type} · ${Math.round(a.size / 1024)} KB`)}`)
          console.log(dim(`    read one: iris integrations exec gmail read_attachment message_id=${msg.id} filename="<name>"`))
        }
        printDivider()
        printMailboxLine()
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
      .option("limit", { type: "number", default: 50, describe: "how many messages (up to 500 per call)" })
      .option("page-token", { type: "string", describe: "continue after a previous call (printed when there is more)" })
      .option("all", { type: "boolean", default: false, describe: "keep paging until there are no more (stops at 5000)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Gmail Search — "${args.query}"`) }

    const token = await requireToken()
    if (!token) { prompts.outro("Done"); return }

    try {
      const sp = args.json ? null : prompts.spinner()
      if (sp) sp.start("Searching...")

      const messages = await searchMessages(token, args.query, args.limit as number, { pageToken: (args as any)["page-token"], all: Boolean((args as any).all) })

      if (sp) sp.stop(`${messages.length} result(s)`)

      if (!messages.length) {
        prompts.log.info(`No messages matching "${args.query}"`)
        printMailboxLine()
        prompts.outro("Done")
        return
      }

      if (args.json) { await writeJson(messages); moreHint(true); return }

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
      printMailboxLine()
      moreHint(false)
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

      if (args.json) { await writeJson(labels); return }

      // Sort: system labels first, then user labels
      const system = labels.filter(l => l.type === "system").sort((a, b) => a.name.localeCompare(b.name))
      const user = labels.filter(l => l.type !== "system").sort((a, b) => a.name.localeCompare(b.name))

      printDivider()
      for (const l of [...system, ...user]) {
        // GMAIL_LIST_LABELS returns only id/name/type/visibility — no messagesTotal or
        // messagesUnread. Printing "0 msgs" for every label was a FABRICATED number: it
        // looked like an empty mailbox rather than an absent field. Show counts only when
        // the API actually supplies them (#178282).
        const unread = l.messages_unread > 0 ? success(` (${l.messages_unread} unread)`) : ""
        const total = l.messages_total > 0 ? dim(`  ${l.messages_total} msgs`) : ""
        const isUser = l.type !== "system" ? dim(" [custom]") : ""
        console.log(`  ${bold(l.name)}${total}${unread}${isUser}`)
      }
      printDivider()
      printMailboxLine()
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
      .option("limit", { type: "number", default: 50, describe: "how many messages (up to 500 per call)" })
      .option("page-token", { type: "string", describe: "continue after a previous call (printed when there is more)" })
      .option("all", { type: "boolean", default: false, describe: "keep paging until there are no more (stops at 5000)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    // Delegate to inbox with is:unread query
    return GmailInboxCommand.handler({ ...args, query: "is:unread" } as any)
  },
})

/**
 * One line naming the mailbox that answered. Printed after every non-JSON gmail command; in JSON
 * each message carries `mailbox` + `integration_id` itself. Message ids are only valid in the
 * mailbox they came from — act on them with the same --integration-id.
 */
/** Say when there is more — the token to continue, or --all. JSON keeps stdout an array; the hint goes to stderr. */
function moreHint(json: boolean): void {
  const t = nextPageToken()
  if (!t) return
  const line = `More messages match. Next page: --page-token=${t}  ·  everything: --all`
  if (json) process.stderr.write(`next_page_token: ${t}\n`)
  else console.log(dim(`  ${line}`))
}

export function printMailboxLine(): void {
  const a = lastGmailAccount()
  if (!a) return
  const who = a.account ?? `connection #${a.integration_id}`
  console.log(dim(`  ↳ mailbox: ${who}${a.integration_id ? ` (#${a.integration_id})` : ""} · from ${os.hostname()}`))
  if (a.notice) console.log(dim(`    ${a.notice}`))
}

export const PlatformGmailCommand = cmd({
  command: "gmail",
  describe: "read Gmail messages via Google API (requires Gmail OAuth connection)",
  builder: (yargs) =>
    yargs
      .option("account", { type: "string", describe: "mailbox to use, by address (e.g. --account=me@company.com)" })
      .option("integration-id", { type: "number", describe: "mailbox to use, by connection id (see: iris integrations list)" })
      .middleware((argv: any) => setGmailAccount({ integrationId: argv["integration-id"], account: argv.account }))
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
