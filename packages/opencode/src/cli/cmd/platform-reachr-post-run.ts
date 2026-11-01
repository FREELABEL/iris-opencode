import fs from "fs"
import os from "os"
import path from "path"
import { execSync } from "child_process"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, resolveUserId, printDivider, printKV, dim, bold, writeJson } from "./iris-api"
import { runInstagramScrape } from "./reachr-instagram"
import { runSpec } from "./reachr-playwright"
import { findExisting, judgeCreated, leadPayload, provenanceNote, type Lead } from "./reachr-core"
import { boardLeads } from "./platform-reachr-scrape"
import {
  approvalError,
  busyReason,
  contactReason,
  DEFAULT_DAILY_CAP,
  DEFAULT_LIMIT,
  keywordLedgerHandles,
  ledgerBlocks,
  liveCampaignOnBoard,
  MAX_LIMIT,
  messageWarnings,
  perPost,
  planRun,
  postShortcode,
  tally,
  type LedgerEntry,
  type PlanTarget,
  type SavedPlan,
  type Skip,
} from "./reachr-post-run"

/**
 * `iris reachr post-run <post-url>` (#192163): a post's commenters → a preview a person reads → the
 * exact messages they approved.
 *
 * WHY THESE PIECES. Reading is leadgen-scraper.spec.ts in dry mode (as `reachr scrape --instagram`),
 * which writes nothing. Sending is som/post-run-send.spec.ts, not the batch: the batch sends a
 * strategy's step, so what goes out could differ from what a person read.
 *
 * A PREVIEW IS THE APPROVAL'S SUBJECT. It is saved, and --send sends that saved list and re-reads no
 * comments, so someone who commented after the preview is never messaged unseen.
 *
 * NOTHING IS WRITTEN BEFORE APPROVAL. Batches take the newest leads first (som-outreach playbook), so a
 * lead put on a campaign's board at preview time could get that campaign's DM from the next scheduled
 * run with nobody having approved it.
 */

const IRIS_DIR = path.join(os.homedir(), ".iris")
const STORE = path.join(IRIS_DIR, "reachr")
const LEDGER = process.env.POST_RUN_LEDGER || path.join(STORE, "post-run-ledger.jsonl")
const LOCK = "/tmp/som_batch.lock"
const somDir = () => process.env.IRIS_SOM_DIR || path.join(IRIS_DIR, "bridge", "som")
const dailyCap = () => Number(process.env.DAILY_DM_CAP) || DEFAULT_DAILY_CAP
const planPath = (code: string, account: string, board: number) => path.join(STORE, `post-run-plan-${code}-${account}-${board}.json`)
const out = (...p: string[]) => console.log(p.join(""))

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function readLedger(): LedgerEntry[] {
  try {
    return fs.readFileSync(LEDGER, "utf8").split("\n").flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : []
      } catch {
        return [] // a line cut short by a crash
      }
    })
  } catch {
    return []
  }
}

/** The batch sender's daily count for this account, so both spend one limit. */
function remainingToday(account: string): { used: number; remaining: number } {
  const file = path.join(somDir(), "../../test-results", `.dm-sent-${account}-${new Date().toISOString().slice(0, 10)}.json`)
  const raw = readJson(file)
  const used = Number(raw?.count) || (Array.isArray(raw?.leadIds) ? raw.leadIds.length : 0)
  return { used, remaining: Math.max(0, dailyCap() - used) }
}

