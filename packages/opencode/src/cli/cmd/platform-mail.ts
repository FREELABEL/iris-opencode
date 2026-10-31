import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, printKV, dim, bold, success, BRIDGE_URL, bridgeFetch, writeJson, irisFetch } from "./iris-api"
import { probeWithHeal, type BridgeProbe, type BridgeHealth } from "./bridge-health"
import { mailRows } from "./mail-response"
import { fetchDaemonPermissions, isTccDenial, renderTccBlindSpot } from "./daemon-permissions"
import {
  routerSend,
  describeSend,
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
import { newGroupId, buildLogPayloads, checkLogged } from "./comms-log-group"
import { mailResponsive, readSentMail, unloggedSent, type SentItem } from "./comms-mail-applescript"
import { gmailExec, lastGmailAccount, searchMessages } from "../lib/gmail"
import {
  composeOutgoing,
  isGmailId,
  normalizeMessageId,
  replyRecipients,
  splitAddresses,
  toBridgePayload,
  type MailEnvelope,
  type OutgoingMail,
} from "./mail-compose"
import {
  bridgeTransport,
  envelopeFromGmail,
  gmailReplyMismatch,
  gmailTransport,
  lookupOnMac,
  planLeads,
  planRefusal,
  sendAndLog,
  type LeadPlan,
  type Transport,
} from "./mail-send-flow"

// macOS Apple Mail integration via the IRIS Bridge (BRIDGE_URL, default localhost:3200)
// Bridge endpoint: GET /api/mail/search?from=X&subject=X&days=N&limit=N&include_body=1&max_body=N
// Bridge endpoint: POST /api/mail/send { to_email (string|string[]), cc_email, bcc_email, from_email, subject, body_text, attachments, draft, in_reply_to, reply_account, reply_mailbox }
// Bridge endpoint: GET /api/mail/message?id=<message-id>  ·  GET /api/mail/capabilities   (iris-daemon lib/mail-compose.js)

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
        // A message id is one Mac's own number and the Hive rail does not pin a node, so the second
        // call can land elsewhere. Only take the body if it is the same message.
        if (full.ok && full.data?.body && full.data.sender === msg.sender && full.data.subject === msg.subject) msg = { ...msg, body: full.data.body }
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
    if (shown.some((m) => m.id == null)) prompts.log.warn("this Mac's daemon predates message ids — update it to read by id")
    prompts.outro(`${rows.length} message(s): ${people} from people, ${rows.length - people} automated · read one: iris mail read <id>`)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// send / reply — several To, repeatable --cc/--bcc, a threaded reply, one log per lead (#191605)
// ─────────────────────────────────────────────────────────────────────────────

/** Flags shared by `mail send` and `mail reply`. */
export function mailComposeOptions(yargs: any) {
  return (
    yargs
      // Repeatable AND comma-separated, like --attachment. `--cc` was a single string, so whether
      // three CCs worked was a guess — and on 2026-10-28 the guess was "use osascript".
      .option("to", { type: "array", string: true, describe: "recipient (repeatable, or comma-separated)" })
      .option("cc", { type: "array", string: true, describe: "CC (repeatable, or comma-separated)" })
      .option("bcc", { type: "array", string: true, describe: "BCC (repeatable, or comma-separated)" })
      .option("from", { type: "string", alias: "f", describe: "sender email address (must be configured in Mail.app)" })
      .option("sender", {
        type: "string",
        describe: "send as a registered identity (a `iris senders` slug) — routed, verified, and logged",
      })
      .option("subject", { type: "string", alias: "s", describe: "subject (a reply defaults to Re: <original>)" })
      .option("body", { type: "string", alias: "b", demandOption: true })
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
        describe: "compose and open the message (Mail.app) or save a Gmail draft — WITHOUT sending",
      })
      .option("via", {
        type: "string",
        choices: ["apple_mail", "gmail"],
        default: "apple_mail",
        describe: "apple_mail = this Mac's Mail.app (via the IRIS bridge) · gmail = the connected Gmail, no Mac needed (reply or draft only)",
      })
      // WHO the message is for, stated rather than guessed. Every recipient is resolved; --lead
      // adds a lead and breaks a tie for an address it is among the candidates of.
      .option("lead", {
        type: "array",
        number: true,
        describe: "CRM lead id this send belongs to (repeatable) — required when an address matches several leads",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "send even when no recipient is a lead — recorded as unattributed, never silent",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "show the exact message (recipients, In-Reply-To) and which leads it would be logged to — send nothing",
      })
      .option("json", { type: "boolean", default: false })
  )
}

