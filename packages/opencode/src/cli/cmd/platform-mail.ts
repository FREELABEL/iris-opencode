import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, printKV, dim, bold, success, BRIDGE_URL, bridgeFetch, writeJson } from "./iris-api"
import { probeWithHeal, type BridgeProbe, type BridgeHealth } from "./bridge-health"
import { mailRows } from "./mail-response"
import { fetchDaemonPermissions, isTccDenial, renderTccBlindSpot } from "./daemon-permissions"
import {
  routerSend,
  describeSend,
  recordDirectSend,
  resolveLeadForHandle,
  spoolUnlogged,
  type LeadResolution,
  readUnlogged,
  clearUnlogged,
  logComm,
  unloggedSpoolPath,
} from "./comms-send"
import { hiveReason, hiveMailCall, dedupeInbox, type MailVia } from "./mail-transport"
import { classifySender } from "../lib/mail-classify"

// macOS Apple Mail integration via the IRIS Bridge (BRIDGE_URL, default localhost:3200)
// Bridge endpoint: GET /api/mail/search?from=X&subject=X&days=N&limit=N&include_body=1&max_body=N
// Bridge endpoint: POST /api/mail/send { to_email, subject, body_text, cc, attachments }

async function probeBridgeOnce(timeoutMs: number): Promise<BridgeProbe> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    let body: any = undefined
    try {
      body = await res.json()
    } catch {
      /* a non-JSON body is still a real HTTP answer — status decides */
    }
    return { kind: "response", status: res.status, body }
  } catch (e: any) {
    const name = String(e?.name ?? "")
    if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" }
    return { kind: "network", error: String(e?.message ?? e) }
  }
}

/**
 * Probe the bridge, retrying once on a transient failure. The retry is the self-healing
 * part: a DNS/socket blip while the laptop wakes used to surface as a flat "not running".
 */
export async function probeBridge(): Promise<BridgeHealth> {
  const health = await probeWithHeal(probeBridgeOnce, BRIDGE_URL)
  // Emit the signal on the way past. A silent retry is an unfalsifiable claim; this line is
  // what lets anyone confirm the heal path is still alive months from now.
  if (health.healed) {
    prompts.log.info(dim(`bridge recovered on retry — self-heal fired (${health.attempts} attempts)`))
  }
  return health
}

/**
 * The bridge's error, unless it is a Full Disk Access refusal — then say which program was
 * refused and the one command that fixes it, instead of the raw 503 body.
 */
async function reportMailFailure(verb: string, err: string): Promise<void> {
  if (!isTccDenial(err)) {
    prompts.log.error(`${verb} failed: ${err}`)
    return
  }
  const perms = await fetchDaemonPermissions({ waitForStartMs: 10_000 })
  const r = renderTccBlindSpot("Mail", "daemon", perms)
  if (r.headline.startsWith("skipped — ")) {
    // Client wording: a plain sentence, not "search failed: skipped".
    const line = r.headline.replace(/^skipped — /, "")
    prompts.log.warn(line.charAt(0).toUpperCase() + line.slice(1) + ".")
    return
  }
  // One message, so the fix travels with the error to wherever the log goes (stderr off a TTY).
  prompts.log.error([`${verb} failed: ${r.headline.replace(/^blind — /, "")}`, ...r.fix].join("\n"))
}

// ── Where the call runs (#189480) ───────────────────────────────────────────────────
//
// `iris mail` used to talk only to this machine's bridge, so on any machine without Apple
// Mail it failed — with "is Mail.app configured on this Mac?" even on Linux — while an
// online Hive node had Mail the whole time. Every subcommand now goes through mailCall:
// this machine first when it is a Mac with Mail, otherwise the Hive node, over the cloud's
// bridge-call rail. The routing decision itself is hiveReason (tested in mail-transport).

type MailCall = { fn: string; method: "GET" | "POST"; path: string; args: Record<string, unknown> }
type MailAnswer = { ok: true; data: any; where: string } | { ok: false; error: string; local: boolean }

