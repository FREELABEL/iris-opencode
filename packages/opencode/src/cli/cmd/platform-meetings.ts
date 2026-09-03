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
  streamAgentChat, isNonInteractive, writeJson } from "./iris-api"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"
import { createHash } from "crypto"
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

/**
 * A CONTENT fingerprint, because the id alone is not enough (#183460).
 *
 * rabbit RE-SENDS a recording as a NEW email with a NEW message id, so the id marker above
 * says "never seen this" about a meeting already sitting on the board. That filed
 * 'Trial Licensing and Agent Sandbox Architecture' twice on bloq 639.
 *
 * mtime is deliberately excluded — it is the mail's arrival time, the one thing that DOES
 * change on a re-send. Everything here comes from the recording itself, so the same meeting
 * fingerprints the same however many times it is mailed.
 */
export const contentFingerprint = (session: Session) =>
  createHash("sha1")
    .update([session.title ?? "", session.segments, session.duration, session.preview].join("\u0000"))
    .digest("hex")
    .slice(0, 16)

const fingerprintMarker = (session: Session) => `<!-- iris-meeting-fp: ${contentFingerprint(session)} -->`

/**
 * WHERE A MEETING LANDS.
 *
 * The bloq is the PROJECT and the caller chooses it; the list is a fixed convention
 * ("Meetings", created on demand) so nothing has to be decided twice.
 *
 * The choice is remembered PER ACCOUNT, not per machine. `default_bloq_id` in config.json
 * is deliberately not consulted: it belongs to `iris announce`, and one machine here signs
 * in as more than one account — a single machine-wide destination would file one account's
 * meetings onto the other account's board, and a meeting transcript is exactly the payload
 * you cannot afford to misroute.
 *
 * There is also no auto-create fallback, on purpose. Elsewhere in this CLI a missing
 * destination invents a bloq and files into it. For a transcript that is wrong: it can carry
 * client conversation or PHI, so a run that does not know where to put it must STOP and say
 * so rather than pick somewhere plausible.
 */
const PREFS_PATH = join(homedir(), ".iris", "meetings.json")

type MeetingPrefs = Record<string, { bloqId: number; list?: string }>

function readPrefs(): MeetingPrefs {
  try {
    if (existsSync(PREFS_PATH)) return JSON.parse(readFileSync(PREFS_PATH, "utf-8")) as MeetingPrefs
  } catch {}
  return {}
}

function rememberDestination(userId: number, bloqId: number, list: string) {
  try {
    const prefs = readPrefs()
    prefs[String(userId)] = { bloqId, list }
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), "utf-8")
  } catch {
    // Not being able to remember is a papercut, not a failure — the run still files.
  }
}