type ComposedArgs = {
  to: string[]
  cc: string[]
  bcc: string[]
  from?: string
  sender?: string
  subject?: string
  body: string
  attachments: string[]
  draft: boolean
  via: "apple_mail" | "gmail"
  leads: number[]
  force: boolean
  dryRun: boolean
  json: boolean
  replyTo?: string
  all: boolean
}

export function collectArgs(args: any, extra: { replyTo?: string; all?: boolean; positional?: unknown }): ComposedArgs {
  return {
    to: splitAddresses(extra.positional, args.to),
    cc: splitAddresses(args.cc),
    bcc: splitAddresses(args.bcc),
    from: args.from || undefined,
    sender: args.sender || undefined,
    subject: args.subject || undefined,
    body: String(args.body ?? ""),
    attachments: ((args.attachment as string[] | undefined) ?? []).filter(Boolean),
    draft: Boolean(args.draft),
    via: (args.via as "apple_mail" | "gmail") ?? "apple_mail",
    leads: ((args.lead as number[] | undefined) ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0),
    force: Boolean(args.force),
    dryRun: Boolean(args["dry-run"] ?? args.dryRun),
    json: Boolean(args.json),
    replyTo: extra.replyTo || undefined,
    all: Boolean(extra.all),
  }
}

/** The addresses this machine sends as — "yourself", removed from a reply-all. */
async function myAddresses(a: ComposedArgs): Promise<string[]> {
  const me: string[] = []
  if (a.from) me.push(a.from)
  try {
    const res = await bridgeFetch("/api/mail/accounts")
    if (res.ok) me.push(...(((await res.json()) as any)?.addresses ?? []))
  } catch {
    /* no bridge — the Gmail route still knows its own mailbox */
  }
  const g = lastGmailAccount()?.account
  if (g) me.push(g)
  return splitAddresses(me)
}

/** The message being answered, from wherever it can be read. */
async function findOriginal(id: string, via: ComposedArgs["via"]): Promise<MailEnvelope | { error: string }> {
  const viaGmailId = async (gid: string) => {
    const e = await gmailExec("get_email", { message_id: gid }).catch((err: any) => ({ __error: String(err?.message ?? err) }))
    if ((e as any)?.__error) return { error: (e as any).__error }
    const env = envelopeFromGmail((e as any)?.email ?? e)
    if (!env.gmail_id) env.gmail_id = gid
    return env
  }
  if (via === "gmail") {
    if (isGmailId(id)) return viaGmailId(id)
    // An RFC Message-ID: Gmail can search for it.
    const hits = await searchMessages("", `rfc822msgid:${normalizeMessageId(id)}`, 1).catch(() => [])
    if (!hits[0]?.id) return { error: `Gmail has no message with Message-ID <${normalizeMessageId(id)}>` }
    return viaGmailId(hits[0].id)
  }
  // Mail.app finds messages by RFC Message-ID. A Gmail id is turned into one through Gmail first.
  let rfc = id
  if (isGmailId(id)) {
    const g = await viaGmailId(id)
    if ("error" in g) return { error: `${id} looks like a Gmail id and Gmail could not read it: ${g.error}` }
    if (!g.message_id) return { error: `Gmail message ${id} has no Message-ID header` }
    rfc = g.message_id
  }
  const bridge = await probeBridge()
  if (!bridge.ok) return { error: bridge.message }
  return lookupOnMac(bridgeFetch as any, rfc)
}