const viaOption = {
  type: "string" as const,
  choices: ["auto", "local", "hive"],
  default: "auto",
  describe: "auto: this machine if it has Apple Mail, else the Hive node that does",
}

async function viaHive(c: MailCall, reason: string): Promise<MailAnswer> {
  const r = await hiveMailCall(c.fn, c.args)
  if (!r.ok) return { ok: false, error: r.error, local: false }
  return { ok: true, data: r.data, where: `Hive node ${r.nodeId ? r.nodeId.slice(0, 8) : "?"} — ${reason}` }
}

async function mailCall(c: MailCall, via: MailVia): Promise<MailAnswer> {
  const up = hiveReason({ platform: process.platform, via })
  if (up) return viaHive(c, up)

  const bridge = await probeBridge()
  if (!bridge.ok) {
    return { ok: false, local: true, error: `${bridge.message}${via === "auto" ? " — or ask the Hive node: --via hive" : ""}` }
  }

  let res: Response
  if (c.method === "GET") {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(c.args)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v))
    res = await bridgeFetch(`${c.path}?${qs}`)
  } else {
    res = await bridgeFetch(c.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.args) })
  }
  if (res.ok) return { ok: true, data: await res.json(), where: "this machine" }

  const err = await res.text().catch(() => `HTTP ${res.status}`)
  const fallback = hiveReason({ platform: process.platform, via, localError: err })
  if (fallback) return viaHive(c, fallback)
  return { ok: false, error: err, local: true }
}

/** Print a failed call — with the Full Disk Access fix when it is a local permission refusal. */
async function reportAnswer(verb: string, a: Extract<MailAnswer, { ok: false }>): Promise<void> {
  if (a.local) await reportMailFailure(verb, a.error)
  else prompts.log.error(`${verb} failed: ${a.error}`)
  process.exitCode = 1
}

