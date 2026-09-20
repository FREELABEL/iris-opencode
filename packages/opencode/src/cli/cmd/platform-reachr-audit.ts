import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, printDivider, dim, bold, writeJson } from "./iris-api"
import { boardLeads } from "./platform-reachr-scrape"
import { auditRepliedLead } from "./reachr-core"

const out = (...parts: string[]) => console.log(parts.join(""))
const TAG = /^dm replied$/i

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

    let leads: any[]
    try {
      leads = (await boardLeads(bloqId)).filter((l) => (l.tags ?? []).some((t: any) => TAG.test(String(t?.name ?? ""))))
    } catch (e: any) {
      spinner?.stop("Could not read the board", 1)
      if (isJson) writeJson({ ok: false, measured: false, error: e.message })
      else prompts.log.error(e.message)
      process.exitCode = 2
      return
    }

    const rows: any[] = []
    for (const l of leads) {
      const r = await irisFetch(`/api/v1/leads/${l.id}`)
      const c = await irisFetch(`/api/v1/atlas/comms?lead_id=${l.id}&direction=inbound&per_page=200`)
      if (!r.ok || !c.ok) {
        rows.push({ id: l.id, name: l.name, verdict: "unknown", error: `could not read the lead (HTTP ${r.ok ? c.status : r.status})` })
        continue
      }
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
      rows.push({
        id: l.id,
        name: l.name,
        handle: lead.contact_info?.instagram ?? lead.nickname ?? null,
        verdict: v.verdict,
        evidence: v.evidence.slice(0, 3),
        our_lines: v.ourLines,
        false_comm_ids: falseComms.map((x: any) => x.id),
        tags: (lead.tags ?? l.tags ?? []).map((t: any) => ({ id: t.id, name: t.name })),
      })
    }

    const falseOnes = rows.filter((r) => r.verdict === "false_reply")
    const fixed: any[] = []
    if (fix) {
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
      writeJson({ ok: true, measured: true, bloq_id: bloqId, fix, tally, leads: rows, fixed })
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
  },
})