function printOutgoing(m: OutgoingMail, via: string) {
  printDivider()
  printKV("Via", via === "gmail" ? "Gmail (server — no Mac needed)" : "Mail.app on this Mac (IRIS bridge)")
  if (m.from) printKV("From", m.from)
  printKV("To", m.to.join(", "))
  if (m.cc.length) printKV("Cc", m.cc.join(", "))
  if (m.bcc.length) printKV("Bcc", m.bcc.join(", "))
  printKV("Subject", bold(m.subject))
  if (m.headers["In-Reply-To"]) printKV("In-Reply-To", m.headers["In-Reply-To"])
  if (m.headers.References) printKV("References", m.headers.References)
  if (m.attachments.length) printKV("Attachments", m.attachments.join(", "))
}

function printPlan(plan: LeadPlan) {
  for (const l of plan.leads) console.log(`  ${success("●")} lead #${l.lead_id}${l.name ? ` ${l.name}` : ""}${l.email ? dim(`  ${l.email}`) : ""}`)
  for (const a of plan.nonLeads) console.log(`  ${dim("○")} ${a} ${dim("— not a lead; recorded on each copy")}`)
  for (const a of plan.ambiguous) console.log(`  ✗ ${a.address} ${dim(`— ${a.matches.length} leads: ${a.matches.map((x) => `#${x.id}`).join(", ")}`)}`)
  for (const u of plan.unresolved) console.log(`  ? ${u.address} ${dim(`— ${u.error}`)}`)
}

/**
 * The composed path: build the message, decide every lead, send, book. Used for anything the comms
 * router cannot carry — several To, CC/BCC, a reply, --from, attachments, a draft, the Gmail route.
 */