const MailSearchCommand = cmd({
  command: "search [query]",
  aliases: ["find"],
  describe: "search Apple Mail by sender name or email (omit it to search everyone — see also: iris mail inbox)",
  builder: (yargs) =>
    yargs
      .positional("query", {
        type: "string",
        default: "@",
        describe: "sender name or email substring; omitted = every sender (it matches on '@')",
      })
      .option("via", viaOption)
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

    const query = String(args.query ?? "@")
    const searchArgs: Record<string, unknown> = { from: query, days: args.days, limit: args.limit, subject: args.subject }
    if (args.full) {
      searchArgs.include_body = 1
      searchArgs.max_body = args.maxBody ?? args["max-body"] ?? 4000
    }
    if (args.attachments) searchArgs.include_attachments = 1

    const answer = await mailCall({ fn: "search_emails", method: "GET", path: "/api/mail/search", args: searchArgs }, args.via as MailVia)
    if (!answer.ok) {
      await reportAnswer("Mail search", answer)
      prompts.outro("Done")
      return
    }
    if (answer.where !== "this machine") prompts.log.info(dim(`via ${answer.where}`))

    const messages: any[] = mailRows(answer.data)

    if (args.json) {
      await writeJson(messages)
      prompts.outro("Done")
      return
    }

    if (messages.length === 0) {
      prompts.log.info(query === "@" ? `No emails in the last ${args.days} days` : `No emails from "${query}" in the last ${args.days} days`)
      prompts.outro("Done")
      return
    }

    for (const msg of messages) {
      printDivider()
      if (msg.id != null) printKV("Id", String(msg.id))
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
  describe: "read one email in full — by its id (from `iris mail inbox`), or the latest from a sender",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "message id, or sender name/email" })
      .option("subject", { type: "string", alias: "s", describe: "filter by subject" })
      .option("days", { type: "number", default: 14, describe: "search last N days" })
      .option("max-body", { type: "number", default: 10000, describe: "max body chars" })
      .option("save-attachments", { type: "boolean", default: false, describe: "download attachments to temp dir" })
      .option("via", viaOption)
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const query = String(args.query)
    const byId = /^\d+$/.test(query)
    prompts.intro(byId ? `◈  Read Mail — message ${query}` : `◈  Read Mail — from "${query}"`)
    const maxBody = args.maxBody ?? args["max-body"] ?? 10000

    let msg: any
    if (byId) {
      // By id: envelope AND body, from whichever machine holds the mailbox (#189480).
      const answer = await mailCall({ fn: "read_email", method: "GET", path: "/api/mail/message", args: { id: Number(query), max_body: maxBody } }, args.via as MailVia)
      if (!answer.ok) {
        await reportAnswer("Mail read", answer)
        prompts.outro("Done")
        return
      }
      if (answer.where !== "this machine") prompts.log.info(dim(`via ${answer.where}`))
      msg = { ...answer.data, date: answer.data.date_sent }
      if (!msg.body && msg.body_error) msg.body = dim(`(body unavailable: ${msg.body_error})`)
    } else {
      const saveAttachments = args.saveAttachments ?? args["save-attachments"] ?? false
      const searchArgs: Record<string, unknown> = {
        from: query, days: args.days, limit: 1, include_body: 1, include_attachments: 1, max_body: maxBody, subject: args.subject,
      }
      if (saveAttachments) searchArgs.save_attachments = 1
      const answer = await mailCall({ fn: "search_emails", method: "GET", path: "/api/mail/search", args: searchArgs }, args.via as MailVia)
      if (!answer.ok) {
        await reportAnswer("Mail read", answer)
        prompts.outro("Done")
        return
      }
      const messages: any[] = mailRows(answer.data)
      if (messages.length === 0) {
        prompts.log.info(`No emails from "${query}" in the last ${args.days} days`)
        prompts.outro("Done")
        return
      }
      msg = messages[0]
      // The envelope-index daemon returns no body on search. Ask for it by id rather than
      // printing "(no body)" for a message that has one.
      if (!msg.body && msg.id != null) {
        const full = await mailCall({ fn: "read_email", method: "GET", path: "/api/mail/message", args: { id: msg.id, max_body: maxBody } }, args.via as MailVia)
        if (full.ok && full.data?.body) msg = { ...msg, body: full.data.body }
      }
    }

    if (args.json) {
      await writeJson(msg)
      prompts.outro("Done")
      return
    }

    printDivider()
    if (msg.id != null) printKV("Id", String(msg.id))
    printKV("Date", msg.date)
    printKV("From", msg.sender_name ? `${msg.sender_name} <${msg.sender}>` : msg.sender)
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
    if (msg.id != null) prompts.log.info(dim(`reply in this thread: iris mail reply ${msg.id} --body "…"`))
    prompts.outro("Done")
  },
})

/**
 * The inbox, with people separated from feeds (#189480).
 *
 * There was no way to list mail: `search` needed a sender, and the senders worth answering —
 * recruiters — are strangers. `@` happened to work as a wildcard and nothing said so. And of
 * ~120 job emails in 30 days most were LinkedIn / Jobot / Lensa alerts, burying the people.
 */
