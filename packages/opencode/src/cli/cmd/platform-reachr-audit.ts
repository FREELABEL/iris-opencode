import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, printDivider, dim, bold, writeJson } from "./iris-api"
import { auditRepliedLead, collectPages } from "./reachr-core"

const out = (...parts: string[]) => console.log(parts.join(""))
const TAG = /^dm replied$/i
const TAG_NAME = "DM Replied"

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
const rowsOf = (x: any): any[] => (Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : [])
const hasTag = (l: any) => (l?.tags ?? []).some((t: any) => TAG.test(String(t?.name ?? "")))

/** A read that never answers would hang the audit with no word; every request gets a deadline. */
export const REQUEST_TIMEOUT_MS = 30_000
/** Leads read at once. Sequential reads were half of a 56s run on board 80 (#191704). */
export const LEAD_CONCURRENCY = 6

/**
 * Only the leads carrying "DM Replied" — the server filters by tag name (`?tag=`).
 *
 * #191704: this used to read the WHOLE board and filter here. Board 80 (2026-10-29): 78 pages of
 * 200 (the default list and the Prospected list, 39 pages each) to find 36 tagged leads — ~35s of
 * a 56s run with the spinner frozen on "Reading board 80…", long enough for a caller's timeout to
 * kill it with nothing printed. `?tag=DM Replied&bloq_id=80` returns the same 36 in one request.
 * Both lists are still asked for, because the board list without a status omits Prospected
 * (see boardLeads), and the tag is re-checked here in case a server ignores the filter.
 */