export async function runComposedSend(a: ComposedArgs): Promise<void> {
  const say = (fn: () => void) => {
    if (!a.json) fn()
  }
  const fail = async (msg: string, extra: Record<string, unknown> = {}) => {
    process.exitCode = 1
    if (a.json) return writeJson({ ok: false, sent: false, error: msg, ...extra })
    prompts.log.error(msg)
    prompts.outro("Not sent")
  }

  if (a.sender) {
    return fail("--sender cannot be combined with several recipients, --cc/--bcc, --reply-to, --from, --attachment, --draft or --via gmail: that path does not read channel bindings.")
  }

  let original: MailEnvelope | undefined
  let to = a.to
  let cc = a.cc
  if (a.replyTo) {
    const found = await findOriginal(a.replyTo, a.via)
    if ("error" in found) return fail(`Cannot reply to ${a.replyTo}: ${found.error}`)
    original = found
    const r = replyRecipients(found, await myAddresses(a), a.all)
    // With --all the original's people come first and anything typed is added; without it, a
    // typed --to replaces the default (the original sender).
    to = a.all ? splitAddresses(r.to, a.to) : a.to.length ? a.to : r.to
    cc = splitAddresses(r.cc, a.cc)
  }

  const composed = composeOutgoing({
    to,
    cc,
    bcc: a.bcc,
    from: a.from,
    subject: a.subject,
    body: a.body,
    attachments: a.attachments,
    draft: a.draft,
    original,
  })
  if (!composed.ok) return fail(composed.error)
  const m = composed.mail

  if (a.via === "gmail") {
    const mismatch = gmailReplyMismatch(m, original)
    if (mismatch) return fail(mismatch)
  }

  const plan = await planLeads(m, resolveLeadForHandle, a.leads)
  const refusal = planRefusal(plan, a.force)

  say(() => {
    printOutgoing(m, a.via)
    printDivider()
    printPlan(plan)
    printDivider()
  })

  if (a.dryRun) {
    if (a.json) return writeJson({ ok: !refusal, dry_run: true, message: m, bridge_payload: a.via === "apple_mail" ? toBridgePayload(m) : undefined, plan, refusal })
    if (refusal) prompts.log.warn(`Would refuse: ${refusal}`)
    prompts.outro(`Dry run — nothing sent, nothing logged`)
    return
  }
  if (refusal) return fail(`Refusing to send: ${refusal}`, { plan })

  if (!plan.leads.length) say(() => prompts.log.warn("--force: no recipient is a lead. The send will be spooled for `iris mail audit`."))

  let transport: Transport
  if (a.via === "gmail") {
    transport = gmailTransport(gmailExec)
  } else {
    const bridge = await probeBridge()
    if (!bridge.ok) return fail(bridge.message)
    transport = bridgeTransport(bridgeFetch as any)
  }

  const report = await sendAndLog(m, plan, {
    transport,
    groupId: newGroupId(),
    now: () => new Date().toISOString(),
    origin: a.replyTo ? "iris mail reply" : "iris mail send",
    log: {
      post: async (body) => {
        const res = await irisFetch("/api/v1/atlas/comms/log", { method: "POST", body: JSON.stringify(body) })
        return { status: res.status, payload: await res.json().catch(() => null) }
      },
      spool: spoolUnlogged,
    },
  })

  if (a.json) {
    if (!report.sent && !report.drafted) process.exitCode = 1
    if (report.spooled.length) process.exitCode = 1
    return writeJson({ ok: (report.sent || report.drafted) && !report.spooled.length, message: m, plan, ...report })
  }

  if (!report.sent && !report.drafted) {
    process.exitCode = 1
    // Mail.app's Full Disk Access / Automation refusals get the one-command fix, not the raw 503.
    if (a.via === "apple_mail") await reportMailFailure("Send", report.error ?? "unknown error")
    else prompts.log.error(`Send failed: ${report.error}`)
    prompts.outro("Not sent")
    return
  }
  if (report.drafted) {
    prompts.outro(`${success("✓")} Draft ${a.via === "gmail" ? "saved in Gmail" : "opened in Mail.app"} — nothing sent, nothing logged`)
    return
  }
  for (const r of report.results) {
    const label = `#${r.lead_id}${r.name ? " " + r.name : ""}`
    if (r.outcome === "logged") console.log(`  ✓ logged to ${label}`)
    else if (r.outcome === "already") console.log(`  = ${label} ${dim("— already logged")}`)
    else console.log(`  ✗ ${label} — NOT logged: ${r.error}`)
  }
  if (report.spooled.length) {
    prompts.log.error(`SENT BUT NOT LOGGED for ${report.spooled.length} copy/copies — spooled; recover with: iris mail audit --backfill`)
    process.exitCode = 1
  }
  if (report.results.length > 1) console.log(dim(`  message group ${report.groupId} — add someone later with: iris comms log <lead> --group ${report.groupId} …`))
  const n = m.to.length + m.cc.length + m.bcc.length
  prompts.outro(`${success("✓")} ${original ? "Reply" : "Email"} sent to ${n} recipient${n === 1 ? "" : "s"}${m.headers["In-Reply-To"] ? ` in-thread (${m.headers["In-Reply-To"]})` : ""}`)
}

