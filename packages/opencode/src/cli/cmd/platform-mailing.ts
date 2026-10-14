import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, IRIS_API, isJsonMode, isNonInteractive, requireAuth, writeJson, dim, bold, success, warn, highlight } from "./iris-api"
import {
  UsageError,
  buildCreateBody,
  templateSource,
  draftHeadline,
  droppedLine,
  placeholdersLeft,
  placeholderNames,
  readyByAudience,
  totalReady,
  progressOf,
  isSettled,
  sendGate,
  friendlyError,
  parseEmails,
  toCsv,
  type Friendly,
} from "./mailing-core"

/**
 * `iris mailing` — send one personalised email to each person on a list, through the
 * sender's own Mailjet, with a draft, a test and a confirm gate in between.
 *
 * A thin client: fl-iris-api /api/v1/mailings renders, dedupes, excludes, sends and logs
 * (epic #189371). Written for a non-technical sender on Windows, so every message names the
 * next command rather than an internal id or an HTTP status.
 */

// ── plumbing ─────────────────────────────────────────────────────────────────

type Reply = { ok: boolean; status: number; body: any }

async function reply(res: Response): Promise<Reply> {
  let body: any = null
  try {
    body = await res.json()
  } catch {}
  // Accept {data: {...}} and bare objects alike.
  const unwrapped = body && typeof body === "object" && body.data !== undefined && !Array.isArray(body) && res.ok ? body.data : body
  return { ok: res.ok, status: res.status, body: unwrapped }
}

/** One failure, said once: JSON on stdout under --json, a sentence and its fix otherwise. */
async function fail(f: Friendly): Promise<void> {
  process.exitCode = 1
  if (isJsonMode()) {
    await writeJson({ success: false, error: f.message, code: f.code, ...(f.fix ? { fix: f.fix } : {}), ...(f.details ? { details: f.details } : {}) })
    return
  }
  prompts.log.error(f.message)
  for (const d of f.details ?? []) prompts.log.info(`  ${d}`)
  for (const line of f.fix ?? []) prompts.log.info(line.startsWith("iris ") ? `  ${highlight(line)}` : `  ${line}`)
}

async function failFrom(r: Reply, id?: string | number): Promise<void> {
  await fail(friendlyError(r.status, r.body, { id }))
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e: any) {
    if (e instanceof UsageError) {
      await fail({ code: "usage", message: e.message })
      return undefined
    }
    await fail({ code: "network", message: `Could not reach IRIS: ${e?.message ?? e}`, fix: ["Check your internet connection and try again."] })
    return undefined
  }
}

const say = (s: string) => {
  if (!isJsonMode()) console.log(s)
}

function htmlToText(html: string, max = 420): string {
  const t = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
  return t.length > max ? t.slice(0, max).trimEnd() + " …" : t
}

async function loadMailing(id: string): Promise<Reply> {
  return reply(await irisFetch(`/api/v1/mailings/${id}`, {}, IRIS_API))
}

/** The signed-in person's own address, for `test` with no --to. */
export async function ownEmail(): Promise<string | null> {
  try {
    const res = await irisFetch(`/api/user`)
    if (!res.ok) return null
    const b = (await res.json()) as any
    const e = b?.data?.email ?? b?.email ?? b?.user?.email
    return typeof e === "string" && e.includes("@") ? e : null
  } catch {
    return null
  }
}

async function readTemplate(raw: string | number | undefined): Promise<string> {
  const src = templateSource(raw)
  if (src.kind === "file") {
    try {
      return readFileSync(src.path, "utf-8")
    } catch {
      throw new UsageError(`Could not open the template file ${src.path} — check the path.`)
    }
  }
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${src.id}`)
  if (!res.ok) throw new UsageError(`Could not read Atlas item ${src.id} (HTTP ${res.status}). Check the number, or save the email as an .html file and pass that.`)
  const b = (await res.json()) as any
  const item = b?.data ?? b
  const html = String(item?.content ?? "")
  if (!html.trim()) throw new UsageError(`Atlas item ${src.id} is empty — it needs the email's HTML in its content.`)
  return html
}