const MailInboxCommand = cmd({
  command: "inbox",
  aliases: ["list", "ls"],
  describe: "list recent mail from everyone, people separated from automated alerts",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 7, describe: "last N days" })
      .option("limit", { type: "number", default: 50, describe: "max messages to fetch (the bridge caps at 200)" })
      .option("subject", { type: "string", alias: "s", describe: "only subjects containing this" })
      .option("people", { type: "boolean", default: false, describe: "only mail written by a person" })
      .option("alerts", { type: "boolean", default: false, describe: "only automated alerts and feeds" })
      .option("via", viaOption)
      .option("json", { type: "boolean", default: false })
      .example("iris mail inbox --people --days 30", "who actually wrote to you this month")
      .example('iris mail inbox --people -s engineer', "people, subject containing 'engineer'"),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Apple Mail — inbox")
    }
    const answer = await mailCall(
      { fn: "search_emails", method: "GET", path: "/api/mail/search", args: { from: "@", days: args.days, limit: args.limit, subject: args.subject } },
      args.via as MailVia,
    )
    if (!answer.ok) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: answer.error }))
        process.exitCode = 1
      } else {
        await reportAnswer("Inbox", answer)
        prompts.outro("Done")
      }
      return
    }

    const rows = dedupeInbox(mailRows(answer.data)).map((m: any) => {
      const verdict = classifySender({ sender: m.sender, senderName: m.sender_name, subject: m.subject })
      return { ...m, kind: verdict.kind, why: verdict.why }
    })
    const shown = rows.filter((r) => (args.people ? r.kind === "person" : args.alerts ? r.kind === "alert" : true))
    const people = rows.filter((r) => r.kind === "person").length

    if (args.json) {
      await writeJson({ ok: true, where: answer.where, total: rows.length, people, alerts: rows.length - people, messages: shown })
      return
    }

    if (answer.where !== "this machine") prompts.log.info(dim(`via ${answer.where}`))
    for (const m of shown) {
      const tag = m.kind === "person" ? success("person") : dim(m.kind === "alert" ? "alert " : "?     ")
      const when = m.date ? String(m.date).slice(0, 16).replace("T", " ") : "—"
      const who = m.sender_name ? `${m.sender_name} <${m.sender}>` : m.sender
      console.log(`  ${dim(String(m.id ?? "—").padStart(7))}  ${tag}  ${dim(when)}  ${who}`)
      console.log(`  ${" ".repeat(7)}          ${bold(String(m.subject ?? "").slice(0, 100))}`)
    }
    printDivider()
    if (rows.length >= Number(args.limit)) prompts.log.warn(`showing the newest ${args.limit} — raise --limit (max 200) or narrow --days to see the rest`)
    if (shown.some((m) => m.id == null)) prompts.log.warn("this Mac's daemon predates message ids — update it to read or reply by id")
    prompts.outro(`${rows.length} message(s): ${people} from people, ${rows.length - people} automated · read one: iris mail read <id>`)
  },
})

/**
 * Reply IN THE THREAD (#189480).
 *
 * `iris mail send` composes a new message, so a reply reached a recruiter as a separate email.
 * This asks the machine that holds the mailbox to build the reply with Mail's own `reply`
 * command from the original message — the only way Mail.app sets In-Reply-To / References.
 */
