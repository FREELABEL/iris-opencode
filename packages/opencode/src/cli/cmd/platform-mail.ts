import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, printKV, dim, bold, success, BRIDGE_URL, bridgeFetch, writeJson, irisFetch } from "./iris-api"
import { probeWithHeal, type BridgeProbe, type BridgeHealth } from "./bridge-health"
import { mailRows, mailSearchParams, describeMailQuery, bodyMissingNote } from "./mail-response"
import { auditSentMail, parseCcList, routedCcConfirmed, type SentAudit } from "./mail-audit"
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

const MailSearchCommand = cmd({
  command: "search [query]",
  aliases: ["find"],
  describe: "search Apple Mail by sender name/email, and/or subject (-s)",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", describe: "sender name or email substring (omit to search by -s subject only)" })
      .option("subject", { type: "string", alias: "s", describe: "filter by subject (alone: subject-only search)" })
      .option("thread", { type: "boolean", default: false, describe: "match the address as sender OR recipient — both directions of a conversation" })
      .option("days", { type: "number", default: 7, describe: "search last N days" })
      .option("limit", { type: "number", default: 10, describe: "max results" })
      .option("full", { type: "boolean", default: false, describe: "include full email body (up to 10000 chars)" })
      .option("max-body", { type: "number", default: 4000, describe: "max body chars (use with --full)" })
      .option("attachments", { type: "boolean", default: false, describe: "list attachments on each email" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Apple Mail Search")

    const bridge = await probeBridge()
    if (!bridge.ok) {
      prompts.log.error(bridge.message)
      prompts.outro("Done")
      return
    }

    const searchArgs = {
      query: args.query,
      subject: args.subject,
      days: args.days,
      limit: args.limit,
      full: args.full,
      maxBody: Number(args.maxBody ?? args["max-body"] ?? 4000),
      attachments: args.attachments,
      thread: args.thread,
    }
    const params = mailSearchParams(searchArgs)
    if ("error" in params) {
      prompts.log.error(params.error)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const res = await bridgeFetch(`/api/mail/search?${params}`)
    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error")
      await reportMailFailure("Mail search", err)
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    const messages: any[] = mailRows(data)

    if (args.json) {
      // --full in JSON: a row the bridge could not give a body for says why, instead of the key
      // silently being absent (#189941).
      await writeJson(args.full ? messages.map((m) => (bodyMissingNote(m) ? { ...m, body: m.body ?? null, body_note: bodyMissingNote(m) } : m)) : messages)
      prompts.outro("Done")
      return
    }

    if (messages.length === 0) {
      prompts.log.info(describeMailQuery(searchArgs))
      prompts.outro("Done")
      return
    }

    for (const msg of messages) {
      printDivider()
      printKV("Date", msg.date)
      printKV("From", msg.sender_name ? `${msg.sender_name} <${msg.sender}>` : msg.sender)
      if (args.thread && msg.direction) printKV("Direction", msg.direction)
      printKV("Subject", bold(msg.subject))
      if (args.full) {
        console.log()
        console.log(msg.body || dim(bodyMissingNote(msg) ?? ""))
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
  command: "read [query]",
  describe: "read the latest email from a sender, or matching -s subject (full body)",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", describe: "sender name or email (omit to match by -s subject only)" })
      .option("subject", { type: "string", alias: "s", describe: "filter by subject" })
      .option("days", { type: "number", default: 14, describe: "search last N days" })
      .option("max-body", { type: "number", default: 10000, describe: "max body chars" })
      .option("save-attachments", { type: "boolean", default: false, describe: "download attachments to temp dir" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Read Mail — ${args.query ? `from "${args.query}"` : `subject "${args.subject ?? ""}"`}`)

    const bridge = await probeBridge()
    if (!bridge.ok) {
      prompts.log.error(bridge.message)
      prompts.outro("Done")
      return
    }

    const saveAttachments = args.saveAttachments ?? args["save-attachments"] ?? false
    const params = mailSearchParams({
      query: args.query,
      subject: args.subject,
      days: args.days,
      limit: 1,
      full: true,
      maxBody: Number(args.maxBody ?? args["max-body"] ?? 10000),
      attachments: true,
    })
    if ("error" in params) {
      prompts.log.error(params.error)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    if (saveAttachments) params.set("save_attachments", "1")

    const res = await bridgeFetch(`/api/mail/search?${params}`)
    if (!res.ok) {
      await reportMailFailure("Mail read", await res.text().catch(() => "Unknown error"))
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    const messages: any[] = mailRows(data)

    if (messages.length === 0) {
      prompts.log.info(describeMailQuery({ query: args.query, subject: args.subject, days: args.days }))
      prompts.outro("Done")
      return
    }

    const msg = messages[0]

    if (args.json) {
      await writeJson(bodyMissingNote(msg) ? { ...msg, body: msg.body ?? null, body_note: bodyMissingNote(msg) } : msg)
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
    console.log(msg.body || dim(bodyMissingNote(msg) ?? "(no body)"))
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
      .option("cc", { type: "string", describe: "CC address(es), comma-separated — works with --sender (routed + logged once, cc in metadata)" })
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
    const ccParsed = parseCcList(args.cc)
    if ("error" in ccParsed) {
      prompts.log.error(ccParsed.error)
      prompts.outro("Not sent")
      process.exitCode = 1
      return
    }
    const cc = ccParsed.list
    // --draft joins this list because the comms router only knows how to SEND. Routing a draft
    // would either send it or drop the flag, and both are worse than saying which path was taken.
    // #189942: --cc no longer forces the direct path when --sender is given — refusing it is what
    // sent CC'd lead mail out of Mail.app by hand, where nothing logged it.
    const needsDirectBridge = Boolean(attachments.length || (cc.length && !args.sender) || args.from || args.draft)

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
        "--sender cannot be combined with --attachment/--draft: those take the direct bridge path, which does not read channel bindings.",
      )
      prompts.outro("Done")
      return
    }

    if (!needsDirectBridge && cc.length) {
      // Ask before sending: an API that predates cc would drop it and send anyway (#189942).
      const plan = await routerSend({
        toLeadId: leadId,
        toHandle: leadId ? undefined : args.to,
        channel: "apple_mail",
        subject: args.subject,
        message: args.body,
        sender: args.sender,
        cc,
        dryRun: true,
        origin: "cli.reachr",
      })
      if (!plan.ok || !routedCcConfirmed(plan.plan, cc)) {
        prompts.log.error(
          plan.ok
            ? "The comms API did not confirm it can CC on a routed send, so this was NOT sent (it would have gone out without the CC)."
            : `Router preflight failed: ${plan.error ?? "unknown"} — nothing sent.`,
        )
        prompts.log.info("Until the API supports it: send without --sender (`--cc` on the direct path is logged afterwards).")
        prompts.outro("Not sent")
        process.exitCode = 1
        return
      }
    }

    if (!needsDirectBridge) {
      const result = await routerSend({
        cc: cc.length ? cc : undefined,
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
        if (cc.length) {
          if (routedCcConfirmed(result, cc)) prompts.log.info(`CC: ${cc.join(", ")}`)
          else prompts.log.warn(`Sent, but the API did not confirm the CC (${cc.join(", ")}) — check the message in Mail's Sent folder.`)
        }
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
    if (cc.length) payload.cc_email = cc
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
            cc: cc.length ? cc : undefined,
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
  describe: "find sends that never reached the comms log (CLI spool + Mail's Sent, every account) — and backfill them",
  builder: (yargs) =>
    yargs
      .option("backfill", { type: "boolean", default: false, describe: "write the missing sends to their leads (spool entries are cleared)" })
      .option("dry-run", { type: "boolean", default: false, describe: "with --backfill: print what would be written, write nothing" })
      .option("lead", { type: "number", describe: "attach every unattributed SPOOL entry to this lead id" })
      .option("days", { type: "number", default: 14, describe: "how far back to reconcile Mail's sent messages" })
      .option("limit", { type: "number", default: 200, describe: "max sent messages to examine (newest first; the bridge caps at 200)" })
      .option("sent", { type: "boolean", default: true, describe: "reconcile Mail's sent messages against lead emails (--no-sent: spool only)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const entries = await readUnlogged()
    const days = Math.max(1, Math.min(365, Number(args.days) || 14))
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 200))
    const dryRun = !!((args as any)["dry-run"] ?? (args as any).dryRun)

    // #189942: the spool only sees sends the CLI made. Mail's own Sent is the ground truth.
    let sent: SentAudit | null = null
    if (args.sent !== false) {
      sent = await auditSentMail(
        { days, limit, includeBody: !!args.backfill },
        {
          bridge: (path) => bridgeFetch(path),
          resolveLead: async (addr) => {
            const r = await resolveLeadForHandle(addr)
            if (r.reason === "error") throw new Error(r.error)
            return r.matches.map((m) => m.id)
          },
          ledger: async (leadId, since) => {
            const res = await irisFetch(`/api/v1/atlas/comms?lead_id=${leadId}&direction=outbound&from=${encodeURIComponent(since)}&per_page=200`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const payload = (await res.json()) as any
            const rows = payload?.data?.data ?? payload?.data ?? []
            if (!Array.isArray(rows)) throw new Error("unrecognised comms response")
            return rows
          },
        },
      )
    }

    const sentFindings = sent?.unlogged ?? []
    const clean = entries.length === 0 && sentFindings.length === 0 && !sent?.error && !(sent?.ledgerErrors.length)

    if (args.json && !args.backfill) {
      console.log(JSON.stringify({ ok: true, clean, spool: unloggedSpoolPath(), count: entries.length, entries, sent }, null, 2))
      if (!clean) process.exitCode = 1
      return
    }

    UI.empty()
    prompts.intro("◈  Comms audit — sends with no ledger row")

    if (sent?.error) prompts.log.error(`Sent mail: ${sent.error}`)
    if (sent && !sent.error) {
      prompts.log.info(
        dim(
          `Sent mail: ${sent.scanned} message(s) in the last ${days} day(s) checked against leads + the ledger` +
            (sent.truncated ? ` — capped at ${limit}; older sends in the window were NOT checked (narrow --days)` : "") +
            (sent.unresolvedAddresses ? ` — ${sent.unresolvedAddresses} recipient address(es) not looked up (lookup cap)` : ""),
        ),
      )
      for (const e of sent.ledgerErrors) prompts.log.warn(`  ${e} — its sends were not judged either way`)
    }

    if (clean) {
      prompts.log.info(`Nothing unlogged. Spool: ${unloggedSpoolPath()}${sent ? " · Sent mail reconciled" : " · Sent mail NOT checked (--no-sent)"}`)
      prompts.outro("Clean")
      return
    }

    for (const e of entries) {
      const who = e.leadId ? `lead #${e.leadId}` : dim("UNATTRIBUTED")
      prompts.log.warn(`${e.at}  ${e.channel}  ${e.to}  ${who}  ${dim("(spool)")}`)
      prompts.log.info(`   subject: ${e.subject ?? "(none)"}`)
      prompts.log.info(`   why:     ${e.reason}`)
    }
    for (const m of sentFindings) {
      const who = m.leadIds.length ? m.leadIds.map((id) => `lead #${id}`).join(", ") : dim(`AMBIGUOUS (${m.ambiguous.join(", ")})`)
      prompts.log.warn(`${m.date}  apple_mail  ${[...m.to, ...m.cc.map((c) => `cc:${c}`)].join(" ")}  ${who}  ${dim("(sent from Mail, no ledger row)")}`)
      prompts.log.info(`   subject: ${m.subject || "(none)"}`)
    }

    if (!args.backfill) {
      const n = entries.length + sentFindings.length
      if (n) prompts.log.info(`${n} unlogged send(s). Backfill with: iris mail audit --backfill${entries.some((e) => !e.leadId) ? " --lead <id>" : ""} (add --dry-run to preview)`)
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
      if (dryRun) {
        prompts.log.info(`  would log ${e.to} → lead #${target}  ${dim(e.subject ?? "")}`)
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

    // Sent-from-Mail findings: ONE row per message, on the first lead it reached, with the other
    // recipients in metadata. message_group_id makes a re-run a no-op instead of a duplicate.
    let sentLogged = 0
    for (const m of sentFindings) {
      if (m.leadIds.length === 0) {
        prompts.log.error(`  skipped "${m.subject}" — ${m.ambiguous.join(", ")} match more than one lead; log it by hand with --lead`)
        failed++
        continue
      }
      const groupKey = (m.message_id ?? `${m.sender}_${m.date}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50)
      const payload = {
        lead_id: m.leadIds[0],
        channel: "apple_mail",
        direction: "outbound",
        body: m.body || m.subject || "(sent from Mail.app — body not available)",
        subject: m.subject || null,
        sent_at: m.date,
        from_identifier: m.sender,
        to_identifiers: [...m.to, ...m.cc],
        message_group_id: `mailaudit_${groupKey}`,
        metadata: {
          source: "mail_audit_backfill",
          to: m.to,
          cc: m.cc,
          also_leads: m.leadIds.slice(1),
          mail_message_id: m.message_id,
        },
      }
      if (dryRun) {
        prompts.log.info(`  would log "${m.subject}" (${m.date}) → lead #${payload.lead_id}${m.cc.length ? `  cc ${m.cc.join(", ")}` : ""}`)
        continue
      }
      try {
        const res = await irisFetch("/api/v1/atlas/comms/log", { method: "POST", body: JSON.stringify(payload) })
        if (!res.ok) throw new Error(`comms/log returned ${res.status}`)
        prompts.log.info(`  ✓ "${m.subject}" → lead #${payload.lead_id}`)
        sentLogged++
      } catch (e: any) {
        prompts.log.error(`  ✗ "${m.subject}" — ${e?.message ?? e}`)
        failed++
      }
    }

    if (done.length) await clearUnlogged(done)
    prompts.outro(
      dryRun
        ? "Dry run — nothing written"
        : `${success("✓")} Backfilled ${done.length + sentLogged}${failed ? `, ${failed} still unlogged` : ""}`,
    )
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
      .command(MailReadCommand)
      .command(MailSendCommand)
      .command(MailAccountsCommand)
      .command(MailAuditCommand)
      .demandCommand(),
  async handler() {},
})
