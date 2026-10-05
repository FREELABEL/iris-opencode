import { readFileSync, existsSync } from "fs"
import { basename } from "path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, warn, writeJson, IRIS_API } from "./iris-api"
import {
  buildRecipientList,
  checkMode,
  effectiveStatus,
  flattenToArgs,
  parseRecipientFile,
  statusTotals,
  statusVerdict,
  testSubject,
  DELIVERY_BAD,
  sendLabel,
  type Skipped,
  type StatusMessage,
} from "./email-send"

// `iris email` — the CLI half of fl-iris-api's per-recipient sender (epic #187455).
// Server: routes/api.php prefix v1/email → Api\EmailController → Services\Email\EmailSender.
// Templates are versioned on a board; a send is one message per recipient, one row each.

const PROVIDERS = ["mailjet", "resend"] as const

function bloqOf(args: any): number {
  const n = Number(args.bloq)
  if (!Number.isInteger(n) || n <= 0) {
    prompts.log.error("--bloq <id> is required (the board the templates live on).")
    process.exit(1)
  }
  return n
}

async function body(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}

/** Refusals from EmailSender come back as 422 {message, reason, invalid?}. Show all of it. */
async function reportRefusal(res: Response, json: boolean): Promise<boolean> {
  if (res.status !== 422) return false
  const b = await body(res)
  const msg = b?.message || "The server refused the send."
  if (json) {
    await writeJson({ success: false, error: msg, reason: b?.reason, invalid: b?.invalid, errors: b?.errors })
  } else {
    prompts.log.error(msg + (b?.reason ? dim(`  (${b.reason})`) : ""))
    for (const bad of b?.invalid ?? []) console.log(`  ${dim("invalid:")} ${bad}`)
    for (const [k, v] of Object.entries(b?.errors ?? {})) console.log(`  ${dim(k + ":")} ${(v as string[]).join(", ")}`)
  }
  process.exitCode = 1
  return true
}

function fmtTime(s?: string | null): string {
  if (!s) return "—"
  const d = new Date(s)
  return isNaN(d.getTime()) ? String(s) : d.toISOString().replace("T", " ").slice(0, 16)
}

// ── templates ─────────────────────────────────────────────────────────────

const TemplatesListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list the email templates on a board (newest version of each)",
  builder: (y) =>
    y
      .option("bloq", { type: "number", describe: "board id", demandOption: true })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const bloq = bloqOf(args)
    const res = await irisFetch(`/api/v1/email/bloqs/${bloq}/templates`, {}, IRIS_API)
    if (!(await handleApiError(res, "list email templates"))) return
    const rows: any[] = (await body(res))?.data ?? []
    if (args.json) return writeJson({ success: true, bloq, templates: rows })
    if (!rows.length) {
      prompts.log.info(`No email templates on board ${bloq}. Add one: iris email templates push <slug> --bloq ${bloq} --file email.html --subject "…"`)
      return
    }
    printDivider()
    for (const t of rows) {
      console.log(`  ${bold(t.slug)} ${dim(`v${t.version}`)}  ${t.subject ?? ""}`)
      console.log(`    ${dim(`from: ${t.from_email ? `${t.from_name ? t.from_name + " " : ""}<${t.from_email}>` : "— (set per send with --from)"} · ${fmtTime(t.created_at)}`)}`)
    }
    printDivider()
    console.log(dim(`  ${rows.length} template${rows.length === 1 ? "" : "s"} on board ${bloq}`))
  },
})

