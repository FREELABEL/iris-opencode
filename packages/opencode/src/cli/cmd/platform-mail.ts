import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, printKV, dim, bold, success, BRIDGE_URL, bridgeFetch } from "./iris-api"
import { mailRows } from "./mail-response"
import { routerSend, describeSend } from "./comms-send"

// macOS Apple Mail integration via IRIS Bridge (localhost:3200)
// Bridge endpoint: GET /api/mail/search?from=X&subject=X&days=N&limit=N&include_body=1&max_body=N
// Bridge endpoint: POST /api/mail/send { to_email, subject, body_text, cc, attachments }

async function checkBridge(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const data = (await res.json()) as any
    return data?.status === "ok"
  } catch {
    return false
  }
}

const MailSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search Apple Mail by sender name or email",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "sender name or email substring" })
      .option("subject", { type: "string", alias: "s", describe: "filter by subject" })
      .option("days", { type: "number", default: 7, describe: "search last N days" })
      .option("limit", { type: "number", default: 10, describe: "max results" })
      .option("full", { type: "boolean", default: false, describe: "include full email body (up to 10000 chars)" })
      .option("max-body", { type: "number", default: 4000, describe: "max body chars (use with --full)" })
      .option("attachments", { type: "boolean", default: false, describe: "list attachments on each email" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Apple Mail Search")

    if (!(await checkBridge())) {
      prompts.log.error("IRIS Bridge not running on localhost:3200. Start with: iris bridge start")
      prompts.outro("Done")
      return
    }

    const params = new URLSearchParams({
      from: args.query,
      days: String(args.days),
      limit: String(args.limit),
    })
    if (args.full) {
      params.set("include_body", "1")
      params.set("max_body", String(args.maxBody ?? args["max-body"] ?? 4000))
    }
    if (args.subject) params.set("subject", args.subject)
    if (args.attachments) params.set("include_attachments", "1")

    const res = await bridgeFetch(`/api/mail/search?${params}`)
    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error")
      prompts.log.error(`Mail search failed: ${err}`)
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    const messages: any[] = mailRows(data)

    if (args.json) {
      console.log(JSON.stringify(messages, null, 2))
      prompts.outro("Done")
      return
    }

    if (messages.length === 0) {
      prompts.log.info(`No emails from "${args.query}" in the last ${args.days} days`)
      prompts.outro("Done")
      return
    }

    for (const msg of messages) {
      printDivider()
      printKV("Date", msg.date)
      printKV("From", msg.sender)
      printKV("Subject", bold(msg.subject))
      if (args.full && msg.body) {
        console.log()
        console.log(msg.body)
      }
      if (msg.attachments?.length > 0) {
        console.log(`  ${bold("Attachments")}  ${dim(`(${msg.attachments.length})`)}`)
        for (const att of msg.attachments) {
          const size = att.size > 1024 * 1024 ? `${(att.size / (1024 * 1024)).toFixed(1)}MB` : att.size > 1024 ? `${(att.size / 1024).toFixed(0)}KB` : `${att.size}B`
          console.log(`    ${success("📎")} ${att.name}  ${dim(`${att.mime_type} · ${size}`)}`)
          if (att.saved_path) console.log(`       ${dim(`→ ${att.saved_path}`)}`)
        }
      }
    }
    printDivider()
    prompts.outro(`${success("✓")} ${messages.length} email${messages.length === 1 ? "" : "s"} found`)
  },
})

