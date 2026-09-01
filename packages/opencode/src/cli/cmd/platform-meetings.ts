import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  streamAgentChat, writeJson } from "./iris-api"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"
import {
  listRabbitMeetings,
  getRabbitMeeting,
  renderRabbitTranscript,
  type RabbitMeeting,
} from "./meetings-rabbit"

/**
 * Wispr Flow keeps one directory per meeting, each holding a `refined.ndjson` of
 * `{id, timestamp, text, speaker:{id}}` segments. Nothing surfaced it, so turning a call
 * into lead intel meant finding the UUID by hand, converting NDJSON to text, and passing
 * a path. This closes that loop.
 *
 * NOTE ON SPEAKERS: diarisation gives numeric ids, not names, and it splits one person
 * across ids fairly often. We surface the ids honestly rather than guessing — a wrong
 * name in a transcript is worse than no name, because it silently mis-attributes
 * commitments. Use --speaker 2=Arthur to label them when you know.
 *
 * NOTE ON COVERAGE: Wispr records SYSTEM audio, so a meeting file contains what you HEARD.
 * Your own microphone is a separate track and may be absent entirely. Anything you
 * committed to on a call can be missing — the header says so on every export.
 *
 * TWO SOURCES. Wispr Flow (local files, above) and rabbit R1 (a meeting note mailed to you
 * after each recording — see meetings-rabbit.ts). They merge into one list because what you
 * want from a meeting is the same either way: summarise it, file it, feed it to lead intel.
 * What is NOT shared is the coverage caveat — the R1 is a device in the room and captures
 * you, Wispr does not — so each source writes its own provenance header. A caveat that is
 * wrong is worse than no caveat, because it gets filed onto a bloq and outlives the session.
 */
const WISPR_MEETINGS = join(
  homedir(),
  "Library",
  "Application Support",
  "Wispr Flow",
  "meetings",
)

type Segment = { timestamp: string; text: string; speaker?: { id?: number } }
type SourceId = "wispr" | "rabbit"
type Session = {
  id: string
  source: SourceId
  dir: string
  mtime: Date
  segments: number
  duration: string
  preview: string
  /** Rabbit names its meetings; Wispr only has a UUID. */
  title?: string
  rabbit?: RabbitMeeting
}

function readSession(id: string): Session | null {
  const dir = join(WISPR_MEETINGS, id)
  const file = join(dir, "refined.ndjson")
  if (!existsSync(file)) return null
  try {
    const rows = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Segment)
    if (!rows.length) return null
    const preview = rows.find((r) => (r.text ?? "").length > 40)?.text ?? rows[0].text ?? ""
    return {
      id,
      source: "wispr" as const,
      dir,
      mtime: statSync(file).mtime,
      segments: rows.length,
      duration: rows[rows.length - 1]?.timestamp ?? "?",
      preview: preview.slice(0, 88),
    }
  } catch {
    return null
  }
}

function listWisprSessions(limit = 15): Session[] {
  if (!existsSync(WISPR_MEETINGS)) return []
  return readdirSync(WISPR_MEETINGS)
    .map(readSession)
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit)
}

function rabbitToSession(m: RabbitMeeting): Session {
  return {
    id: m.id,
    source: "rabbit",
    dir: m.mailbox,
    mtime: m.receivedAt,
    segments: m.segments.length,
    duration: m.duration,
    preview: (m.segments[0]?.text ?? m.summary).slice(0, 88),
    title: m.title,
    rabbit: m,
  }
}

/**
 * Every meeting from every requested source, newest first.
 *
 * `warnings` carries a source that could not be read AT ALL. It is returned rather than
 * swallowed because "Mail is locked" and "you have no rabbit meetings" are different facts
 * and the second one is a lie when the first is true.
 */
function listSessions(
  limit = 15,
  opts: { source?: SourceId | "all"; days?: number } = {},
): { sessions: Session[]; warnings: string[] } {
  const want = opts.source ?? "all"
  const warnings: string[] = []
  const out: Session[] = []

  if (want === "all" || want === "wispr") out.push(...listWisprSessions(limit))
  if (want === "all" || want === "rabbit") {
    const r = listRabbitMeetings({ limit, days: opts.days ?? 30 })
    if (r.unavailable) warnings.push(`rabbit: ${r.unavailable}`)
    out.push(...r.meetings.map(rabbitToSession))
  }

  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  return { sessions: out.slice(0, limit), warnings }
}