const MailReplyCommand = cmd({
  command: "reply <id>",
  describe: "reply to an email in its thread (id from `iris mail inbox`) — logged to the lead like send",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", demandOption: true, describe: "message id from `iris mail inbox` / `iris mail read`" })
      .option("body", { type: "string", alias: "b", demandOption: true })
      .option("all", { type: "boolean", default: false, describe: "reply to all recipients" })
      .option("draft", { type: "boolean", default: false, describe: "open the reply in Mail.app WITHOUT sending it" })
      .option("from", { type: "string", alias: "f", describe: "send as this Mail.app address (default: the account it arrived on)" })
      .option("lead", { type: "number", describe: "CRM lead this reply belongs to" })
      .option("force", { type: "boolean", default: false, describe: "reply to someone who is NOT a lead — recorded as unattributed" })
      .option("via", viaOption),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Reply — message ${args.id}`)
    const via = args.via as MailVia

    // Who it goes to, before anything is sent — the same refusal rules as `iris mail send`.
    const original = await mailCall({ fn: "read_email", method: "GET", path: "/api/mail/message", args: { id: args.id, max_body: 200 } }, via)
    if (!original.ok) {
      await reportAnswer("Reply", original)
      prompts.outro("Not sent")
      return
    }
    const to = String(original.data?.sender ?? "")
    prompts.log.info(`to ${original.data?.sender_name ? `${original.data.sender_name} <${to}>` : to} · ${bold(String(original.data?.subject ?? ""))}`)

    let leadId: number | undefined = args.lead != null ? Number(args.lead) : undefined
    if (leadId == null) {
      const resolution = await resolveLeadForHandle(to)
      if (resolution.reason === "ok") leadId = resolution.leadId
      else if (resolution.reason === "ambiguous") {
        prompts.log.error(`${to} matches ${resolution.matches.length} leads — say which with --lead <id>`)
        for (const m of resolution.matches) prompts.log.warn(`  --lead ${m.id}   ${m.name ?? "(no name)"}`)
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      } else if (!args.force && !args.draft) {
        prompts.log.error(`Refusing to send: no lead has the address ${to}.`)
        prompts.log.warn("Attach it with --lead <id>, reply unattributed with --force, or --draft to look first.")
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      }
    }

    const answer = await mailCall(
      {
        fn: "reply_email",
        method: "POST",
        path: "/api/mail/reply",
        args: { message_id: args.id, body_text: args.body, reply_all: args.all, draft: args.draft, ...(args.from ? { from_email: args.from } : {}) },
      },
      via,
    )
    if (!answer.ok) {
      await reportAnswer("Reply", answer)
      prompts.outro("Not sent")
      return
    }
    if (answer.where !== "this machine") prompts.log.info(dim(`via ${answer.where}`))
    if (answer.data?.mode === "draft") {
      prompts.outro(`${success("✓")} Reply opened in Mail.app on ${answer.where} — nothing sent`)
      return
    }

    const subject = `Re: ${String(original.data?.subject ?? "").replace(/^re:\s*/i, "")}`
    const logged = leadId
      ? await recordDirectSend({ toHandle: to, leadId, channel: "apple_mail", subject, message: args.body, origin: "cli.mail.reply" })
      : { ok: false as const, error: "replied with --force and no lead to attach it to" }
    if (logged.ok) prompts.log.info(`Recorded to comms${logged.commId ? ` as comm #${logged.commId}` : ""} on lead #${leadId}`)
    else {
      const spooled = await spoolUnlogged({
        at: new Date().toISOString(), channel: "apple_mail", to, subject, message: args.body, leadId,
        reason: logged.error ?? "unknown", origin: "cli.mail.reply",
      })
      prompts.log.warn(`not on a lead's record — ${logged.error}${spooled ? `; spooled for: iris mail audit` : ""}`)
    }
    prompts.outro(`${success("✓")} Replied in thread to ${to}`)
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
      })
      // WHO the message is for, stated rather than guessed. Required in effect: without it the
      // address must resolve to exactly one lead, and a tie is refused rather than broken.
      .option("lead", {
        type: "number",
        describe: "CRM lead id this send belongs to — required when the address is ambiguous",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "send to someone who is NOT a lead — recorded as unattributed, never silent",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Send Mail — to ${args.to}`)

    const bridge = await probeBridge()
    if (!bridge.ok) {
      prompts.log.error(bridge.message)
      prompts.outro("Done")
      return
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WHO IS THIS FOR — answered before anything is sent, and allowed to refuse.
    //
    // This used to be answered AFTER the send, separately, by whichever of two code paths the
    // flags happened to select, and both ended in an unordered first-match. On 2026-09-14 a
    // client email attached to a Stripe-created duplicate of the client and nothing warned
    // (#185438). Resolving here means the branch below cannot be wrong on its own: the router
    // is given to_lead_id so it never runs its own resolver, and the bridge path is given the
    // same id rather than looking one up.
    // ─────────────────────────────────────────────────────────────────────────
    let leadId: number | undefined
    let resolution: LeadResolution | undefined

    if (args.lead != null) {
      leadId = Number(args.lead)
    } else {
      resolution = await resolveLeadForHandle(args.to)

      if (resolution.reason === "ambiguous") {
        prompts.log.error(`${args.to} matches ${resolution.matches.length} leads — say which one with --lead <id>:`)
        for (const m of resolution.matches) {
          prompts.log.warn(`  --lead ${m.id}   ${m.name ?? "(no name)"}${m.source ? `  ·  from ${m.source}` : ""}`)
        }
        // --force does NOT break a tie. It means "not a lead at all"; guessing between two real
        // people is a different question and the operator is the only one who can answer it.
        prompts.log.info("--force does not resolve this: it is for recipients who are not leads.")
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      }

      if (resolution.reason === "ok") {
        leadId = resolution.leadId
      } else if (!args.force) {
        const why = resolution.reason === "none" ? `no lead has the address ${args.to}` : resolution.error
        prompts.log.error(`Refusing to send: ${why}.`)
        prompts.log.warn(`Attach it to a lead with --lead <id>, or send unattributed with --force.`)
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      }
    }

    if (!leadId && args.force) {
      prompts.log.warn("--force: sending with NO lead attribution. This will be spooled for `iris mail audit`.")
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
        // The id when we have it — this is what stops the API running its own
        // findDuplicate()->first(), which shares the exact defect this command just fixed.
        toLeadId: leadId,
        toHandle: leadId ? undefined : args.to,
        // LOAD-BEARING, and more so now that a lead id is sent. The router picks a channel from
        // the LEAD's own order when none is pinned, and a lead with a phone plans to imessage:
        // measured 2026-09-14, lead #10394 plans `imessage` with no channel and `apple_mail`
        // with this line. Remove it and `iris mail send` starts sending text messages.
        channel: "apple_mail",
        subject: args.subject,
        message: args.body,
        sender: args.sender,
        origin: "cli.reachr",
      })

      if (result.ok && result.sent) {
        prompts.log.info(describeSend(result))
        // "Sent" and "sent AND on the record" are different states, and the router can report the
        // first without the second. A send with no comm id is exactly what the sweeper exists for.
        if (!result.commId) {
          const spooled = await spoolUnlogged({
            at: new Date().toISOString(),
            channel: "apple_mail",
            to: args.to,
            subject: args.subject,
            message: args.body,
            leadId,
            reason: "router sent but returned no comm id",
            origin: "cli.mail.router",
          })
          prompts.log.error(`SENT BUT NOT LOGGED — spooled${spooled ? ` to ${spooled}` : ""}; run: iris mail audit`)
        }
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
        ? "Draft mode — composing direct via the bridge (nothing is sent, so nothing is logged)."
        : "Attachment/cc/from set — sending direct via the bridge (transport only; the send is recorded to comms afterwards).",
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

    // The bridge carried it; the ledger still has to hear about it. Only for a real send — a
    // draft has not gone anywhere, and logging one would put a message on a lead's record that
    // they never received.
    if (!drafted) {
      const logged = leadId
        ? await recordDirectSend({
            toHandle: args.to,
            leadId,
            channel: "apple_mail",
            subject: args.subject,
            message: args.body,
            origin: "cli.mail.direct",
          })
        : { ok: false as const, error: "sent with --force and no lead to attach it to" }

      if (logged.ok) {
        prompts.log.info(`Recorded to comms${logged.commId ? ` as comm #${logged.commId}` : ""} on lead #${leadId}`)
      } else {
        // Loud, with the reason, AND durable. Printing it was not enough: the line scrolls past
        // and the send is then missing from the ledger with nothing anywhere that remembers.
        const spooled = await spoolUnlogged({
          at: new Date().toISOString(),
          channel: "apple_mail",
          to: args.to,
          subject: args.subject,
          message: args.body,
          leadId,
          reason: logged.error ?? "unknown",
          origin: "cli.mail.direct",
        })
        prompts.log.error(`SENT BUT NOT LOGGED — ${logged.error}`)
        prompts.log.warn(spooled ? `Spooled to ${spooled} — recover it with: iris mail audit --backfill` : "Could not spool it either — record it by hand.")
      }
    }

    prompts.outro(
      drafted
        ? `${success("✓")} Draft opened in Mail.app for ${args.to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""} — nothing sent`
        : `${success("✓")} Email sent to ${args.to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}`,
    )
  },
})