// ── new ──────────────────────────────────────────────────────────────────────

export async function runNew(args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const html = await readTemplate(args.template)
    const body = buildCreateBody(args, html, (p) => readFileSync(p, "utf-8"))
    const r = await reply(await irisFetch(`/api/v1/mailings`, { method: "POST", body: JSON.stringify(body) }, IRIS_API))
    if (!r.ok) return failFrom(r)
    const m = r.body
    const left = placeholdersLeft(m)
    if (isJsonMode()) {
      await writeJson({ success: true, ...m, ...(left ? { placeholder_names: placeholderNames(m) } : {}) })
      return
    }
    printDraft(m, { preview: args["preview-out"] })
    if (left) {
      const f = friendlyError(422, { reason: "placeholders_left", placeholders_left: left }, { id: m?.id, names: placeholderNames(m) })
      say("")
      prompts.log.warn(f.message)
      for (const line of f.fix ?? []) prompts.log.info(`  ${line}`)
      process.exitCode = 1
      return
    }
    if (m?.postal_address_missing) {
      prompts.log.warn(`Bulk email has to show a postal address. Make a new draft with  --postal-address "your street address".`)
    }
    say("")
    say(`  ${dim("Next — send yourself a test:")}  ${highlight(`iris mailing test ${m?.id}`)}`)
    say(`  ${dim("Then send it:")}                  ${highlight(`iris mailing send ${m?.id}`)}`)
  })
}

function printDraft(m: any, opts: { preview?: string } = {}): void {
  say("")
  say(`  ${bold(draftHeadline(m))}`)
  const dropped = droppedLine(m)
  if (dropped) say(`  ${dim("Dropped:")} ${dropped}.`)
  const sample = Array.isArray(m?.sample) ? m.sample[0] : null
  if (sample) {
    say("")
    say(`  ${dim("Preview —")} to ${sample.to}`)
    say(`  ${dim("Subject:")} ${sample.subject}`)
    say("")
    for (const line of htmlToText(String(sample.html ?? "")).split("\n")) say(`    ${line}`)
    const file = opts.preview || join(tmpdir(), `iris-mailing-${m?.id ?? "draft"}-preview.html`)
    try {
      writeFileSync(file, String(sample.html ?? ""))
      say("")
      say(`  ${dim("Full preview (open in your browser):")} ${file}`)
    } catch {}
  }
}

// ── test ─────────────────────────────────────────────────────────────────────

export async function runTest(args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const id = String(args.id)
    let to = parseEmails(args.to, "--to")
    if (!to.length || to.includes("me")) {
      const me = await ownEmail()
      if (!me) {
        return fail({ code: "no_own_email", message: "Could not find your email address. Say where to send the test:", fix: [`iris mailing test ${id} --to you@example.com`] })
      }
      to = [...new Set([...to.filter((t) => t !== "me"), me.toLowerCase()])]
    }
    const r = await reply(await irisFetch(`/api/v1/mailings/${id}/test`, { method: "POST", body: JSON.stringify({ to }) }, IRIS_API))
    // 502 = Mailjet refused some or all: the body lists who, and why.
    const failed: Array<{ to?: string; error?: string }> = Array.isArray(r.body?.failed) ? r.body.failed : []
    if (!r.ok && failed.length) {
      return fail({
        code: "test_failed",
        message: `The test did not go to ${failed.map((f) => f.to).join(", ")}.`,
        details: failed.map((f) => `${f.to}: ${f.error ?? "refused"}`),
        fix: ["If Mailjet refused the sender, approve it in Mailjet (Account Settings → Sender addresses & domains)."],
      })
    }
    if (!r.ok) return failFrom(r, id)
    if (isJsonMode()) return writeJson({ success: true, id: Number(id) || id, to, ...(r.body && typeof r.body === "object" ? r.body : {}) })
    prompts.log.success(`Test sent to ${to.join(", ")}. It is marked [TEST] and uses the first person on the list as the example.`)
    say(`  ${dim("Looks right? Send it:")}  ${highlight(`iris mailing send ${id}`)}`)
  })
}