async function fetchBloqs(userId: number): Promise<any[]> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=100&simplified=1`)
  if (!res.ok) return []
  const j = (await res.json()) as { data?: any[] }
  return j?.data ?? []
}

/**
 * Resolve the destination bloq: explicit flag, then this account's remembered choice, then
 * ask. Returns null when it cannot be settled — callers must treat that as "file nothing".
 */
async function resolveDestinationBloq(args: any, userId: number): Promise<number | null> {
  const remembered = readPrefs()[String(userId)]

  if (args.bloq) {
    // Seed the default from the first explicit --bloq, but never overwrite one that already
    // exists: filing a single meeting to a client's board is a one-off, not a new home for
    // everything after it.
    if (!remembered?.bloqId) rememberDestination(userId, Number(args.bloq), String(args.list))
    return Number(args.bloq)
  }

  if (remembered?.bloqId) return Number(remembered.bloqId)

  if (isNonInteractive() || args.json) {
    prompts.log.error(
      "No destination for this account. Pass --bloq <id> once and it is remembered, " +
        "or run this interactively to pick a project.",
    )
    return null
  }

  const bloqs = await fetchBloqs(userId)
  if (!bloqs.length) {
    prompts.log.error("No bloqs on this account to file into. Create one, then pass --bloq <id>.")
    return null
  }
  const pick = await prompts.select({
    message: "File meetings into which project?",
    options: bloqs.slice(0, 50).map((b: any) => ({ value: b.id, label: `${b.name} (#${b.id})` })),
  })
  if (prompts.isCancel(pick)) return null

  rememberDestination(userId, Number(pick), String(args.list))
  prompts.log.info(dim(`Remembered for this account — change it any time with --bloq <id>.`))
  return Number(pick)
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
async function filedMarkers(userId: number, bloqId: number): Promise<{ ids: Set<string>; fingerprints: Set<string> }> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500&fields=id,title,content`)
  if (!res.ok) return { ids: new Set(), fingerprints: new Set() }
  const j = (await res.json()) as any
  const raw = j?.data
  const items: any[] = Array.isArray(raw) ? raw : (raw?.items ?? [])
  const ids = new Set<string>()
  const fingerprints = new Set<string>()
  for (const it of items) {
    const content = String(it?.content ?? "")
    for (const m of content.matchAll(/<!--\s*iris-meeting:\s*([^\s>]+)\s*-->/g)) ids.add(m[1])
    for (const m of content.matchAll(/<!--\s*iris-meeting-fp:\s*([^\s>]+)\s*-->/g)) fingerprints.add(m[1])
  }
  return { ids, fingerprints }
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

  if (!sessions.length) {
    prompts.log.warn(`No meetings in the last ${args.days} days from ${args.source === "all" ? "any source" : args.source}.`)
    prompts.outro("Done")
    return
  }

  if (!(await requireAuth())) { prompts.outro("Done"); return }
  const userId = await requireUserId(undefined)
  if (!userId) { prompts.outro("Done"); return }

  const bloqId = await resolveDestinationBloq(args, userId)
  if (!bloqId) { prompts.outro("Done"); return }

  // Reading the bloq is safe; RESOLVING the list is not, because it CREATES the list when
  // it is absent. So a dry run has to finish before that, or "show me what would happen"
  // leaves a new list behind — which is exactly the thing a dry run promises not to do.
  const already = await filedMarkers(userId, Number(bloqId))
  // Either signal is enough: the id catches a re-run, the fingerprint catches a re-send.
  const pending = sessions.filter(
    (s) => !already.ids.has(`${s.source}/${s.id}`) && !already.fingerprints.has(contentFingerprint(s)),
  )
  const dryRun = Boolean(args["dry-run"] ?? args.dryRun)

  printDivider()
  printKV("Destination", `bloq ${bloqId} → "${args.list}" list`)
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

  const listId = await resolveMeetingsList(userId, Number(bloqId), String(args.list))
  if (!listId) {
    prompts.log.error(`Could not find or create a "${args.list}" list on bloq ${bloqId}`)
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
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists/${listId}/items`, {
        method: "POST",
        body: JSON.stringify({
          title: defaultTitle(s, stamp),
          content: `${body}\n\n${ingestMarker(s)}\n${fingerprintMarker(s)}`,
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
      .option("bloq", { type: "number", describe: "bloq id (project) to file under — remembered per account after the first time" })
      .option("file", { type: "boolean", describe: "file this meeting to the remembered project (or pick one)" })
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
    // ── ingest mode: file everything new in the window ───────────────────────
    if (args.ingest) {
      await runIngest({ ...args, source })
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

    // Only ask where to file when filing was actually requested. A bare `iris meetings <id>`
    // is a read — interrupting it with a destination prompt would be an answer to a question
    // nobody asked.
    let bloqId: number | null = null
    if (args.bloq || args.file) {
      bloqId = await resolveDestinationBloq(args, userId)
      if (!bloqId) { prompts.outro("Done"); return }
    }

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
    body = `${body}\n\n${ingestMarker(session)}\n${fingerprintMarker(session)}`

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