/** Render whichever source this session came from. Same contract either way. */
function renderSession(session: Session, speakerNames: Record<string, string>): { text: string; segments: number } {
  return session.source === "rabbit" && session.rabbit
    ? renderRabbitTranscript(session.rabbit, speakerNames)
    : renderTranscript(session.id, speakerNames)
}

/**
 * A stable marker so re-running an ingest does not file the same meeting twice.
 * It goes in the item CONTENT: titles get edited by people, ids do not.
 */
const ingestMarker = (session: Session) => `<!-- iris-meeting: ${session.source}/${session.id} -->`

/** Where a meeting lands when nothing is passed: ~/.iris/config.json default_bloq_id. */
function resolveDefaultBloqId(): number | undefined {
  try {
    const p = join(homedir(), ".iris", "config.json")
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8"))
      const v = cfg.meetings_bloq_id ?? cfg.default_bloq_id ?? cfg.bloq_id
      if (typeof v === "number") return v
      if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10)
    }
  } catch {}
  return undefined
}

/** NDJSON → a readable, attributed transcript. */
function renderTranscript(id: string, speakerNames: Record<string, string>): { text: string; segments: number } {
  const rows = readFileSync(join(WISPR_MEETINGS, id, "refined.ndjson"), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Segment)

  const lines = [
    `# Meeting transcript — ${id}`,
    `# Source: Wispr Flow (system audio — YOUR OWN MIC MAY NOT BE CAPTURED)`,
    `# Segments: ${rows.length} · Duration: ${rows[rows.length - 1]?.timestamp ?? "?"}`,
    "",
  ]
  for (const r of rows) {
    const sid = String(r.speaker?.id ?? "?")
    const who = speakerNames[sid] ?? `Speaker ${sid}`
    lines.push(`[${r.timestamp}] ${who}: ${(r.text ?? "").trim()}`)
  }
  return { text: lines.join("\n"), segments: rows.length }
}

function parseSpeakers(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    const [k, ...rest] = String(p).split("=")
    if (k && rest.length) out[k.trim()] = rest.join("=").trim()
  }
  return out
}

/** Find or create the standard Meetings list on a bloq, so the workflow is repeatable. */
async function resolveMeetingsList(userId: number, bloqId: number, listName: string): Promise<number | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
  if (res.ok) {
    const body = (await res.json()) as any
    const bloq = body?.data ?? body
    const found = (bloq?.lists ?? []).find(
      (l: any) => String(l?.name ?? "").toLowerCase() === listName.toLowerCase(),
    )
    if (found?.id) return Number(found.id)
  }
  const mk = await irisFetch(`/api/v1/user/bloqs/${bloqId}/lists`, {
    method: "POST",
    body: JSON.stringify({ name: listName }),
  })
  if (!mk.ok) return null
  const made = (await mk.json()) as any
  return Number(made?.data?.id ?? made?.id) || null
}

const EXTRACT_PROMPT = (transcript: string) => `You are summarising a real client meeting transcript.

Return, in this order:
1. **Summary** — 3-5 sentences on what the meeting was actually about.
2. **Decisions** — what was decided. Only what was genuinely agreed, not what was floated.
3. **Action items** — one line each as "OWNER — action — due (if stated)". If nobody was named, say "unassigned".
4. **Open questions** — what was raised and left unresolved.
5. **Notable quotes** — up to 3, verbatim, that carry a requirement or a constraint.

Rules: never invent a name, number, date or commitment. If the transcript is ambiguous, say so.
The transcript may be system-audio only, so one side of the conversation can be missing — if it
reads one-sided, note that rather than inferring what the missing side said.

TRANSCRIPT:
${transcript}`

/** A filed meeting should be findable by name. Rabbit has one; Wispr only has a UUID. */
function defaultTitle(session: Session, stamp: string): string {
  return session.title
    ? `📞 ${session.title} — ${stamp}`
    : `📞 Meeting — ${stamp} (${session.id.slice(0, 8)})`
}