// ── send ─────────────────────────────────────────────────────────────────────

export type SendDeps = {
  ask?: (q: string) => Promise<boolean>
  interactive?: boolean
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** Give up watching (not sending) after this long with no change. */
  stallMs?: number
}

async function askYesNo(q: string): Promise<boolean> {
  const v = await prompts.confirm({ message: q, initialValue: false })
  return v === true
}

export async function runSend(args: any, deps: SendDeps = {}): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const id = String(args.id)
    const only = (Array.isArray(args.audience) ? args.audience : args.audience ? [args.audience] : []).flatMap((s: string) => String(s).split(",")).map((s: string) => s.trim()).filter(Boolean)
    const cur = await loadMailing(id)
    if (!cur.ok) return failFrom(cur, id)
    const m = cur.body
    const left = placeholdersLeft(m)
    if (left) return fail(friendlyError(422, { reason: "placeholders_left", placeholders_left: left }, { id }))

    const names = readyByAudience(m).map((a) => a.name)
    const unknown = only.filter((a: string) => names.length && !names.some((x) => x.toLowerCase() === a.toLowerCase()))
    if (unknown.length) {
      return fail({ code: "unknown_audience", message: `Mailing #${id} has no audience called ${unknown.join(", ")}. It has: ${names.join(", ")}.`, fix: [`iris mailing send ${id} --audience ${names[0] ?? "<name>"}`] })
    }
    // The server matches names exactly; let "Members" mean "members".
    for (let i = 0; i < only.length; i++) only[i] = names.find((x) => x.toLowerCase() === only[i].toLowerCase()) ?? only[i]

    // What a send would cover: pending + failed (the server retries failed rows on resume),
    // in the chosen audiences. Rows already sent or unsubscribed are never counted.
    const scoped = { ...m, send_audiences: only.length ? only : null }
    const p = progressOf(scoped)
    const resuming = p.sent > 0
    const count = p.pending + p.failed
    const scope = only.length ? ` (${only.join(", ")})` : ""
    if (!isJsonMode()) {
      say("")
      say(`  ${bold(draftHeadline(m))}`)
      if (resuming) say(`  ${dim(`Already sent: ${p.sent}. Sending again skips them.`)}`)
      if (m?.subject) say(`  ${dim("Subject:")} ${m.subject}`)
      say("")
    }

    const gate = await sendGate({
      count,
      yes: !!args.yes,
      interactive: deps.interactive ?? !isNonInteractive(),
      ask: deps.ask ?? askYesNo,
    })
    if (!gate.go) {
      if (gate.reason === "nobody") return fail({ code: "nobody", message: `Nobody left to send to on mailing #${id}${scope}.`, fix: [`iris mailing log ${id}`] })
      if (gate.reason === "needs_yes") {
        return fail({
          code: "needs_yes",
          message: `Not sent. This would email ${count} people${scope}, and there is no one here to confirm.`,
          fix: [`Re-run with --yes once you are sure:  iris mailing send ${id}${only.length ? ` --audience ${only.join(",")}` : ""} --yes`],
        })
      }
      process.exitCode = 1
      if (isJsonMode()) return writeJson({ success: false, error: "Not sent — you said no.", code: "declined" })
      prompts.log.info("Not sent. Nothing changed.")
      return
    }

    const body: Record<string, unknown> = { confirm: true }
    if (only.length) body.audiences = only
    const r = await reply(await irisFetch(`/api/v1/mailings/${id}/send`, { method: "POST", body: JSON.stringify(body) }, IRIS_API))
    if (!r.ok) return failFrom(r, id)

    if (args["no-wait"] === true || args.noWait === true) {
      if (isJsonMode()) return writeJson({ success: true, id: Number(id) || id, status: r.body?.status ?? "sending", queued: count })
      prompts.log.success(`Sending to ${count} people${scope}. Watch it with  iris mailing status ${id}`)
      return
    }
    await follow(id, count, deps)
  })
}

