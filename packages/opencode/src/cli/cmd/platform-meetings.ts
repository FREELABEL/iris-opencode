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
  streamAgentChat,
} from "./iris-api"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"

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
 */
const WISPR_MEETINGS = join(
  homedir(),
  "Library",
  "Application Support",
  "Wispr Flow",
  "meetings",
)

type Segment = { timestamp: string; text: string; speaker?: { id?: number } }
type Session = { id: string; dir: string; mtime: Date; segments: number; duration: string; preview: string }

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

function listSessions(limit = 15): Session[] {
  if (!existsSync(WISPR_MEETINGS)) return []
  return readdirSync(WISPR_MEETINGS)
    .map(readSession)
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit)
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

export const PlatformMeetingsCommand = cmd({
  command: "meetings [session]",
  describe: "list recorded MEETINGS from Wispr Flow and file a summary on a bloq (see `iris wispr import` for dictation snippets)",
  builder: (y) =>
    y
      .positional("session", { type: "string", describe: "session id (or its first 8 chars). Omit to list." })
      .option("bloq", { type: "number", describe: "bloq id to file the summary under" })
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
    prompts.intro("◈  Wispr Flow Meetings")

    if (!existsSync(WISPR_MEETINGS)) {
      prompts.log.error(`No Wispr Flow meetings directory at ${WISPR_MEETINGS}`)
      prompts.outro("Done")
      return
    }

    // ── list mode ────────────────────────────────────────────────────────────
    if (!args.session) {
      const sessions = listSessions(args.limit)
      if (args.json) {
        console.log(JSON.stringify(sessions, null, 2))
        return
      }
      if (!sessions.length) {
        prompts.log.warn("No meetings with a refined transcript yet.")
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const s of sessions) {
        console.log(
          `  ${bold(s.id.slice(0, 8))}  ${dim(s.mtime.toISOString().slice(0, 16).replace("T", " "))}  ` +
            `${dim(`${s.duration} · ${s.segments} segs`)}`,
        )
        console.log(`    ${dim(s.preview)}`)
      }
      printDivider()
      console.log(dim(`  iris meetings <id> --bloq <bloqId>     file a summary`))
      console.log(dim(`  iris meetings <id> --export out.txt    just get the transcript`))
      prompts.outro("Done")
      return
    }

    // ── resolve the session (accept a prefix) ────────────────────────────────
    const all = listSessions(500)
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

    const { text: transcript, segments } = renderTranscript(session.id, parseSpeakers(args.speaker as string[]))

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
    printKV("Recorded", session.mtime.toISOString().slice(0, 16).replace("T", " "))
    printKV("Segments", `${segments} · ${session.duration}`)
    printDivider()

    // ── summarise ────────────────────────────────────────────────────────────
    let body = transcript
    if (!args.raw) {
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
    const title = String(args.title ?? `📞 Meeting — ${stamp} (${session.id.slice(0, 8)})`)

    // ── file it on the bloq ──────────────────────────────────────────────────
    if (args.bloq) {
      const listId = await resolveMeetingsList(userId, Number(args.bloq), String(args.list))
      if (!listId) {
        prompts.log.error(`Could not find or create a "${args.list}" list on bloq ${args.bloq}`)
        prompts.outro("Done")
        return
      }
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/${args.bloq}/lists/${listId}/items`,
        { method: "POST", body: JSON.stringify({ title, content: body }) },
      )
      if (!res.ok) {
        prompts.log.error(`Filing failed: HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const made = (await res.json()) as any
      const itemId = made?.data?.id ?? made?.id
      printKV("Filed", `bloq ${args.bloq} → "${args.list}" list${itemId ? ` (item #${itemId})` : ""}`)
    }

    // ── optionally push through the lead-intel path too ──────────────────────
    if (args.lead) {
      const tmp = join(tmpdir(), `wispr-${session.id.slice(0, 8)}.txt`)
      writeFileSync(tmp, transcript, "utf-8")
      printKV("Lead intel", `run: iris leads:meeting ${args.lead} ${tmp} --create-tasks`)
    }

    if (!args.bloq && !args.lead) {
      console.log("")
      console.log(body.slice(0, 1800))
      console.log(dim("\n  (pass --bloq <id> to file this, or --export <path> to save it)"))
    }

    prompts.outro(success("Done"))
  },
})