const TemplatesShowCommand = cmd({
  command: "show <slug>",
  describe: "show the newest version of an email template (subject, sender, body size)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("bloq", { type: "number", describe: "board id", demandOption: true })
      .option("html", { type: "boolean", default: false, describe: "print the full HTML body" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const bloq = bloqOf(args)
    const res = await irisFetch(`/api/v1/email/bloqs/${bloq}/templates/${encodeURIComponent(String(args.slug))}`, {}, IRIS_API)
    if (!(await handleApiError(res, "show email template"))) return
    const t = (await body(res))?.data ?? {}
    if (args.json) return writeJson({ success: true, template: t })
    printDivider()
    printKV("Template", `${t.slug} v${t.version}`)
    printKV("Name", t.name)
    printKV("Subject", t.subject)
    printKV("From", t.from_email ? `${t.from_name ? t.from_name + " " : ""}<${t.from_email}>` : "— (set per send with --from)")
    printKV("HTML", `${String(t.html ?? "").length.toLocaleString()} chars · sha256 ${String(t.html_sha256 ?? "").slice(0, 12)}`)
    printKV("Text", t.text ? `${String(t.text).length.toLocaleString()} chars` : "— (none)")
    printKV("Saved", fmtTime(t.created_at))
    if (args.html) {
      printDivider()
      console.log(t.html ?? "")
    }
    printDivider()
  },
})

const TemplatesPushCommand = cmd({
  command: "push <slug>",
  describe: "save an HTML email (newsletter) as a new template version on a board — identical content is not re-versioned",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true, describe: "lowercase letters, digits, dashes" })
      .option("bloq", { type: "number", describe: "board id", demandOption: true })
      .option("file", { type: "string", describe: "HTML file", demandOption: true })
      .option("subject", { type: "string", describe: "subject line (defaults to the current version's)" })
      .option("text-file", { type: "string", describe: "plain-text alternative body" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const bloq = bloqOf(args)
    const slug = String(args.slug)
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
      prompts.log.error(`"${slug}" is not a valid slug — use lowercase letters, digits and dashes.`)
      process.exitCode = 1
      return
    }
    const file = String(args.file)
    if (!existsSync(file)) {
      prompts.log.error(`No such file: ${file}`)
      process.exitCode = 1
      return
    }
    const html = readFileSync(file, "utf8")
    const textFile = args["text-file"] as string | undefined
    if (textFile && !existsSync(textFile)) {
      prompts.log.error(`No such file: ${textFile}`)
      process.exitCode = 1
      return
    }
    const text = textFile ? readFileSync(textFile, "utf8") : undefined

    // The server requires a subject on every version. Carry the current version's subject and
    // sender forward when not given, so a body-only edit does not wipe them.
    const curRes = await irisFetch(`/api/v1/email/bloqs/${bloq}/templates/${encodeURIComponent(slug)}`, {}, IRIS_API)
    const cur = curRes.ok ? (await body(curRes))?.data : null
    const subject = (args.subject as string | undefined) ?? cur?.subject
    if (!subject) {
      prompts.log.error(`"${slug}" is a new template — give it a subject: --subject "…"`)
      process.exitCode = 1
      return
    }

    const payload: Record<string, unknown> = {
      slug,
      subject,
      html,
      ...(text !== undefined ? { text } : cur?.text ? { text: cur.text } : {}),
      ...(cur?.name ? { name: cur.name } : {}),
      ...(cur?.from_email ? { from_email: cur.from_email } : {}),
      ...(cur?.from_name ? { from_name: cur.from_name } : {}),
    }
    const res = await irisFetch(`/api/v1/email/bloqs/${bloq}/templates`, { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
    if (!(await handleApiError(res, "save email template"))) return
    const b = await body(res)
    if (args.json) return writeJson({ success: true, created: b?.created, message: b?.message, template: b?.data })
    const t = b?.data ?? {}
    prompts.log.success(`${b?.created ? success("Saved") : "Unchanged"} — ${bold(`${t.slug} v${t.version}`)} on board ${bloq}`)
    printKV("Subject", t.subject)
    printKV("File", `${basename(file)} · ${html.length.toLocaleString()} chars`)
    console.log(dim(`  Test it: iris email send ${slug} --bloq ${bloq} --provider mailjet --from you@yourdomain --to you@yourdomain --test`))
  },
})

const TemplatesCommand = cmd({
  command: "templates",
  aliases: ["template", "tpl"],
  describe: "versioned email templates on a board — list, push, show",
  builder: (y) => y.command(TemplatesListCommand).command(TemplatesPushCommand).command(TemplatesShowCommand).demandCommand(),
  async handler() {},
})

// ── send ──────────────────────────────────────────────────────────────────

function printSkipped(skipped: Skipped[]): void {
  if (!skipped.length) return
  console.log(`  ${warn(`Skipped ${skipped.length}:`)}`)
  for (const s of skipped.slice(0, 50)) {
    const why = s.reason === "invalid" ? "not a valid address" : s.reason === "duplicate" ? "duplicate" : "blank"
    console.log(`    ${s.line !== undefined ? dim(`line ${s.line}  `) : ""}${s.input === "" ? dim("(empty)") : s.input}  ${dim("— " + why)}`)
  }
  if (skipped.length > 50) console.log(dim(`    … and ${skipped.length - 50} more`))
}

const SendCommand = cmd({
  command: "send <slug>",
  describe:
    "send a template (newsletter, announcement) to a list — one message per recipient, every attempt logged. --test first, then --live --confirm-count N",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true, describe: "template slug" })
      .option("bloq", { type: "number", describe: "board id", demandOption: true })
      .option("provider", { type: "string", choices: [...PROVIDERS], describe: "email provider connection to send through", demandOption: true })
      .option("from", { type: "string", describe: "From address (must be a sender verified at the provider)", demandOption: true })
      .option("from-name", { type: "string", describe: "From display name" })
      .option("reply-to", { type: "string", describe: "Reply-To address (refused until the server supports it)" })
      .option("to", { type: "string", array: true, describe: "recipient (repeat, or comma-separate)" })
      .option("to-file", { type: "string", describe: "recipient file: one address per line, or a CSV with an \"email\" column" })
      .option("test", { type: "boolean", describe: "test send: subject prefixed [TEST], at most 10 recipients" })
      .option("live", { type: "boolean", describe: "real send — requires --confirm-count" })
      .option("confirm-count", { type: "number", describe: "with --live: the number of unique valid recipients you expect to mail" })
      .option("subject", { type: "string", describe: "override the template subject for this send" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    const json = !!args.json
    const slug = String(args.slug)

    // 1. The list — accounted for before anything else happens.
    const inputs: Array<{ value: string; line?: number }> = flattenToArgs(args.to).map((v) => ({ value: v }))
    const toFile = args["to-file"] as string | undefined
    if (toFile) {
      if (!existsSync(toFile)) {
        prompts.log.error(`No such file: ${toFile}`)
        process.exitCode = 1
        return
      }
      const parsed = parseRecipientFile(readFileSync(toFile, "utf8"), toFile)
      if (parsed.error) {
        prompts.log.error(`${toFile}: ${parsed.error}`)
        process.exitCode = 1
        return
      }
      inputs.push(...parsed.entries)
    }
    if (!inputs.length) {
      prompts.log.error("No recipients — pass --to <addr> (repeatable) or --to-file <list.txt|members.csv>.")
      process.exitCode = 1
      return
    }
    const list = buildRecipientList(inputs)
    const mode = checkMode({
      test: !!args.test,
      live: !!args.live,
      confirmCount: args["confirm-count"] as number | undefined,
      unique: list.recipients.length,
    })

    if (!json) {
      printDivider()
      console.log(
        `  ${bold(`${list.recipients.length} recipient${list.recipients.length === 1 ? "" : "s"}`)} ${dim(`(unique, valid) from ${inputs.length} input${inputs.length === 1 ? "" : "s"}`)}`,
      )
      printSkipped(list.skipped)
      printDivider()
    }

    const refuse = async (error: string) => {
      if (json) await writeJson({ success: false, error, recipients: list.recipients.length, skipped: list.skipped })
      else prompts.log.error(error)
      process.exitCode = 1
    }
    if (!mode.ok) return refuse(mode.error)
    if (args["reply-to"])
      return refuse(`--reply-to ${args["reply-to"]}: the server does not set Reply-To yet, so it would be silently dropped. Nothing was sent.`)

    if (!(await requireAuth())) return
    const bloq = bloqOf(args)

    // 2. Send. A test runs inline on the server; a live list is queued and polled.
    const payload = {
      template: slug,
      mode: mode.mode,
      recipients: list.recipients,
      provider: args.provider,
      from_email: args.from,
      ...(args["from-name"] ? { from_name: args["from-name"] } : {}),
      ...(args.subject ? { subject: mode.mode === "test" ? testSubject(String(args.subject)) : args.subject } : {}),
      ...(mode.mode === "live" ? { confirm_count: args["confirm-count"] } : {}),
    }
    const spinner = json ? null : prompts.spinner()
    spinner?.start(mode.mode === "test" ? `Sending test to ${list.recipients.length}…` : `Queuing live send to ${list.recipients.length}…`)
    const res = await irisFetch(`/api/v1/email/bloqs/${bloq}/sends`, { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
    if (!res.ok) {
      spinner?.stop("Refused", 1)
      if (await reportRefusal(res, json)) return
      await handleApiError(res, "send email")
      process.exitCode = 1
      return
    }
    let run = (await body(res))?.data ?? {}
    const runId = run.id

    // A queued live run: wait for the worker, so the exit code reflects what happened.
    const deadline = Date.now() + 15 * 60_000
    while ((run.status === "queued" || run.status === "running") && Date.now() < deadline) {
      spinner?.message(`Run #${runId} ${run.status} — ${run.sent_count ?? 0} accepted, ${run.failed_count ?? 0} failed of ${run.recipient_count}`)
      await new Promise((r) => setTimeout(r, 3000))
      const p = await irisFetch(`/api/v1/email/sends/${runId}`, {}, IRIS_API)
      if (p.ok) run = (await body(p))?.data ?? run
    }
    spinner?.stop(`Run #${runId} ${run.status}`)

    const messages: StatusMessage[] = run.messages ?? []
    const sent = Number(run.sent_count ?? messages.filter((m) => m.status === "sent").length)
    const failed = Number(run.failed_count ?? messages.filter((m) => m.status === "failed").length)
    const unfinished = run.status === "queued" || run.status === "running"
    const ok = !unfinished && sent > 0 && failed === 0

    if (json) {
      await writeJson({
        success: ok,
        run_id: runId,
        status: run.status,
        mode: run.mode,
        provider: run.provider,
        subject: run.subject,
        recipients: run.recipient_count,
        accepted: sent,
        failed,
        skipped: list.skipped,
        note: "accepted = the provider accepted the message; delivery is checked with: iris email status " + runId + " --refresh",
        messages,
      })
      if (!ok) process.exitCode = 1
      return
    }

    printKV("Run", `#${runId}`)
    printKV("Mode", run.mode === "test" ? "test" : warn("LIVE"))
    printKV("Provider", run.provider)
    printKV("Subject", run.subject)
    printKV("From", `${run.from_name ? run.from_name + " " : ""}<${run.from_email}>`)
    for (const m of messages.filter((m) => m.status === "failed").slice(0, 25))
      console.log(`  ${warn("✗")} ${m.email}  ${dim(m.error ?? "")}`)
    if (run.error && failed) console.log(`  ${dim(run.error)}`)
    printDivider()
    console.log(`  ${bold(`${sent} accepted`)} · ${failed ? warn(`${failed} failed`) : "0 failed"} · ${run.recipient_count} recipients`)
    console.log(dim(`  "Accepted" means the provider took the message — not that it reached the inbox.`))
    console.log(dim(`  Delivery: iris email status ${runId} --refresh`))
    if (unfinished) prompts.log.warn(`Still ${run.status} after 15 minutes — follow it with: iris email status ${runId}`)
    else if (sent === 0) prompts.log.error("Nothing was sent.")
    if (!ok) process.exitCode = 1
  },
})

// ── status ────────────────────────────────────────────────────────────────

const StatusCommand = cmd({
  command: "status <runId>",
  describe: "email delivery status for a send run — per recipient, totals by status; --refresh asks the provider (delivered, bounced, opened)",
  builder: (y) =>
    y
      .positional("runId", { type: "number", demandOption: true, describe: "run id printed by iris email send" })
      .option("refresh", { type: "boolean", default: false, describe: "ask the provider for each message's live delivery status first" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const runId = Number(args.runId)
    const refresh = !!args.refresh
    const res = await irisFetch(`/api/v1/email/sends/${runId}${refresh ? "?refresh=1" : ""}`, {}, IRIS_API)
    // A server without delivery readback 404s on the param-bearing call only if routing changed;
    // either way, say so rather than show stored acceptance as delivery.
    if (!res.ok) {
      if (refresh && res.status === 404) {
        const plain = await irisFetch(`/api/v1/email/sends/${runId}`, {}, IRIS_API)
        if (plain.ok) return render((await body(plain))?.data ?? {}, true)
      }
      await handleApiError(res, "email send status")
      process.exitCode = 1
      return
    }
    const run = (await body(res))?.data ?? {}
    // The server answers ?refresh=1 with a `refresh` summary. Absent or null means it ignored it.
    return render(run, refresh && (run.refresh === undefined || run.refresh === null))

    async function render(run: any, refreshUnsupported: boolean) {
      const messages: StatusMessage[] = run.messages ?? []
      const totals = statusTotals(messages)
      const verdict = statusVerdict(messages, { refreshed: refresh, refreshUnsupported })
      if (refresh && run.refresh?.error) verdict.reasons.push(`provider lookup error: ${run.refresh.error}`)
      if (refresh && run.refresh?.error) verdict.exitCode = 1

      if (args.json) {
        await writeJson({
          success: verdict.exitCode === 0,
          run_id: run.id ?? runId,
          status: run.status,
          provider: run.provider,
          mode: run.mode,
          totals,
          delivery_status_available: !refreshUnsupported && (refresh || messages.some((m) => !!m.delivery_checked_at)),
          refresh: run.refresh ?? null,
          problems: verdict.reasons,
          messages: messages.map((m) => ({ ...m, effective_status: effectiveStatus(m) })),
        })
        process.exitCode = verdict.exitCode
        return
      }

      printDivider()
      printKV("Run", `#${run.id ?? runId} · ${run.mode ?? "?"} · ${run.provider ?? "?"} · ${run.status ?? "?"}`)
      printKV("Subject", run.subject)
      printKV("Started", fmtTime(run.started_at ?? run.created_at))
      printDivider()
      const w = Math.min(40, Math.max(5, ...messages.map((m) => m.email.length)))
      console.log(
        `  ${bold("email".padEnd(w))}  ${bold("provider id".padEnd(22))}  ${bold("send".padEnd(15))}  ${bold("delivery".padEnd(12))}  ${bold("last checked")}`,
      )
      for (const m of messages) {
        const d = m.status === "sent" ? (m.delivery_status ? String(m.delivery_status) : "—") : "—"
        const colored = DELIVERY_BAD.has(d) ? warn(d.padEnd(12)) : d.padEnd(12)
        const send = m.status === "failed" ? warn(sendLabel(m).padEnd(15)) : sendLabel(m).padEnd(15)
        const id = String(m.provider_message_id ?? "—").slice(0, 22).padEnd(22)
        console.log(`  ${m.email.padEnd(w)}  ${dim(id)}  ${send}  ${colored}  ${dim(fmtTime(m.delivery_checked_at))}`)
        const err = m.error || m.delivery_error
        if (err) console.log(`  ${"".padEnd(w)}  ${dim("↳ " + String(err).slice(0, 120))}`)
      }
      printDivider()
      console.log(`  ${dim("by status:")} ${Object.entries(totals).map(([k, n]) => `${bold(String(n))} ${k}`).join(" · ") || "no messages"}`)
      if (refreshUnsupported) {
        prompts.log.warn("delivery status not available from server yet — 'accepted' below means the provider took the message, nothing more.")
      } else if (!refresh) {
        console.log(dim(`  'accepted' = taken by the provider, not confirmed delivered. Ask the provider: iris email status ${run.id ?? runId} --refresh`))
      } else if (run.refresh) {
        const r = run.refresh
        console.log(dim(`  refreshed: ${r.checked} checked · ${r.updated} changed · ${r.failed} lookup failures · ${r.skipped_terminal} already final${r.remaining ? ` · ${r.remaining} not yet asked (run again)` : ""}`))
      }
      for (const reason of verdict.reasons) prompts.log.warn(reason)
      process.exitCode = verdict.exitCode
    }
  },
})

// ── root ──────────────────────────────────────────────────────────────────

export const PlatformEmailCommand = cmd({
  command: "email",
  describe:
    "email — send a newsletter or announcement to a list from a board: versioned templates, one message per recipient via Mailjet or Resend, delivery status per recipient",
  builder: (y) => y.command(TemplatesCommand).command(SendCommand).command(StatusCommand).demandCommand(),
  async handler() {},
})