async function follow(id: string, expected: number, deps: SendDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 3000
  const stallMs = deps.stallMs ?? 10 * 60_000
  say(`  Sending… ${dim(`(closing this window does not stop it — to stop: iris mailing pause ${id})`)}`)
  let last = ""
  let lastChange = Date.now()
  let m: any = null
  let misses = 0
  while (true) {
    await sleep(pollMs)
    const r = await loadMailing(id)
    if (!r.ok) {
      if (++misses >= 5) return failFrom(r, id)
      continue
    }
    misses = 0
    m = r.body
    const p = progressOf(m)
    const line = `${p.sent} sent · ${p.failed} failed · ${p.pending} to go${p.unknown ? ` · ${p.unknown} unknown` : ""}`
    if (line !== last) {
      last = line
      lastChange = Date.now()
      say(`  ${dim(new Date().toLocaleTimeString())}  ${line}`)
    }
    if (isSettled(m)) break
    if (Date.now() - lastChange > stallMs) {
      return fail({
        code: "stalled",
        message: `No progress on mailing #${id} for ${Math.round(stallMs / 60000)} minutes (${line}). It may still be queued.`,
        fix: [`iris mailing status ${id}`, `If it stays stuck, resume with  iris mailing send ${id}`],
      })
    }
  }
  await finalTally(id, m)
}

async function finalTally(id: string, m: any): Promise<void> {
  const p = progressOf(m)
  const failedRows = p.failed > 0 ? await failedRecipients(id) : []
  const done = p.status === "sent" && p.failed === 0 && p.pending === 0 && p.unknown === 0
  if (isJsonMode()) {
    await writeJson({ success: done, id: Number(id) || id, status: p.status, sent: p.sent, failed: p.failed, pending: p.pending, unknown: p.unknown, ...(m?.last_error ? { last_error: m.last_error } : {}), ...(failedRows.length ? { failures: failedRows } : {}), ...(done ? {} : { resume: `iris mailing send ${id}` }) })
    if (!done) process.exitCode = 1
    return
  }
  say("")
  if (done) {
    prompts.log.success(`Done — ${p.sent} sent, 0 failed.`)
    say(`  ${dim("Who got it:")} ${highlight(`iris mailing log ${id}`)}`)
    return
  }
  process.exitCode = 1
  const why = /paus/i.test(p.status) ? "paused" : "stopped before the end"
  prompts.log.warn(`Mailing #${id} ${why}: ${p.sent} sent, ${p.failed} failed, ${p.pending} not sent yet.`)
  if (m?.last_error) say(`  ${dim("Why:")} ${m.last_error}`)
  if (p.unknown) say(`  ${dim(`${p.unknown} were mid-send when it stopped; whether they went out is unknown. See: iris mailing log ${id}`)}`)
  for (const f of failedRows.slice(0, 10)) say(`    ${warn("✗")} ${f.email}${f.error ? dim(` — ${f.error}`) : ""}`)
  if (failedRows.length > 10) say(`    ${dim(`… and ${failedRows.length - 10} more — iris mailing log ${id} --csv`)}`)
  say("")
  say(`  ${dim("To finish, run it again — anyone already sent is skipped:")}`)
  say(`    ${highlight(`iris mailing send ${id}`)}`)
}

async function failedRecipients(id: string): Promise<Array<{ email: string; error?: string }>> {
  try {
    const r = await reply(await irisFetch(`/api/v1/mailings/${id}/recipients?status=failed`, {}, IRIS_API))
    const rows = recipientRows(r.body)
    return rows
      .filter((x) => /fail|error|bounce/i.test(String(x.status ?? "")))
      .map((x) => ({ email: String(x.email ?? x.to ?? ""), error: x.error ? String(x.error) : undefined }))
  } catch {
    return []
  }
}

function recipientRows(b: any): any[] {
  if (Array.isArray(b)) return b
  if (Array.isArray(b?.recipients)) return b.recipients
  if (Array.isArray(b?.data)) return b.data
  if (Array.isArray(b?.rows)) return b.rows
  return []
}

// ── status / list / pause / log ──────────────────────────────────────────────