function ownHandles(): string[] {
  try {
    return fs.readdirSync(somDir()).flatMap((f) => f.match(/^instagram-auth-(.+)\.json$/)?.[1] ?? [])
  } catch {
    return []
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

/**
 * Take som-all.js's own lock for the length of the browser job, so a scheduled batch skips its turn
 * instead of opening a second browser on the account. Returns a release function, or why it can't.
 */
function takeBrowserLock(): { release: () => void } | { busy: string } {
  let ps = ""
  try {
    ps = execSync("ps -eo pid=,args=", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  } catch {
    return { busy: "could not check for running browser jobs" }
  }
  const busy = busyReason(readJson(LOCK), ps, { now: Date.now(), alive: pidAlive })
  if (busy) return { busy }
  const stamp = () => JSON.stringify({ pid: process.pid, started: Date.now() })
  fs.rmSync(LOCK, { force: true }) // busyReason said it is stale
  try {
    fs.writeFileSync(LOCK, stamp(), { flag: "wx" })
  } catch {
    return { busy: "another job took the lock just now" }
  }
  const refresh = setInterval(() => fs.writeFileSync(LOCK, stamp()), 5 * 60_000)
  const release = () => {
    clearInterval(refresh)
    if (readJson(LOCK)?.pid === process.pid) fs.rmSync(LOCK, { force: true })
  }
  process.once("exit", release)
  return { release }
}

/** Contact on record for a lead. Null = none. Fails closed: a lead we can't read is not messaged. */
async function contactOnRecord(leadId: number): Promise<string | null> {
  const [m, l] = await Promise.all([irisFetch(`/api/v1/leads/${leadId}/outreach/messages`), irisFetch(`/api/v1/leads/${leadId}`)])
  if (!m.ok || !l.ok) return `could not read lead #${leadId}'s history, so not contacting them`
  const mb = (await m.json()) as any
  const lb = (await l.json()) as any
  const messages = mb?.data?.messages ?? mb?.messages ?? mb?.data?.data ?? mb?.data ?? []
  const notes = lb?.data?.notes ?? lb?.notes ?? []
  return contactReason(Array.isArray(messages) ? messages : [], Array.isArray(notes) ? notes : [])
}

/** Handle → why not, and handle → existing lead id, from the chosen board. */
async function checkBoard(leads: Lead[], boardId: number) {
  const onBoard = await boardLeads(boardId)
  const blocked = new Map<string, string>()
  const existing = new Map<string, number>()
  for (const l of leads) {
    const hit = findExisting(l, onBoard)
    if (!hit) continue
    const why = await contactOnRecord(hit.id)
    if (why) blocked.set(String(l.handle).toLowerCase(), why)
    else existing.set(String(l.handle).toLowerCase(), hit.id)
  }
  return { blocked, existing }
}

/** Put one approved person on the board with their source post. Null + why when it can't be done. */
async function ingest(t: PlanTarget, boardId: number, postUrl: string, existingId: number | undefined): Promise<{ id: number } | { why: string }> {
  const when = new Date().toISOString().slice(0, 10)
  const note = (id: number) => irisFetch(`/api/v1/leads/${id}/notes`, { method: "POST", body: JSON.stringify({ message: provenanceNote(t.lead, when) }) })
  if (existingId) {
    await note(existingId)
    return { id: existingId }
  }
  const started = Date.now()
  const payload = { ...leadPayload(t.lead, boardId), custom_fields: { source_post_url: postUrl, comment: t.comment, discovery_source: "iris reachr post-run" } }
  const res = await irisFetch("/api/v1/leads", { method: "POST", body: JSON.stringify(payload) })
  if (!res.ok) return { why: `could not create the lead (HTTP ${res.status})` }
  const body = (await res.json()) as any
  const lead = body?.data ?? body
  // The API can hand back someone else's record (#137529). Their history is not this person's.
  const judged = judgeCreated(lead, t.name, started)
  if (!judged.ours) return { why: `not contacted: ${judged.why}` }
  await note(lead.id)
  return { id: lead.id }
}

function printPreview(plan: SavedPlan, skipped: Skip[], overLimit: number, read: any, cap: { used: number; remaining: number }, warnings: string[]) {
  printDivider()
  printKV("post", plan.post_url)
  printKV("from", `@${plan.account}`)
  printKV("board", plan.board_id)
  printKV("commenters read", read?.scraped ?? "?")
  printKV("daily cap", `${cap.used}/${dailyCap()} used, ${cap.remaining} left`)
  printDivider()
  plan.targets.forEach((t, i) => {
    out(`  ${i + 1}. ${bold(`@${t.handle}`)}`)
    out(dim(`     why: ${t.why}`))
    out(`     message: ${t.message}`)
  })
  if (skipped.length || overLimit) {
    printDivider()
    for (const s of skipped) out(dim(`  skip @${s.handle}: ${s.reason}`))
    if (overLimit) out(dim(`  ${overLimit} more eligible, past --limit or today's cap (not listed)`))
    out(dim("  Commenters already on an outreach board were left out by the scraper and are not counted here."))
  }
  printDivider()
  for (const w of warnings) out(`  ! ${w}`)
  out(dim("  Delivery is unknown until a send: Instagram shows \"can't receive your message\" only afterwards (#192164)."))
  out(dim("  Opening a thread can follow the person, when Instagram requires it, as the batch does."))
}

function printResults(entries: LedgerEntry[], approved: number, dropped: Skip[]) {
  const t = tally(entries, approved)
  printDivider()
  printKV("approved", t.approved)
  printKV("sent, confirmed in the thread", t.sent)
  printKV("undeliverable", t.undeliverable)
  printKV("unconfirmed, may have arrived; read the thread before any retry", t.unconfirmed)
  printKV("failed", t.failed)
  printKV("not attempted", t.not_attempted)
  if (t.sent_not_recorded) out(`  ! ${t.sent_not_recorded} sent DM(s) did not save to the lead; they are in ${LEDGER}.`)
  if (t.not_attempted) out(`  ! ${t.not_attempted} approved lead(s) are on the board with no DM. On a live campaign's board, the next batch can DM them.`)
  printDivider()
  for (const e of entries) out(`  ${e.outcome.padEnd(13)} @${e.handle}${e.lead_id ? dim(` #${e.lead_id}`) : ""}${e.reason ? dim(` ${e.reason}`) : ""}`)
  for (const d of dropped) out(`  ${"not sent".padEnd(13)} @${d.handle}${dim(` ${d.reason}`)}`)
}

async function report(shortcode: string, json: boolean) {
  const rows = perPost(readLedger()).filter((p) => p.shortcode === shortcode)
  const latest = rows[0]?.latest ?? []
  let replied = 0
  let unread = 0
  for (const e of latest.filter((x) => x.outcome === "sent")) {
    const res = await irisFetch(`/api/v1/leads/${e.lead_id}/outreach/messages?direction=inbound`)
    if (!res.ok) { unread++; continue }
    const b = (await res.json()) as any
    const list = b?.data?.messages ?? b?.messages ?? b?.data?.data ?? b?.data ?? []
    if (Array.isArray(list) && list.length) replied++
  }
  const t = tally(latest, latest.length)
  const result = { shortcode, ...t, replied, replied_unread: unread, downloaded: null, paid: null }
  if (json) return writeJson(result)
  printDivider()
  printKV("post", shortcode)
  printKV("sent", t.sent)
  printKV("undeliverable", t.undeliverable)
  printKV("unconfirmed", t.unconfirmed)
  printKV("failed", t.failed)
  printKV("replied", unread ? `${replied} (${unread} could not be read)` : replied)
  printKV("downloaded", "not measured (#192077)")
  printKV("paid", "not measured (#192077)")
  printDivider()
  out(dim("  From this machine's ledger: a post run from another machine is not counted."))
}

export const ReachrPostRunCmd = cmd({
  command: "post-run <post-url>",
  describe: "reach a post's commenters: preview who, why and the exact message; --send sends only that list after a person approves",
  builder: (y: any) =>
    y
      .positional("post-url", { describe: "Instagram post or reel URL", type: "string" })
      .option("board", { describe: "board the leads land on", type: "number" })
      .option("account", { describe: "Instagram account to read and send from (its saved session)", type: "string" })
      .option("message", { describe: '{source} = "Saw your comment on that post." (only when true of that person), {handle} = their handle', type: "string" })
      .option("limit", { describe: `most people in this run (ceiling ${MAX_LIMIT})`, type: "number", default: DEFAULT_LIMIT })
      .option("scan", { describe: "most new commenters to read", type: "number", default: 100 })
      .option("send", { describe: "send the saved preview's list. Needs --confirm-count", type: "boolean", default: false })
      .option("confirm-count", { describe: "the number the preview printed", type: "number" })
      .option("ingest", { describe: "add the saved preview's list as leads, send nothing. Refused on a live campaign's board", type: "boolean", default: false })
      .option("report", { describe: "this post's results so far: sent, undeliverable, replied", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example('$0 reachr post-run https://www.instagram.com/p/ABC123/ --board 38 --account heyiris.io --message "{source} I build IRIS." --limit 5', "preview only: nothing written, nothing sent")
      .example("$0 reachr post-run https://www.instagram.com/p/ABC123/ --board 38 --account heyiris.io --send --confirm-count 5", "send exactly the list that preview showed")
      .example("$0 reachr post-run https://www.instagram.com/p/ABC123/ --report", "per-post results"),
  async handler(args: any) {
    const json = Boolean(args.json)
    const fail = (msg: string, code = 2) => {
      if (json) void writeJson({ ok: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = code
    }

    const postUrl = String(args["post-url"] ?? args.postUrl ?? "").trim().split("?")[0]!
    const shortcode = postShortcode(postUrl)
    if (!shortcode) return fail("post-url must be an instagram.com /p/ or /reel/ link")
    if (!(await requireAuth())) return fail("Not signed in. Run `iris login`.")
    if (args.report) return report(shortcode, json)
    if (args.send && args.ingest) return fail("give --send or --ingest, not both")

    const boardId = Number(args.board)
    const account = String(args.account ?? "").trim().replace(/^@/, "")
    if (!(boardId > 0)) return fail("--board is required")
    if (!/^[A-Za-z0-9._]{1,30}$/.test(account)) return fail("--account is required, e.g. --account heyiris.io")
    if (!fs.existsSync(path.join(somDir(), `instagram-auth-${account}.json`))) return fail(`No saved Instagram session for @${account} in ${somDir()}.`)
    const file = planPath(shortcode, account, boardId)
    const saved: SavedPlan | null = readJson(file)

    if (args.send || args.ingest) {
      if (args.message) return fail("--message belongs on the preview: only text a person has read can be sent.")
      const cap = remainingToday(account)
      const remaining = args.ingest ? Infinity : cap.remaining
      const denied = approvalError(saved, { postUrl, account, boardId, confirmCount: args.ingest ? saved?.targets.length : args["confirm-count"], remainingToday: remaining, now: Date.now() })
      if (denied) return fail(denied, 1)
      const plan = saved!
      if (args.ingest) {
        const campaign = liveCampaignOnBoard(readJson(path.join(somDir(), ".som-campaigns-cache.json")), boardId)
        if (campaign) return fail(`Board ${boardId} feeds the live "${campaign}" campaign: a lead left there can be DMed by the next scheduled batch with nobody approving it. Use another board, or --send.`, 1)
      }
      if (args.send && !fs.existsSync(path.join(somDir(), "post-run-send.spec.ts"))) return fail("This machine's bridge has no post-run sender yet. Update it: iris node install")

      // Before any lead is written: a lead left on a campaign's board with no send behind it is the
      // thing this command exists to avoid.
      const lock = args.send ? takeBrowserLock() : null
      if (lock && "busy" in lock) return fail(`Not sending: ${lock.busy}. Nothing written. Run this again when it finishes.`)
      const release = () => (lock && "release" in lock ? lock.release() : undefined)

      // The preview may be hours old: read each person's record again before acting on it.
      const check = await checkBoard(plan.targets.map((t) => t.lead), boardId).catch((e) => ({ error: String(e?.message ?? e) }))
      if ("error" in check) {
        release()
        return fail(`${check.error}. Nothing written, nothing sent.`)
      }
      const dropped: Skip[] = []
      const approved: { handle: string; leadId: number; message: string }[] = []
      const blockedLedger = ledgerBlocks(readLedger())
      for (const t of plan.targets) {
        const why = check.blocked.get(t.handle) ?? blockedLedger.get(t.handle)
        if (why) { dropped.push({ handle: t.handle, reason: why }); continue }
        const made = await ingest(t, boardId, plan.post_url, check.existing.get(t.handle))
        if ("why" in made) { dropped.push({ handle: t.handle, reason: made.why }); continue }
        approved.push({ handle: t.handle, leadId: made.id, message: t.message })
      }
      if (args.ingest) {
        if (json) return writeJson({ ok: true, ingested: approved.map((a) => ({ handle: a.handle, lead_id: a.leadId })), dropped })
        printKV("on the board", approved.length)
        for (const d of dropped) out(dim(`  @${d.handle}: ${d.reason}`))
        return
      }
      if (!approved.length) {
        release()
        if (json) return writeJson({ ok: true, run_id: plan.run_id, dropped, results: tally([], 0) })
        printResults([], 0, dropped)
        return
      }

      fs.mkdirSync(STORE, { recursive: true, mode: 0o700 })
      const approvedFile = path.join(STORE, `post-run-approved-${plan.run_id}.json`)
      fs.writeFileSync(approvedFile, JSON.stringify(approved), { mode: 0o600 })
      const before = readLedger().length
      const spinner = json ? null : prompts.spinner()
      spinner?.start(`Sending ${approved.length} DM(s) as @${account}, about a minute each…`)
      const run = await runSpec({
        root: somDir(),
        spec: "post-run-send.spec.ts",
        env: {
          ...process.env,
          POST_RUN_SEND: "1",
          CONFIRM_COUNT: String(approved.length),
          APPROVED_FILE: approvedFile,
          IG_ACCOUNT: account,
          BOARD_ID: String(boardId),
          POST_URL: plan.post_url,
          RUN_ID: plan.run_id,
          POST_RUN_LEDGER: LEDGER,
          DAILY_DM_CAP: String(dailyCap()),
          HEYIRIS_TOKEN: (await requireAuth()) as string,
        },
        timeoutMs: approved.length * 180_000 + 300_000,
        resultFile: approvedFile,
        noRetry: true,
      }).finally(() => {
        release()
        fs.rmSync(approvedFile, { force: true })
      })
      const entries = readLedger().slice(before).filter((e) => e.run_id === plan.run_id)
      const stop = run.text.split("\n").find((l) => /^\s*STOP /.test(l))?.trim().slice(5)
      const errored = run.code !== 0 ? run.text.split("\n").find((l) => /Error:/.test(l))?.trim().slice(0, 300) : undefined
      spinner?.stop(stop ? `Stopped: ${stop}` : "Run finished", stop || errored ? 1 : 0)
      if (json) await writeJson({ ok: !stop && !errored, run_id: plan.run_id, stop, error: errored, dropped, results: tally(entries, approved.length), entries })
      else {
        if (errored) prompts.log.error(errored)
        printResults(entries, approved.length, dropped)
      }
      process.exitCode = stop || errored ? 1 : 0
      return
    }

    // ── preview ──
    const template = String(args.message ?? "")
    if (!template.trim()) return fail('--message is required for a preview, e.g. --message "{source} I build IRIS."')
    if (template.length > 1000) return fail("--message is longer than 1000 characters")
    const limit = Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(`--limit must be 1-${MAX_LIMIT}`)
    const token = await requireAuth()
    const userId = await resolveUserId()
    if (!token || !userId) return fail("Not signed in. Run `iris login`.")
    if (!fs.existsSync(path.join(somDir(), "leadgen-scraper.spec.ts"))) return fail(`No lead scraper in ${somDir()}. Update the bridge: iris node install`)

    const lock = takeBrowserLock()
    if ("busy" in lock) return fail(`Not reading the post: ${lock.busy}. One browser per Instagram account; try again when it finishes.`)
    const spinner = json ? null : prompts.spinner()
    spinner?.start(`Reading commenters as @${account}. Nothing is written…`)
    const scraped = await runInstagramScrape({
      root: somDir(),
      spec: "leadgen-scraper.spec.ts",
      account,
      mode: "comments",
      target: postUrl,
      max: Number(args.scan) || 100,
      bloqId: boardId,
      token,
      userId,
      filters: { NO_NEW_LIMIT: "10" },
    }).finally(() => lock.release())
    if (scraped.error) { spinner?.stop("Could not read the post", 1); return fail(scraped.error) }
    const data = scraped.data
    if (data.measured === false) { spinner?.stop("Could not read the post", 1); return fail(`could not read the post: ${data.error ?? "no reason given"}`) }
    // The scraper warns and carries on when it can't read the boards, and then everyone looks new.
    if (!data.instagram?.existing_skipped) { spinner?.stop("Could not check for duplicates", 1); return fail("The scraper saw no existing leads on any outreach board, so it could not have skipped anyone already contacted. Nothing saved; try again.") }
    spinner?.stop(`Read ${data.instagram.scraped ?? "?"} commenter(s), ${data.leads.length} not on an outreach board`)

    const leads: Lead[] = data.leads
    const check = await checkBoard(leads, boardId).catch((e) => ({ error: String(e?.message ?? e) }))
    if ("error" in check) return fail(`${check.error}. No preview saved.`)
    const blocked = new Map<string, string>([...keywordLedgerHandles(readJson(path.join(IRIS_DIR, "keyword-dm-ledger.json"))), ...ledgerBlocks(readLedger()), ...check.blocked])
    const cap = remainingToday(account)
    const { targets, skipped, overLimit } = planRun({ leads, postUrl, template, account, ownHandles: ownHandles(), blocked, limit, remainingToday: cap.remaining })
    const plan: SavedPlan = { run_id: `${shortcode}-${Date.now()}`, created_at: new Date().toISOString(), post_url: postUrl, account, board_id: boardId, targets }
    fs.mkdirSync(STORE, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 })

    if (json) return writeJson({ ok: true, preview: true, ...plan, targets: targets.map(({ lead, ...t }) => t), skipped, over_limit: overLimit, daily_cap: { ...cap, cap: dailyCap() } })
    printPreview(plan, skipped, overLimit, data.instagram, cap, messageWarnings(template))
    prompts.outro(
      targets.length
        ? `Preview only: nothing written, nothing sent. To send exactly these ${targets.length}:\n  iris reachr post-run ${postUrl} --board ${boardId} --account ${account} --send --confirm-count ${targets.length}`
        : "Preview only: nobody to message.",
    )
  },
})