/** Existing markers on the target bloq, so an ingest can tell new from already-filed. */
async function filedMarkers(userId: number, bloqId: number): Promise<Set<string>> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500&fields=id,title,content`)
  if (!res.ok) return new Set()
  const j = (await res.json()) as any
  const raw = j?.data
  const items: any[] = Array.isArray(raw) ? raw : (raw?.items ?? [])
  const out = new Set<string>()
  for (const it of items) {
    for (const m of String(it?.content ?? "").matchAll(/<!--\s*iris-meeting:\s*([^\s>]+)\s*-->/g)) out.add(m[1])
  }
  return out
}

/**
 * Build the body that gets filed for one meeting.
 *
 * Rabbit notes arrive summarised, so the device's own write-up is used. Wispr transcripts
 * have no summary at all, so those go through the agent. A failed extraction files the raw
 * transcript rather than nothing — a filed raw transcript is far better than a lost meeting.
 */
async function composeBody(
  session: Session,
  args: any,
  userId: number,
): Promise<{ body: string; segments: number; summarised: boolean }> {
  const { text: transcript, segments } = renderSession(session, parseSpeakers(args.speaker as string[]))
  const wrap = (summary: string) =>
    `${summary}\n\n---\n\n<details><summary>Full transcript (${segments} segments)</summary>\n\n${transcript}\n</details>`

  if (args.raw) return { body: transcript, segments, summarised: false }

  if (session.source === "rabbit" && session.rabbit && !args.resummarize) {
    return { body: wrap(session.rabbit.summary), segments, summarised: true }
  }

  try {
    const result = await streamAgentChat({
      agentId: Number(args.agent),
      message: EXTRACT_PROMPT(transcript),
      userId,
      timeoutSecs: args.timeout,
    })
    if (!result.ok) throw new Error(result.error ?? "extraction failed")
    return { body: wrap(result.content), segments, summarised: true }
  } catch {
    return { body: transcript, segments, summarised: false }
  }
}

/**
 * `--ingest`: file every meeting in the window that is not already on the bloq.
 *
 * Idempotent by design — it is meant to be run repeatedly (by hand, by cron, by the daily
 * brief) and re-running it must be a no-op, not a pile of duplicates. The dedup key is the
 * marker written into each filed item, so it survives someone renaming the item.
 */
async function runIngest(args: any) {
  const { sessions, warnings } = listSessions(args.limit ?? 50, { source: args.source, days: args.days })
  for (const w of warnings) prompts.log.warn(w)

  if (!args.bloqId) {
    prompts.log.error("Nowhere to file. Pass --bloq <id>, or set default_bloq_id in ~/.iris/config.json")
    prompts.outro("Done")
    return
  }
  if (!sessions.length) {
    prompts.log.warn(`No meetings in the last ${args.days} days from ${args.source === "all" ? "any source" : args.source}.`)
    prompts.outro("Done")
    return
  }

  if (!(await requireAuth())) { prompts.outro("Done"); return }
  const userId = await requireUserId(undefined)
  if (!userId) { prompts.outro("Done"); return }

  // Reading the bloq is safe; RESOLVING the list is not, because it CREATES the list when
  // it is absent. So a dry run has to finish before that, or "show me what would happen"
  // leaves a new list behind — which is exactly the thing a dry run promises not to do.
  const already = await filedMarkers(userId, Number(args.bloqId))
  const pending = sessions.filter((s) => !already.has(`${s.source}/${s.id}`))
  const dryRun = Boolean(args["dry-run"] ?? args.dryRun)

  printDivider()
  printKV("Destination", `bloq ${args.bloqId} → "${args.list}" list`)
  printKV("Window", `${args.days} days · source: ${args.source}`)
  printKV("Found", `${sessions.length} meeting(s) · ${sessions.length - pending.length} already filed`)
  printDivider()

  if (!pending.length) {
    prompts.outro(success("Nothing new to ingest"))
    return
  }

  if (dryRun) {
    for (const s of pending) {
      console.log(`  ${dim(s.source.padEnd(6))} ${bold(s.id.slice(0, 10))}  ${s.title ?? dim(s.preview)}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${pending.length} would be filed (dry run — nothing written)`)
    return
  }

  const listId = await resolveMeetingsList(userId, Number(args.bloqId), String(args.list))
  if (!listId) {
    prompts.log.error(`Could not find or create a "${args.list}" list on bloq ${args.bloqId}`)
    prompts.outro("Done")
    return
  }

  let filed = 0
  const failures: string[] = []
  for (const s of pending) {
    const spin = prompts.spinner()
    spin.start(`${s.title ?? s.id.slice(0, 10)}…`)
    try {
      const { body, segments } = await composeBody(s, args, userId)
      const stamp = s.mtime.toISOString().slice(0, 10)
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.bloqId}/lists/${listId}/items`, {
        method: "POST",
        body: JSON.stringify({
          title: defaultTitle(s, stamp),
          content: `${body}\n\n${ingestMarker(s)}`,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      filed++
      spin.stop(`${success("✓")} ${defaultTitle(s, stamp)} ${dim(`(${segments} segs)`)}`)
    } catch (e: any) {
      // One bad meeting must not abandon the rest of the batch.
      spin.stop(`✗ ${s.id.slice(0, 10)} — ${String(e?.message ?? e)}`)
      failures.push(s.id)
    }
  }

  printDivider()
  printKV("Filed", `${filed} of ${pending.length}`)
  if (failures.length) printKV("Failed", failures.join(", "))
  prompts.outro(failures.length ? "Done with errors" : success("Done"))
}