export async function runStatus(args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const id = String(args.id)
    const r = await loadMailing(id)
    if (!r.ok) return failFrom(r, id)
    const m = r.body
    if (isJsonMode()) return writeJson({ success: true, ...m })
    const p = progressOf(m)
    say("")
    say(`  ${bold(draftHeadline(m))}`)
    if (m?.subject) say(`  ${dim("Subject:")} ${m.subject}`)
    say(`  ${dim("Status:")}  ${p.status}`)
    if (p.status !== "draft") say(`  ${dim("Progress:")} ${p.sent} sent · ${p.failed} failed · ${p.pending} to go${p.unknown ? ` · ${p.unknown} unknown` : ""}`)
    if (m?.last_error && p.status !== "sent") say(`  ${dim("Stopped because:")} ${m.last_error}`)
    if (m?.postal_address_missing && p.status === "draft") say(`  ${warn("No postal address in the footer")} — make a new draft with --postal-address "..."`)
    const dropped = droppedLine(m)
    if (dropped) say(`  ${dim("Dropped:")} ${dropped}.`)
    say("")
    const next =
      p.status === "draft"
        ? `iris mailing test ${id}   then   iris mailing send ${id}`
        : p.pending > 0 || p.failed > 0
          ? /sending|queued|running/i.test(p.status)
            ? `iris mailing status ${id}   (still going)`
            : `iris mailing send ${id}   (resumes; skips anyone already sent)`
          : `iris mailing log ${id}`
    say(`  ${dim("Next:")} ${highlight(next)}`)
  })
}

export async function runList(_args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const r = await reply(await irisFetch(`/api/v1/mailings`, {}, IRIS_API))
    if (!r.ok) return failFrom(r)
    const rows: any[] = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.mailings) ? r.body.mailings : Array.isArray(r.body?.data) ? r.body.data : []
    if (isJsonMode()) return writeJson({ success: true, mailings: rows })
    if (!rows.length) {
      say(`  No mailings yet. Start one:  ${highlight('iris mailing new --template invite.html --subject "..." --audience members=<list number>')}`)
      return
    }
    say("")
    for (const m of rows) {
      const p = progressOf(m)
      const when = String(m?.created_at ?? "").slice(0, 10)
      const prog = p.status === "draft" ? `${totalReady(m)} ready` : `${p.sent} sent${p.failed ? `, ${p.failed} failed` : ""}`
      say(`  ${bold(`#${m?.id}`)}  ${String(m?.subject ?? "(no subject)").slice(0, 60)}`)
      say(`        ${dim(`${p.status} · ${prog}${when ? ` · ${when}` : ""}`)}`)
    }
    say("")
  })
}

export async function runPause(args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const id = String(args.id)
    const r = await reply(await irisFetch(`/api/v1/mailings/${id}/pause`, { method: "POST" }, IRIS_API))
    if (!r.ok) return failFrom(r, id)
    if (isJsonMode()) return writeJson({ success: true, id: Number(id) || id, ...(r.body && typeof r.body === "object" ? r.body : {}) })
    const p = progressOf(r.body)
    prompts.log.success(`Paused mailing #${id}.${p.sent ? ` ${p.sent} already sent.` : ""} Nobody else will get it until you resume.`)
    say(`  ${dim("Resume:")} ${highlight(`iris mailing send ${id}`)}`)
  })
}