export async function repliedLeads(bloqId: number, fetch: Fetch): Promise<any[]> {
  const all = new Map<number, any>()
  for (const status of [undefined, "Prospected"]) {
    const rows = await collectPages(
      async (page, size) => {
        // `fresh_read`: the list is cached 30s per user with `_`/`timestamp` stripped from the key (#185994).
        const q = new URLSearchParams({ bloq_id: String(bloqId), tag: TAG_NAME, per_page: String(size), page: String(page), fresh_read: String(Date.now()) })
        if (status) q.set("status", status)
        const res = await fetch(`/api/v1/leads?${q}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`could not read board ${bloqId} (HTTP ${res.status})`)
        return rowsOf(((await res.json()) as any)?.data)
      },
      { pageSize: 200, maxPages: 250 },
    )
    for (const r of rows) if (r?.id != null) all.set(r.id, r)
  }
  return [...all.values()].filter(hasTag)
}

/** Read one tagged lead and judge it. Never throws: a lead that cannot be read is "unknown", with why. */
export async function auditLead(l: any, fetch: Fetch): Promise<any> {
  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const [r, c] = await Promise.all([
      fetch(`/api/v1/leads/${l.id}`, { signal }),
      fetch(`/api/v1/atlas/comms?lead_id=${l.id}&direction=inbound&per_page=200`, { signal }),
    ])
    if (!r.ok || !c.ok) return { id: l.id, name: l.name, verdict: "unknown", error: `could not read the lead (HTTP ${r.ok ? c.status : r.status})` }
    const lead = ((await r.json()) as any)?.data ?? {}
    const cj: any = await c.json()
    const comms = (Array.isArray(cj?.data) ? cj.data : cj?.data?.data ?? []).map((x: any) => ({
      id: x.id,
      body: String(x.body ?? ""),
      source: (typeof x.metadata === "string" ? JSON.parse(x.metadata) : x.metadata)?.source ?? null,
    }))
    const notes = (lead.notes ?? []).map((n: any) => String(n.content ?? n.message ?? ""))
    const v = auditRepliedLead({ notes, comms })
    // A comms row is removable only if, read alone, it is nothing but our own words.
    const falseComms = v.verdict === "false_reply" ? comms.filter((x: any) => auditRepliedLead({ notes: [], comms: [x] }).verdict === "false_reply") : []
    return {
      id: l.id,
      name: l.name,
      handle: lead.contact_info?.instagram ?? lead.nickname ?? null,
      verdict: v.verdict,
      evidence: v.evidence.slice(0, 3),
      our_lines: v.ourLines,
      false_comm_ids: falseComms.map((x: any) => x.id),
      tags: (lead.tags ?? l.tags ?? []).map((t: any) => ({ id: t.id, name: t.name })),
    }
  } catch (e: any) {
    return { id: l.id, name: l.name, verdict: "unknown", error: `could not read the lead (${e?.message ?? e})` }
  }
}

/** Run up to `limit` jobs at once, results in input order. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        res[i] = await fn(items[i])
      }
    }),
  )
  return res
}

/** Every tagged lead on the board, judged. Throws only when the board itself cannot be read. */
export async function auditBoard(
  bloqId: number,
  fetch: Fetch,
  o: { concurrency?: number; onLeads?: (n: number) => void; onProgress?: (done: number, total: number) => void } = {},
): Promise<any[]> {
  const leads = await repliedLeads(bloqId, fetch)
  o.onLeads?.(leads.length)
  let done = 0
  return pool(leads, o.concurrency ?? LEAD_CONCURRENCY, async (l) => {
    const row = await auditLead(l, fetch)
    o.onProgress?.(++done, leads.length)
    return row
  })
}

/**
 * `iris reachr audit-replies <bloq-id>` — is every "DM Replied" lead on this board a real reply?
 *
 * Before 2026-09-18 the inbox scan counted our own DMs as replies (#186186): it tagged the lead
 * "DM Replied", wrote our pitch into a `[DM Reply]` note under sender "me", and a backfill copied that
 * note into the lead's comms thread as an INBOUND message. Measured on board 38: 11 of 21 tags false.
 * A false "replied" skews every reply-rate figure and puts a person who never answered into the
 * follow-up queue.
 *
 * READ-ONLY by default. `--fix`, for leads judged false only:
 *   - removes the "DM Replied" tag (every other tag kept)
 *   - deletes the inbound comms rows that hold only our own words (never a row with their words)
 *   - adds a note saying what was removed and why, so the change is explained on the record
 * The notes the old scan wrote are left alone — they are history. "unknown" leads are never touched.
 */
export const ReachrAuditRepliesCmd = cmd({
  command: "audit-replies <bloq-id>",
  describe: "check every 'DM Replied' lead on a board is a real reply — read-only; --fix corrects the false ones",
  builder: (y: any) =>
    y
      .positional("bloq-id", { describe: "board to audit", type: "number" })
      .option("fix", { describe: "untag false replies and remove the comms rows that are only our own words", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const bloqId = Number(args["bloq-id"])
    const isJson = Boolean(args.json)
    const fix = Boolean(args.fix)
    if (!(await requireAuth())) {
      process.exitCode = 2
      return
    }
    const spinner = isJson ? null : prompts.spinner()
    spinner?.start(`Reading board ${bloqId}…`)

    // #191704: never end without a word. A caller's timeout or Ctrl-C used to kill the run with
    // nothing printed after "Reading board…" — so say where it stopped, and exit non-zero.
    let stage = `reading board ${bloqId}`
    const onSignal = (sig: NodeJS.Signals) => {
      const error = `interrupted (${sig}) while ${stage} — no result${fix ? "; corrections made so far stand, re-run to see the current state" : ""}`
      if (isJson) process.stdout.write(JSON.stringify({ ok: false, success: false, measured: false, bloq_id: bloqId, error }) + "\n")
      else process.stderr.write(`\n${error}\n`)
      process.exit(sig === "SIGINT" ? 130 : 143)
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    try {
      await run()
    } catch (e: any) {
      const error = String(e?.message ?? e)
      spinner?.stop(`Could not finish: ${stage}`, 1)
      if (isJson) await writeJson({ ok: false, success: false, measured: false, bloq_id: bloqId, error })
      else prompts.log.error(error)
      process.exitCode = 2
    } finally {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }

    async function run() {
      const rows = await auditBoard(bloqId, irisFetch, {
        onLeads: (n) => {
          stage = `reading ${n} "DM Replied" lead(s) on board ${bloqId}`
          spinner?.message(`Board ${bloqId}: reading ${n} "DM Replied" lead(s)…`)
        },
        onProgress: (done, total) => spinner?.message(`Board ${bloqId}: read ${done}/${total} "DM Replied" lead(s)…`),
      })

      const falseOnes = rows.filter((r) => r.verdict === "false_reply")
      const fixed: any[] = []
      if (fix) {
        stage = `correcting ${falseOnes.length} lead(s)`
        spinner?.message(`Correcting ${falseOnes.length} lead(s)…`)
        const today = new Date().toISOString().slice(0, 10)
        for (const r of falseOnes) {
          const res: any = { id: r.id, tag_removed: false, comms_deleted: 0, note_added: false }
          // Tags are synced (the list REPLACES the lead's tags) — send every tag but this one.
          const keep = r.tags.filter((t: any) => !TAG.test(String(t.name ?? ""))).map((t: any) => t.id)
          const put = await irisFetch(`/api/v1/leads/${r.id}`, { method: "PUT", body: JSON.stringify({ tags: keep }) })
          res.tag_removed = put.ok
          if (!put.ok) {
            res.error = `tag not removed (HTTP ${put.status}) — nothing else changed for this lead`
            fixed.push(res)
            continue
          }
          for (const cid of r.false_comm_ids) {
            const d = await irisFetch(`/api/v1/atlas/comms/${cid}`, { method: "DELETE" })
            if (d.ok) res.comms_deleted++
          }
          const note = await irisFetch(`/api/v1/leads/${r.id}/notes`, {
            method: "POST",
            body: JSON.stringify({
              message:
                `[reachr audit ${today}] Removed "DM Replied": this lead has not replied. An inbox-scan bug (#186186) ` +
                `recorded our own message as their reply. Removed ${res.comms_deleted} inbound comms row(s) that held only our words. ` +
                `Earlier notes are left as they were.`,
            }),
          })
          res.note_added = note.ok
          fixed.push(res)
        }
      }

      const tally = { replied: 0, false_reply: 0, unknown: 0 } as Record<string, number>
      for (const r of rows) tally[r.verdict]++
      spinner?.stop(`Board ${bloqId}: ${rows.length} "DM Replied" — ${tally.replied} real, ${tally.false_reply} false, ${tally.unknown} unknown`)

      if (isJson) {
        await writeJson({ ok: true, success: true, measured: true, bloq_id: bloqId, fix, tally, leads: rows, fixed })
        process.exitCode = 0
        return
      }
      printDivider()
      for (const r of rows) {
        const label = r.verdict === "replied" ? "real " : r.verdict === "false_reply" ? bold("FALSE") : "?    "
        out(`  ${label}  #${r.id} ${r.handle ? "@" + r.handle : r.name}`)
        if (r.verdict === "replied") out(dim(`         “${String(r.evidence[0] ?? "").slice(0, 90)}”`))
        if (r.error) out(dim(`         ${r.error}`))
      }
      printDivider()
      if (fix) {
        const ok = fixed.filter((f) => f.tag_removed)
        out(`  Corrected ${ok.length}/${falseOnes.length}: tag removed, ${ok.reduce((a, f) => a + f.comms_deleted, 0)} false comms row(s) deleted, notes added.`)
        for (const f of fixed.filter((f) => f.error)) out(dim(`  #${f.id}: ${f.error}`))
      }
      prompts.outro(
        fix
          ? "Done. Replies with their own words were not touched."
          : falseOnes.length
            ? dim(`Read-only. --fix removes the tag from the ${falseOnes.length} false one(s) and the comms rows that are only our words.`)
            : "Every tagged lead has a real reply.",
      )
    }
  },
})