/**
 * What went out that the ledger never heard about — and put it back.
 *
 * Every other check in this area answers "did THIS send get logged?", one send at a time, at the
 * moment it happens, in a line that scrolls past. None of them could answer the question that
 * actually matters after the fact: *how much have we sent that is not on anyone's record?* An
 * unknown gap in an audit trail is indistinguishable from no gap, and that is the state this
 * command ends.
 *
 * It reads the spool every failed send now writes. It is complete going forward and silent about
 * the past, which is honest — sends made before the spool existed left no trace to find, and a
 * sweep that implied otherwise would be the same false assurance in a new place.
 */
const MailAuditCommand = cmd({
  command: "audit",
  describe: "list sends that never reached the comms log — and backfill them",
  builder: (yargs) =>
    yargs
      .option("backfill", { type: "boolean", default: false, describe: "write the spooled sends to their leads and clear them" })
      .option("lead", { type: "number", describe: "attach every unattributed entry to this lead id" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const entries = await readUnlogged()

    if (args.json) {
      console.log(JSON.stringify({ ok: true, spool: unloggedSpoolPath(), count: entries.length, entries }, null, 2))
      return
    }

    UI.empty()
    prompts.intro("◈  Comms audit — sends with no ledger row")

    if (entries.length === 0) {
      prompts.log.info(`Nothing unlogged. Spool: ${unloggedSpoolPath()}`)
      prompts.outro("Clean")
      return
    }

    for (const e of entries) {
      const who = e.leadId ? `lead #${e.leadId}` : dim("UNATTRIBUTED")
      prompts.log.warn(`${e.at}  ${e.channel}  ${e.to}  ${who}`)
      prompts.log.info(`   subject: ${e.subject ?? "(none)"}`)
      prompts.log.info(`   why:     ${e.reason}`)
    }

    if (!args.backfill) {
      prompts.log.info(`${entries.length} unlogged send(s). Backfill with: iris mail audit --backfill${entries.some((e) => !e.leadId) ? " --lead <id>" : ""}`)
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const done: string[] = []
    let failed = 0

    for (const e of entries) {
      const target = e.leadId ?? (args.lead != null ? Number(args.lead) : undefined)
      if (!target) {
        // Refusing beats guessing — the entry stays in the spool where the next run will
        // surface it again, which is the correct behaviour for something nobody has placed.
        prompts.log.error(`  skipped ${e.to} @ ${e.at} — no lead. Re-run with --lead <id>.`)
        failed++
        continue
      }
      const r = await logComm({ leadId: target, channel: e.channel, subject: e.subject, message: e.message, sentAt: e.at })
      if (r.ok) {
        prompts.log.info(`  ✓ ${e.to} → lead #${target}${r.commId ? ` as comm #${r.commId}` : ""}`)
        done.push(e.at)
      } else {
        prompts.log.error(`  ✗ ${e.to} — ${r.error}`)
        failed++
      }
    }

    if (done.length) await clearUnlogged(done)
    prompts.outro(`${success("✓")} Backfilled ${done.length}${failed ? `, ${failed} still unlogged` : ""}`)
    if (failed) process.exitCode = 1
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

    const bridge = await probeBridge()
    if (!bridge.ok) {
      const msg = bridge.message
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg, state: bridge.state }))
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
      .command(MailInboxCommand)
      .command(MailReadCommand)
      .command(MailReplyCommand)
      .command(MailSendCommand)
      .command(MailAccountsCommand)
      .command(MailAuditCommand)
      .demandCommand(),
  async handler() {},
})