export async function runLog(args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const id = String(args.id)
    const r = await reply(await irisFetch(`/api/v1/mailings/${id}/recipients`, {}, IRIS_API))
    if (!r.ok) return failFrom(r, id)
    const rows = recipientRows(r.body)
    const cols = ["email", "audience", "status", "sent_at", "mailjet_message_id", "error"]
    if (args.csv) {
      const csv = toCsv(rows, cols)
      if (args.out) {
        writeFileSync(String(args.out), csv)
        if (!isJsonMode()) prompts.log.success(`Wrote ${rows.length} rows to ${args.out}`)
        else await writeJson({ success: true, id: Number(id) || id, rows: rows.length, file: String(args.out) })
      } else process.stdout.write(csv)
      return
    }
    if (isJsonMode()) return writeJson({ success: true, id: Number(id) || id, recipients: rows })
    if (!rows.length) {
      say(`  Nobody has been sent mailing #${id} yet.`)
      return
    }
    const tally: Record<string, number> = {}
    for (const x of rows) tally[String(x.status ?? "unknown")] = (tally[String(x.status ?? "unknown")] ?? 0) + 1
    say("")
    for (const x of rows) {
      const mark = /sent|deliver|open|click/i.test(String(x.status)) ? success("✓") : /fail|bounce|error/i.test(String(x.status)) ? warn("✗") : dim("·")
      say(`  ${mark} ${String(x.email ?? "").padEnd(40)} ${dim(String(x.audience ?? "").padEnd(10))} ${String(x.status ?? "")}${x.error ? dim(` — ${x.error}`) : ""}`)
    }
    say("")
    say(`  ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(" · ")}`)
    say(`  ${dim("Spreadsheet:")} ${highlight(`iris mailing log ${id} --csv --out mailing-${id}.csv`)}`)
  })
}

export async function runDiscard(args: any): Promise<void> {
  if (!(await requireAuth())) return
  await guard(async () => {
    const id = String(args.id)
    const r = await reply(await irisFetch(`/api/v1/mailings/${id}`, { method: "DELETE" }, IRIS_API))
    if (!r.ok) {
      if (r.body?.reason === "not_deletable") {
        return fail({ code: "not_deletable", message: `Mailing #${id} has already sent messages, so it is kept as the record of what went out.`, fix: [`iris mailing log ${id}`] })
      }
      return failFrom(r, id)
    }
    if (isJsonMode()) return writeJson({ success: true, id: Number(id) || id, deleted: true })
    prompts.log.success(`Draft #${id} discarded. Nothing was sent.`)
  })
}

// ── yargs ────────────────────────────────────────────────────────────────────

const jsonOpt = { describe: "machine-readable output", type: "boolean" as const, default: false }

const MailingNewCommand = cmd({
  command: "new",
  aliases: ["create", "draft"],
  describe: "make a draft from an email template and one or more lists (sends nothing)",
  builder: (y: any) =>
    y
      .option("template", { describe: "the email: an .html file, or the number of an Atlas item holding it", type: "string", demandOption: true })
      .option("subject", { describe: "subject line", type: "string", demandOption: true })
      .option("audience", { describe: "name=<list number> or name=<file.csv>; repeat for each list", type: "string", array: true, demandOption: true })
      .option("exclude", { describe: "an address that must not get it (repeat, or comma-separate)", type: "string", array: true })
      .option("skip-status", { describe: 'hold rows by a column value, e.g. "Email Status=Extrapolated,Unavailable"', type: "string", array: true })
      .option("personalize", { describe: "reason — add a line from each person's title and company ({{Reason}})", type: "string", array: true })
      .option("title-field", { describe: "column(s) holding job title, comma-separated", type: "string" })
      .option("company-field", { describe: "column(s) holding company, comma-separated", type: "string" })
      .option("reason-fallback", { describe: "the {{Reason}} line for someone with no title or company", type: "string" })
      .option("email-field", { describe: "column holding the email address (default: found automatically)", type: "string" })
      .option("from-email", { describe: "sender address (must be validated in your Mailjet)", type: "string" })
      .option("from-name", { describe: "sender name people see", type: "string" })
      .option("postal-address", { describe: "your postal address for the footer", type: "string" })
      .option("integration", { describe: "which Mailjet connection, if you have more than one", type: "number" })
      .option("preview-out", { describe: "where to save the full HTML preview", type: "string" })
      .option("json", jsonOpt)
      .example(
        'iris mailing new --template invite.html --subject "You\'re invited: Oct 29" --audience members=186974',
        "one list",
      )
      .example(
        'iris mailing new --template 189315 --subject "..." --audience members=186974 --audience prospects=189317 --skip-status "Email Status=Extrapolated,Unavailable" --personalize reason',
        "two lists, hold unverified emails, add a personal line",
      ),
  handler: (a: any) => runNew(a),
})