const MailReadCommand = cmd({
  command: "read <query>",
  describe: "read the latest email from a sender (full body)",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "sender name or email" })
      .option("subject", { type: "string", alias: "s", describe: "filter by subject" })
      .option("days", { type: "number", default: 14, describe: "search last N days" })
      .option("max-body", { type: "number", default: 10000, describe: "max body chars" })
      .option("save-attachments", { type: "boolean", default: false, describe: "download attachments to temp dir" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Read Mail — from "${args.query}"`)

    if (!(await checkBridge())) {
      prompts.log.error("IRIS Bridge not running on localhost:3200. Start with: iris bridge start")
      prompts.outro("Done")
      return
    }

    const saveAttachments = args.saveAttachments ?? args["save-attachments"] ?? false
    const params = new URLSearchParams({
      from: args.query,
      days: String(args.days),
      limit: "1",
      include_body: "1",
      include_attachments: "1",
      max_body: String(args.maxBody ?? args["max-body"] ?? 10000),
    })
    if (saveAttachments) params.set("save_attachments", "1")
    if (args.subject) params.set("subject", args.subject)

    const res = await bridgeFetch(`/api/mail/search?${params}`)
    if (!res.ok) {
      prompts.log.error(`Mail read failed: ${await res.text().catch(() => "Unknown error")}`)
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    const messages: any[] = mailRows(data)

    if (messages.length === 0) {
      prompts.log.info(`No emails from "${args.query}" in the last ${args.days} days`)
      prompts.outro("Done")
      return
    }

    const msg = messages[0]

    if (args.json) {
      console.log(JSON.stringify(msg, null, 2))
      prompts.outro("Done")
      return
    }

    printDivider()
    printKV("Date", msg.date)
    printKV("From", msg.sender)
    printKV("Subject", bold(msg.subject))
    if (msg.attachments?.length > 0) {
      console.log()
      console.log(`  ${bold("Attachments")}  ${dim(`(${msg.attachments.length})`)}`)
      for (const att of msg.attachments) {
        const size = att.size > 1024 * 1024 ? `${(att.size / (1024 * 1024)).toFixed(1)}MB` : att.size > 1024 ? `${(att.size / 1024).toFixed(0)}KB` : `${att.size}B`
        console.log(`    ${success("📎")} ${att.name}  ${dim(`${att.mime_type} · ${size}`)}`)
        if (att.saved_path) console.log(`       ${dim(`Saved → ${att.saved_path}`)}`)
      }
    }
    printDivider()
    console.log()
    console.log(msg.body || dim("(no body)"))
    console.log()
    prompts.outro("Done")
  },
})

const MailSendCommand = cmd({
  command: "send <to>",
  describe: "send an email via Apple Mail.app (routed through the comms router so it is logged)",
  builder: (yargs) =>
    yargs
      .positional("to", { type: "string", demandOption: true, describe: "recipient email" })
      .option("from", { type: "string", alias: "f", describe: "sender email address (must be configured in Mail.app)" })
      .option("subject", { type: "string", alias: "s", demandOption: true })
      .option("body", { type: "string", alias: "b", demandOption: true })
      .option("cc", { type: "string", describe: "CC email address" })
      .option("attachment", { type: "string", describe: "file path to attach" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Send Mail — to ${args.to}`)

    if (!(await checkBridge())) {
      prompts.log.error("IRIS Bridge not running on localhost:3200. Start with: iris bridge start")
      prompts.outro("Done")
      return
    }

    // ROUTE THROUGH THE COMMS ROUTER (CR-8) so the send lands in lead_comms. This used to POST
    // straight to the bridge and return — the mail went out and nothing recorded it, which is
    // why the comms log was only ever as fresh as the last manual `atlas:comms ingest`.
    //
    // Attachments and cc have no router path yet, and silently dropping them would be worse
    // than not routing: fall back to the direct bridge call and say so, rather than sending a
    // different email than the operator asked for.
    const needsDirectBridge = Boolean(args.attachment || args.cc || args.from)

    if (!needsDirectBridge) {
      const result = await routerSend({
        toHandle: args.to,
        channel: "apple_mail",
        subject: args.subject,
        message: args.body,
        origin: "cli.reachr",
      })

      if (result.ok && result.sent) {
        prompts.log.info(describeSend(result))
        prompts.outro(`${success("✓")} Email sent to ${args.to}`)
        return
      }

      // A router failure is reported, not silently retried through the bridge — a fallback that
      // hides the reason is how "sent but unlogged" became invisible in the first place.
      prompts.log.error(`Router send failed: ${result.error ?? "unknown"}`)
      prompts.outro("Done")
      return
    }

    prompts.log.warn("Attachment/cc/from set — sending direct via the bridge (not logged to comms).")

    const payload: any = {
      to_email: args.to,
      subject: args.subject,
      body_text: args.body,
    }
    if (args.from) payload.from_email = args.from
    if (args.cc) payload.cc = args.cc
    if (args.attachment) payload.attachments = [args.attachment]

    const res = await bridgeFetch(`/api/mail/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      prompts.log.error(`Send failed: ${await res.text().catch(() => "Unknown error")}`)
      prompts.outro("Done")
      return
    }

    prompts.outro(`${success("✓")} Email sent to ${args.to}`)
  },
})

export const PlatformMailCommand = cmd({
  command: "mail",
  describe: "Apple Mail — search/read, and send via the comms router so it lands in the log",
  builder: (yargs) =>
    yargs
      .command(MailSearchCommand)
      .command(MailReadCommand)
      .command(MailSendCommand)
      .demandCommand(),
  async handler() {},
})
