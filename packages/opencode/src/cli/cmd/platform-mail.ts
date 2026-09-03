import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, printKV, dim, bold, success, BRIDGE_URL, bridgeFetch, writeJson } from "./iris-api"
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
      await writeJson(messages)
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
      await writeJson(msg)
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
      .option("sender", {
        type: "string",
        describe: "send as a registered identity (a `iris senders` slug) — routed, verified, and logged",
      })
      .option("subject", { type: "string", alias: "s", demandOption: true })
      .option("body", { type: "string", alias: "b", demandOption: true })
      .option("cc", { type: "string", describe: "CC email address" })
      // Repeatable. The bridge has always accepted `attachments` as an ARRAY; the CLI wrapped a
      // single string in a one-element array, so five files meant five sends. On 2026-08-28 an
      // agent asked to attach five images concluded the task was impossible and told the user to
      // drag them in by hand — the capability was there and nothing exposed it.
      .option("attachment", {
        type: "array",
        string: true,
        describe: "file path to attach (repeatable: --attachment a.png --attachment b.png)",
      })
      // draft=true composes and OPENS the message without sending. The bridge has supported this
      // from the start and no flag reached it, so "let me look at it before it goes" was not
      // expressible — the only choice was send or do not send.
      .option("draft", {
        type: "boolean",
        default: false,
        describe: "compose and open the message in Mail.app WITHOUT sending it",
      }),
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
    const attachments = ((args.attachment as string[] | undefined) ?? []).filter(Boolean)
    // --draft joins this list because the comms router only knows how to SEND. Routing a draft
    // would either send it or drop the flag, and both are worse than saying which path was taken.
    const needsDirectBridge = Boolean(attachments.length || args.cc || args.from || args.draft)

    // --sender and --from answer the same question in opposite directions. `--from` is a raw
    // address nothing has checked, taking the unrouted bridge path; `--sender` is a registered
    // identity the API verifies and routes. Accepting both would leave which one wins to
    // whichever branch happened to run first.
    if (args.sender && args.from) {
      prompts.log.error("Use --sender OR --from, not both: --sender is a verified identity, --from is an unchecked address.")
      prompts.outro("Done")
      return
    }

    if (args.sender && needsDirectBridge) {
      prompts.log.error(
        "--sender cannot be combined with --attachment/--cc/--draft: those take the direct bridge path, which does not read channel bindings.",
      )
      prompts.outro("Done")
      return
    }

    if (!needsDirectBridge) {
      const result = await routerSend({
        toHandle: args.to,
        channel: "apple_mail",
        subject: args.subject,
        message: args.body,
        sender: args.sender,
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

    prompts.log.warn(
      args.draft
        ? "Draft mode — composing direct via the bridge (nothing is sent, and nothing is logged to comms)."
        : "Attachment/cc/from set — sending direct via the bridge (not logged to comms).",
    )

    const payload: any = {
      to_email: args.to,
      subject: args.subject,
      body_text: args.body,
    }
    if (args.from) payload.from_email = args.from
    // cc_email, NOT cc. The bridge destructures `cc_email` and always has; the CLI sent `cc`, so
    // --cc was silently dropped on every send while the warning above told the operator it had
    // been applied. A field name is not a contract until something checks it.
    if (args.cc) payload.cc_email = args.cc
    if (attachments.length) payload.attachments = attachments
    if (args.draft) payload.draft = true

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

    // Report the bridge's own `mode`, not our intent. It is the only party that knows whether
    // Mail.app sent or merely opened the window.
    const body = (await res.json().catch(() => ({}))) as { mode?: string }
    const drafted = body.mode === "draft"
    prompts.outro(
      drafted
        ? `${success("✓")} Draft opened in Mail.app for ${args.to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""} — nothing sent`
        : `${success("✓")} Email sent to ${args.to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}`,
    )
  },
})

/**
 * Which addresses can this Mac actually send from — the answer an apple_mail binding asserts.
 *
 * Until the bridge could enumerate accounts, binding a sender to a Mail.app account was an
 * assertion nothing could contradict: verification confirmed only that the bridge answered. This
 * is the list to bind against.
 */
const MailAccountsCommand = cmd({
  command: "accounts",
  aliases: ["from", "identities"],
  describe: "list the Mail.app accounts this Mac can send from (what a sender can bind to)",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Apple Mail — accounts on this Mac")
    }

    if (!(await checkBridge())) {
      const msg = "IRIS Bridge not running on localhost:3200. Start with: iris bridge start"
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else {
        prompts.log.error(msg)
        prompts.outro("Done")
      }
      process.exitCode = 1
      return
    }

    const res = await bridgeFetch("/api/mail/accounts")
    const payload = (await res.json().catch(() => null)) as any

    if (!res.ok) {
      const msg = payload?.error ?? `HTTP ${res.status}`
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else {
        prompts.log.error(msg)
        prompts.outro("Done")
      }
      process.exitCode = 1
      return
    }

    if (args.json) {
      await writeJson(payload)
      return
    }

    printDivider()
    for (const acct of payload?.accounts ?? []) {
      console.log(`  ${bold(acct.name)}`)
      for (const addr of acct.addresses ?? []) console.log(`      ${addr}`)
    }
    printDivider()
    console.log(`  ${dim("bind one to a sender:")} iris senders bind <slug> --channel apple_mail --value <address>`)
    prompts.outro("Done")
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
      .command(MailAccountsCommand)
      .demandCommand(),
  async handler() {},
})