const MailSendCommand = cmd({
  command: "send [recipients..]",
  describe: "send an email (several To, --cc/--bcc, --reply-to for a threaded reply) — logged to every lead on it",
  builder: (yargs) =>
    mailComposeOptions(
      yargs.positional("recipients", { type: "string", array: true, describe: "recipient email(s) — same as --to" }),
    )
      .option("reply-to", {
        type: "string",
        describe: "answer this message in its thread: an RFC Message-ID (<…@…>) or a Gmail message id",
      })
      .option("all", { type: "boolean", default: false, describe: "with --reply-to: also send to the original's To and CC (minus yourself)" })
      .example("iris mail send a@x.com --to b@x.com --cc c@x.com --cc d@x.com -s Hi -b …", "two To, two CC")
      .example("iris mail send --reply-to '<CAF…@mail.gmail.com>' --all -b …", "reply-all in the thread")
      .example("iris mail send a@x.com -s Hi -b … --dry-run", "show the message and the leads; send nothing"),
  async handler(args) {
    const a = collectArgs(args, { positional: args.recipients, replyTo: (args as any)["reply-to"], all: (args as any).all })
    if (!a.json) {
      UI.empty()
      prompts.intro(`◈  Send Mail${a.to.length ? ` — to ${a.to.join(", ")}` : ""}`)
    }

    if (!a.subject && !a.replyTo) {
      process.exitCode = 1
      if (a.json) return writeJson({ ok: false, error: "--subject is required (a reply defaults it)" })
      prompts.log.error("--subject is required (a reply with --reply-to defaults it to Re: <original>).")
      prompts.outro("Not sent")
      return
    }
    if (!a.to.length && !a.replyTo) {
      process.exitCode = 1
      if (a.json) return writeJson({ ok: false, error: "no recipient" })
      prompts.log.error("No recipient: give an address, --to, or --reply-to <message-id>.")
      prompts.outro("Not sent")
      return
    }

    // Anything the comms router cannot carry takes the composed path, which sends through the
    // bridge (or Gmail) and books every lead itself. Silently dropping a field would be worse
    // than not routing: it would send a different email than the operator asked for.
    const composed =
      a.to.length !== 1 || a.cc.length || a.bcc.length || a.replyTo || a.from || a.attachments.length || a.draft || a.via !== "apple_mail" || a.dryRun || a.json || a.leads.length > 1
    if (composed) return runComposedSend(a)

    // ── The one-To path: through the comms router (CR-8), exactly as before. ──
    const toAddr = a.to[0]
    const bridge = await probeBridge()
    if (!bridge.ok) {
      prompts.log.error(bridge.message)
      prompts.outro("Done")
      return
    }

    // WHO IS THIS FOR — answered before anything is sent, and allowed to refuse (#185438). The
    // router is given to_lead_id so it never runs its own first-match resolver.
    let leadId: number | undefined
    if (a.leads.length === 1) {
      leadId = a.leads[0]
    } else {
      const resolution: LeadResolution = await resolveLeadForHandle(toAddr)
      if (resolution.reason === "ambiguous") {
        prompts.log.error(`${toAddr} matches ${resolution.matches.length} leads — say which one with --lead <id>:`)
        for (const m of resolution.matches) {
          prompts.log.warn(`  --lead ${m.id}   ${m.name ?? "(no name)"}${m.source ? `  ·  from ${m.source}` : ""}`)
        }
        // --force does NOT break a tie. It means "not a lead at all".
        prompts.log.info("--force does not resolve this: it is for recipients who are not leads.")
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      }
      if (resolution.reason === "ok") {
        leadId = resolution.leadId
      } else if (!a.force) {
        const why = resolution.reason === "none" ? `no lead has the address ${toAddr}` : resolution.error
        prompts.log.error(`Refusing to send: ${why}.`)
        prompts.log.warn(`Attach it to a lead with --lead <id>, or send unattributed with --force.`)
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      }
    }

    if (!leadId && a.force) {
      prompts.log.warn("--force: sending with NO lead attribution. This will be spooled for `iris mail audit`.")
    }

    const result = await routerSend({
      toLeadId: leadId,
      toHandle: leadId ? undefined : toAddr,
      // LOAD-BEARING. The router picks a channel from the LEAD's own order when none is pinned,
      // and a lead with a phone plans to imessage (measured 2026-09-14, lead #10394). Remove it
      // and `iris mail send` starts sending text messages.
      channel: "apple_mail",
      subject: a.subject,
      message: a.body,
      sender: a.sender,
      origin: "cli.reachr",
    })

    if (result.ok && result.sent) {
      prompts.log.info(describeSend(result))
      if (!result.commId) {
        const spooled = await spoolUnlogged({
          at: new Date().toISOString(),
          channel: "apple_mail",
          to: toAddr,
          subject: a.subject,
          message: a.body,
          leadId,
          reason: "router sent but returned no comm id",
          origin: "cli.mail.router",
        })
        prompts.log.error(`SENT BUT NOT LOGGED — spooled${spooled ? ` to ${spooled}` : ""}; run: iris mail audit`)
      }
      prompts.outro(`${success("✓")} Email sent to ${toAddr}`)
      return
    }

    // A router failure is reported, not silently retried through the bridge.
    prompts.log.error(`Router send failed: ${result.error ?? "unknown"}`)
    prompts.outro("Done")
  },
})