const MailingTestCommand = cmd({
  command: "test <id>",
  describe: "send yourself (or --to someone) a [TEST] copy",
  builder: (y: any) =>
    y
      .positional("id", { describe: "mailing number", type: "string" })
      .option("to", { describe: "who gets the test (default: you)", type: "string", array: true })
      .option("json", jsonOpt)
      .example("iris mailing test 12", "to your own address")
      .example("iris mailing test 12 --to me --to board@example.org", "to you and one more"),
  handler: (a: any) => runTest(a),
})

const MailingSendCommand = cmd({
  command: "send <id>",
  describe: "send for real — asks first; also resumes a paused or stopped mailing",
  builder: (y: any) =>
    y
      .positional("id", { describe: "mailing number", type: "string" })
      .option("audience", { describe: "send to just this list (by name); repeat for more", type: "string", array: true })
      .option("yes", { alias: "y", describe: "do not ask (required when there is no one to ask)", type: "boolean", default: false })
      // A literal flag: src/index.ts turns yargs' boolean-negation off, so --no-wait must be registered.
      .option("no-wait", { describe: "start the send and return at once instead of watching it", type: "boolean", default: false })
      .option("json", jsonOpt)
      .example("iris mailing send 12 --audience members", "members first")
      .example("iris mailing send 12 --audience prospects", "then prospects, separately")
      .example("iris mailing send 12", "run again after a failure: skips anyone already sent"),
  handler: (a: any) => runSend(a),
})

const MailingStatusCommand = cmd({
  command: "status <id>",
  describe: "where a mailing is: counts, progress, what to do next",
  builder: (y: any) => y.positional("id", { describe: "mailing number", type: "string" }).option("json", jsonOpt),
  handler: (a: any) => runStatus(a),
})

const MailingListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "your mailings, newest first",
  builder: (y: any) => y.option("json", jsonOpt),
  handler: (a: any) => runList(a),
})

const MailingPauseCommand = cmd({
  command: "pause <id>",
  aliases: ["stop"],
  describe: "stop sending; resume later with send",
  builder: (y: any) => y.positional("id", { describe: "mailing number", type: "string" }).option("json", jsonOpt),
  handler: (a: any) => runPause(a),
})

const MailingLogCommand = cmd({
  command: "log <id>",
  aliases: ["recipients"],
  describe: "who was sent it, and what happened to each",
  builder: (y: any) =>
    y
      .positional("id", { describe: "mailing number", type: "string" })
      .option("csv", { describe: "spreadsheet (CSV) output", type: "boolean", default: false })
      .option("out", { describe: "with --csv: write to this file", type: "string" })
      .option("json", jsonOpt)
      .example("iris mailing log 12 --csv --out sent.csv", "save as a spreadsheet"),
  handler: (a: any) => runLog(a),
})

const MailingDiscardCommand = cmd({
  command: "discard <id>",
  aliases: ["delete", "rm"],
  describe: "throw away a draft that has not sent anything",
  builder: (y: any) => y.positional("id", { describe: "mailing number", type: "string" }).option("json", jsonOpt),
  handler: (a: any) => runDiscard(a),
})

export const PlatformMailingCommand = cmd({
  command: "mailing",
  aliases: ["mailings"],
  describe: "send one personal email to everyone on a list, through your Mailjet — draft, test, confirm, send, log",
  builder: (yargs: any) =>
    yargs
      .command(MailingNewCommand)
      .command(MailingTestCommand)
      .command(MailingSendCommand)
      .command(MailingStatusCommand)
      .command(MailingListCommand)
      .command(MailingPauseCommand)
      .command(MailingLogCommand)
      .command(MailingDiscardCommand)
      .demandCommand()
      .epilogue(
        [
          "Steps:",
          '  1. iris mailing new --template invite.html --subject "..." --audience members=<list number>',
          "  2. iris mailing test <id>          a [TEST] copy to you",
          "  3. iris mailing send <id>          asks before sending; run again to resume",
          "  4. iris mailing status <id>  ·  iris mailing log <id> --csv",
          "",
          "First time: connect Mailjet (iris integrations connect mailjet). Walkthrough: iris how-to view mailing",
        ].join("\n"),
      ),
  async handler() {},
})