export const PlatformMeetingsCommand = cmd({
  command: "meetings [session]",
  describe: "list recorded meetings (Wispr Flow + rabbit R1) and file a summary on a bloq",
  builder: (y) =>
    y
      .positional("session", { type: "string", describe: "session id (or its first 8 chars). Omit to list." })
      .option("source", {
        type: "string",
        choices: ["all", "wispr", "rabbit"],
        describe: "which recorder to read from (default: all when listing, rabbit when --ingest)",
      })
      .option("ingest", { type: "boolean", describe: "file every new meeting in the window, skipping ones already filed" })
      .option("days", { type: "number", default: 30, describe: "how far back to look for rabbit meeting mail" })
      .option("dry-run", { type: "boolean", describe: "with --ingest: show what would be filed, file nothing" })
      .option("resummarize", { type: "boolean", describe: "run the AI summary over a rabbit note that already has one" })
      .option("bloq", { type: "number", describe: "bloq id to file the summary under (default: config default_bloq_id)" })
      .option("list", { type: "string", default: "Meetings", describe: "list name on the bloq — created if absent" })
      .option("lead", { type: "number", describe: "also run `leads:meeting` intel for this lead id" })
      .option("speaker", { type: "array", describe: "label a diarised speaker, e.g. --speaker 2=Arthur" })
      .option("title", { type: "string", describe: "override the item title" })
      .option("agent", { alias: "a", type: "string", default: "420", describe: "agent used for extraction" })
      .option("raw", { type: "boolean", describe: "file the transcript verbatim, no AI summary" })
      .option("export", { type: "string", describe: "write the rendered transcript to this path and stop" })
      .option("limit", { type: "number", default: 15 })
      .option("json", { type: "boolean" })
      .option("timeout", { alias: "t", type: "number", default: 300 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Meetings")

    // Listing everything is harmless. BULK FILING everything is not: Wispr records system
    // audio continuously, so its sessions include voicemail, personal calls and whatever was
    // playing — and `--ingest` would publish all of it onto a bloq other people can read.
    // Rabbit recordings are deliberate: someone pressed record. So the batch path defaults
    // to the deliberate source, and sweeping in Wispr has to be asked for by name.
    const source = String(args.source ?? (args.ingest ? "rabbit" : "all")) as SourceId | "all"
    if (args.ingest && !args.source) {
      prompts.log.info(dim("Source defaulted to rabbit (deliberate recordings). Pass --source all to include Wispr."))
    }
    const bloqId = args.bloq ?? resolveDefaultBloqId()

    // ── ingest mode: file everything new in the window ───────────────────────
    if (args.ingest) {
      await runIngest({ ...args, source, bloqId })
      return
    }

    // ── list mode ────────────────────────────────────────────────────────────
    if (!args.session) {
      const { sessions, warnings } = listSessions(args.limit, { source, days: args.days })
      if (args.json) {
        await writeJson({ sessions: sessions.map(({ rabbit, ...rest }) => rest), warnings })
        return
      }
      for (const w of warnings) prompts.log.warn(w)
      if (!sessions.length) {
        // A source that failed has already been reported above. Saying "no meetings" on top
        // of that would overwrite a permission problem with a claim about the user's data.
        prompts.log.warn(warnings.length ? "No meetings from the sources that could be read." : "No meetings with a transcript yet.")
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const s of sessions) {
        const tag = s.source === "rabbit" ? "rabbit" : "wispr "
        console.log(
          `  ${dim(tag)} ${bold(s.id.slice(0, 10).padEnd(10))} ${dim(s.mtime.toISOString().slice(0, 16).replace("T", " "))}  ` +
            `${dim(`${s.duration} · ${s.segments} segs`)}`,
        )
        console.log(`    ${s.title ? s.title + " " : ""}${dim(s.preview)}`)
      }
      printDivider()
      console.log(dim(`  iris meetings <id> --bloq <bloqId>     file a summary`))
      console.log(dim(`  iris meetings <id> --export out.txt    just get the transcript`))
      console.log(dim(`  iris meetings --ingest --bloq <id>     file every new one at once`))
      prompts.outro("Done")
      return
    }

    // ── resolve the session (accept a prefix) ────────────────────────────────
    const { sessions: all, warnings } = listSessions(500, { source, days: args.days })
    for (const w of warnings) prompts.log.warn(w)
    const match = all.filter((s) => s.id === args.session || s.id.startsWith(String(args.session)))
    if (match.length === 0) {
      prompts.log.error(`No meeting matching "${args.session}". Run \`iris meetings\` to list.`)
      prompts.outro("Done")
      return
    }
    if (match.length > 1) {
      prompts.log.error(`"${args.session}" matches ${match.length} meetings — use more characters.`)
      prompts.outro("Done")
      return
    }
    const session = match[0]

    const { text: transcript, segments } = renderSession(session, parseSpeakers(args.speaker as string[]))

    // ── export only ──────────────────────────────────────────────────────────
    if (args.export) {
      writeFileSync(String(args.export), transcript, "utf-8")
      printKV("Session", session.id)
      printKV("Segments", String(segments))
      printKV("Written", String(args.export))
      prompts.outro(success("Exported"))
      return
    }

    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId(undefined)
    if (!userId) { prompts.outro("Done"); return }

    printDivider()
    printKV("Session", session.id)
    printKV("Source", session.source === "rabbit" ? "rabbit R1 (mailed note)" : "Wispr Flow (system audio)")
    if (session.title) printKV("Title", session.title)
    printKV("Recorded", session.mtime.toISOString().slice(0, 16).replace("T", " "))
    printKV("Segments", `${segments} · ${session.duration}`)
    printDivider()

    // ── summarise ────────────────────────────────────────────────────────────
    // A rabbit note ARRIVES summarised. Paying an agent to rewrite a summary the device
    // already wrote is slower, costs tokens, and can only lose detail — so its own write-up
    // is used unless --resummarize asks otherwise.
    let body = transcript
    if (session.source === "rabbit" && session.rabbit && !args.raw && !args.resummarize) {
      body = `${session.rabbit.summary}\n\n---\n\n<details><summary>Full transcript (${segments} segments)</summary>\n\n${transcript}\n</details>`
    } else if (!args.raw) {
      const spin = prompts.spinner()
      spin.start("Extracting summary, decisions and action items…")
      try {
        const result = await streamAgentChat({
          agentId: Number(args.agent),
          message: EXTRACT_PROMPT(transcript),
          userId,
          timeoutSecs: args.timeout,
        })
        if (!result.ok) throw new Error(result.error ?? "extraction failed")
        body = `${result.content}\n\n---\n\n<details><summary>Full transcript (${segments} segments)</summary>\n\n${transcript}\n</details>`
        spin.stop("Extracted")
      } catch (e: any) {
        spin.stop("Extraction failed — filing the raw transcript instead")
        prompts.log.warn(String(e?.message ?? e))
        // Deliberately NOT fatal: a filed raw transcript is far better than a lost meeting.
      }
    }

    const stamp = session.mtime.toISOString().slice(0, 10)
    const title = String(args.title ?? defaultTitle(session, stamp))
    body = `${body}\n\n${ingestMarker(session)}`

    // ── file it on the bloq ──────────────────────────────────────────────────
    if (bloqId) {
      const listId = await resolveMeetingsList(userId, Number(bloqId), String(args.list))
      if (!listId) {
        prompts.log.error(`Could not find or create a "${args.list}" list on bloq ${bloqId}`)
        prompts.outro("Done")
        return
      }
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/${bloqId}/lists/${listId}/items`,
        { method: "POST", body: JSON.stringify({ title, content: body }) },
      )
      if (!res.ok) {
        prompts.log.error(`Filing failed: HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const made = (await res.json()) as any
      const itemId = made?.data?.id ?? made?.id
      printKV("Filed", `bloq ${bloqId} → "${args.list}" list${itemId ? ` (item #${itemId})` : ""}`)
    }

    // ── optionally push through the lead-intel path too ──────────────────────
    if (args.lead) {
      const tmp = join(tmpdir(), `meeting-${session.id.slice(0, 10)}.txt`)
      writeFileSync(tmp, transcript, "utf-8")
      printKV("Lead intel", `run: iris leads:meeting ${args.lead} ${tmp} --create-tasks`)
    }

    if (!bloqId && !args.lead) {
      console.log("")
      console.log(body.slice(0, 1800))
      console.log(dim("\n  (pass --bloq <id> to file this, or --export <path> to save it)"))
    }

    prompts.outro(success("Done"))
  },
})