/**
 * `iris mail reply <id> --all -b "…"` — the shortcut. Reads the original, answers in its thread,
 * and with --all sends to everyone on it except you. Same flags, same logging as `mail send`.
 */
const MailReplyCommand = cmd({
  command: "reply <id>",
  describe: "reply in-thread to one message (--all: everyone on it, minus you) — logged to every lead on it",
  builder: (yargs) =>
    mailComposeOptions(
      yargs.positional("id", { type: "string", demandOption: true, describe: "the message: an RFC Message-ID (<…@…>) or a Gmail message id" }),
    )
      .option("all", { type: "boolean", default: false, describe: "reply to all: the original's From/Reply-To, To and CC, minus yourself" })
      .example("iris mail reply '<CAF…@mail.gmail.com>' --all -b 'Thanks — see you Thursday.' --dry-run", "check who it goes to first")
      .example("iris mail reply 18c2f0a1b2c3d4e5 --all -b '…' --via gmail", "Gmail route, no Mac needed"),
  async handler(args) {
    const a = collectArgs(args, { replyTo: String(args.id), all: Boolean((args as any).all) })
    if (!a.json) {
      UI.empty()
      prompts.intro(`◈  Reply${a.all ? " all" : ""} — ${a.replyTo}`)
    }
    return runComposedSend(a)
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
      // The spool only knows sends that went through `iris mail send`. A raw osascript send never
      // touched it (#191605). Sent Mail is the record every send leaves, however it was made.
      .option("sent", { type: "boolean", default: false, describe: "also check this Mac's Sent Mail against every lead's record — catches sends that skipped the router" })
      .option("account", { type: "string", describe: "with --sent: the Mail.app account to read (one account, never the unified mailbox)" })
      .option("days", { type: "number", default: 2, describe: "with --sent: how far back to read" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (args.sent) return auditSentMail(args as any)
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

/** `iris mail audit --sent`: what this Mac sent to leads that is on nobody's record. */
async function auditSentMail(args: { account?: string; days: number; backfill: boolean; json: boolean }): Promise<void> {
  const out = (o: unknown) => writeJson(o)
  if (!args.account) {
    process.exitCode = 64
    const msg = "--sent needs --account <Mail.app account name> (see: iris mail accounts) — one account, never the unified mailbox"
    return args.json ? out({ ok: false, error: msg }) : void prompts.log.error(msg)
  }
  if (!args.json) {
    UI.empty()
    prompts.intro(`◈  Comms audit — Sent Mail in "${args.account}", last ${args.days} day(s)`)
  }
  if (!(await mailResponsive())) {
    process.exitCode = 1
    const msg = "Mail.app is not answering — not adding work to its queue. Try again when it is idle."
    return args.json ? out({ ok: false, error: msg }) : void prompts.log.error(msg)
  }
  const read = await readSentMail(args.account, args.days, args.backfill)
  if (!read.ok) {
    process.exitCode = 1
    return args.json ? out({ ok: false, error: read.reason }) : void prompts.log.error(read.reason)
  }
  const sent = read.items as SentItem[]

  // Every address once, exact match only; a tie is reported, never guessed.
  const leadByAddress = new Map<string, number | null>()
  const ties: string[] = []
  for (const a of splitAddresses(sent.flatMap((i) => [...i.to, ...i.cc, ...i.bcc]))) {
    const r = await resolveLeadForHandle(a)
    leadByAddress.set(a.toLowerCase(), r.reason === "ok" ? (r.leadId ?? null) : null)
    if (r.reason === "ambiguous") ties.push(a)
  }
  const ledger = new Map<number, any[]>()
  for (const id of new Set([...leadByAddress.values()].filter((x): x is number => typeof x === "number"))) {
    const r = await irisFetch(`/api/v1/atlas/comms?${new URLSearchParams({ lead_id: String(id), per_page: "500" })}`).catch(() => null)
    const d = r?.ok ? ((await r.json().catch(() => null)) as any) : null
    if (!d) {
      process.exitCode = 1
      const msg = `could not read lead #${id}'s comms — cannot tell what is missing, so nothing is reported as missing or written`
      return args.json ? out({ ok: false, error: msg }) : void prompts.log.error(msg)
    }
    ledger.set(id, Array.isArray(d?.data?.data) ? d.data.data : Array.isArray(d?.data) ? d.data : [])
  }

  const gaps = unloggedSent(sent, (a) => leadByAddress.get(a), (id) => ledger.get(id) ?? [])
  if (args.json && !args.backfill) {
    if (gaps.length) process.exitCode = 1
    return out({ ok: true, account: args.account, days: args.days, scanned: sent.length, ambiguous: ties, unlogged: gaps })
  }
  if (!args.json) {
    for (const t of ties) prompts.log.warn(`${t} matches several leads — not checked; log it by hand with iris comms log`)
    if (!gaps.length) {
      prompts.outro(`Clean — ${sent.length} sent message(s), every one to a lead is on that lead's record`)
      return
    }
    for (const g of gaps) {
      prompts.log.warn(`${g.item.sent_at}  ${g.item.subject}`)
      prompts.log.info(`   to: ${[...g.item.to, ...g.item.cc].join(", ")}`)
      prompts.log.info(`   missing on: ${g.missing.map((id) => `#${id}`).join(", ")}${g.logged.length ? dim(`  (already on ${g.logged.map((id) => `#${id}`).join(", ")})`) : ""}`)
    }
  }
  if (!args.backfill) {
    process.exitCode = 1
    if (!args.json) prompts.outro(`${gaps.length} sent message(s) missing from a lead's record. Write them with: iris mail audit --sent --account "${args.account}" --backfill`)
    return
  }

  let written = 0
  let failed = 0
  for (const g of gaps) {
    const everyone = splitAddresses(g.item.to, g.item.cc, g.item.bcc)
    const recipients = g.missing.map((id) => ({ lead_id: id, name: null, email: everyone.find((a) => leadByAddress.get(a.toLowerCase()) === id) ?? null }))
    const payloads = buildLogPayloads(recipients, {
      channel: "apple_mail",
      direction: "outbound",
      body: g.item.body || "(recovered from Sent Mail by iris mail audit --sent)",
      subject: g.item.subject,
      sentAt: g.item.sent_at,
      groupId: newGroupId(),
      cc: everyone.filter((a) => leadByAddress.get(a.toLowerCase()) == null),
      toIdentifiers: g.item.to,
      loggedVia: "iris mail audit --sent",
      metadata: { external_message_id: g.item.external_message_id, to: g.item.to, cc_all: g.item.cc },
    })
    for (const body of payloads) {
      const res = await irisFetch("/api/v1/atlas/comms/log", { method: "POST", body: JSON.stringify(body) }).catch(() => null)
      const payload = res ? ((await res.json().catch(() => null)) as any) : null
      const outcome = checkLogged(body.lead_id, res?.status ?? 0, payload?.data?.record ?? payload?.data)
      if (outcome === "logged" || outcome === "already") written++
      else failed++
    }
  }
  if (failed) process.exitCode = 1
  if (args.json) return out({ ok: failed === 0, written, failed, unlogged: gaps })
  prompts.outro(`${success("✓")} Backfilled ${written} cop${written === 1 ? "y" : "ies"}${failed ? `, ${failed} failed` : ""}`)
}

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
      .command(MailSendCommand)
      .command(MailReplyCommand)
      .command(MailAccountsCommand)
      .command(MailAuditCommand)
      .demandCommand(),
  async handler() {},
})
