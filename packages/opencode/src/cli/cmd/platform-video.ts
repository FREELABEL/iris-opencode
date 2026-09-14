import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, success } from "./iris-api"
import { transcribeLocal, type TranscriptSegment } from "../lib/transcription"
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/**
 * The timeline object — the motion→mass half of the Kinetic clutch (EPIC #185317).
 *
 * Kinetics converts stored inertia into motion. Nothing converted motion back: an agent could
 * pan a camera and record, and what returned was an MP4 — a file, not mass. It could not say
 * what it saw.
 *
 * A timeline is a list of SPANS, appended as JSONL, one file per recording session. Spans come
 * from four sources and the cost order is the build order:
 *
 *   agent_act  free    exact — the agent caused it and it is on the ledger
 *   marker     free    human-judged, timestamped at the moment
 *   asr        cheap   high for words, poor for names and numbers
 *   vision     dear    inferred, and the only source that can be confidently wrong
 *
 * `source` is never dropped. "Someone entered frame" reads identically whether a minted agent
 * was commanded there or a model guessed it from a blurry frame, and those are not the same
 * claim.
 */

export type Span = {
  t0: number | null
  t1: number | null
  kind: string
  label: string
  source: "agent_act" | "marker" | "asr" | "vision"
  confidence: number
  unanchored?: boolean
  evidence?: Record<string, unknown>
}

const TIMELINE_DIR = join(homedir(), ".iris", "timelines")

function timelinePath(session: string): string {
  return join(TIMELINE_DIR, `${session}.jsonl`)
}

export function listSessions(): { session: string; spans: number; sources: string[]; mtime: Date }[] {
  if (!existsSync(TIMELINE_DIR)) return []
  return readdirSync(TIMELINE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = join(TIMELINE_DIR, f)
      const spans = readSpans(f.replace(/\.jsonl$/, ""))
      return {
        session: f.replace(/\.jsonl$/, ""),
        spans: spans.length,
        sources: [...new Set(spans.map((s) => s.source))].sort(),
        mtime: statSync(p).mtime,
      }
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

/**
 * A malformed line is SKIPPED, not fatal. A timeline is append-only from several writers; one
 * truncated write must not make the rest of the recording unreadable.
 */
export function readSpans(session: string): Span[] {
  const p = timelinePath(session)
  if (!existsSync(p)) return []
  const out: Span[] = []
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* skip */
    }
  }
  // Unanchored spans have no t0 and sort last — they are real, they just cannot say when.
  return out.sort((a, b) => (a.t0 ?? Number.MAX_SAFE_INTEGER) - (b.t0 ?? Number.MAX_SAFE_INTEGER))
}

export function appendSpans(session: string, spans: Span[]): string {
  mkdirSync(TIMELINE_DIR, { recursive: true })
  const p = timelinePath(session)
  appendFileSync(p, spans.map((s) => JSON.stringify(s)).join("\n") + "\n")
  return p
}

export function segmentsToSpans(segments: TranscriptSegment[], evidence: Record<string, unknown>): Span[] {
  return segments.map((s) => ({
    t0: s.t0,
    t1: s.t1,
    kind: "speech",
    label: s.text,
    source: "asr" as const,
    // Not 1.0, deliberately. ASR is fluent, confident and wrong in exactly the places that
    // matter — names and numbers — and it never marks which words those are.
    confidence: 0.8,
    evidence,
  }))
}

function fmtTime(t: number | null): string {
  if (t === null) return "  --:--"
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(1).padStart(4, "0")
  return `${String(m).padStart(3)}:${s}`
}

const SOURCE_TAG: Record<string, string> = {
  agent_act: "ACT ",
  marker: "MARK",
  asr: "SAID",
  vision: "SAW ",
}

const TimelineCommand = cmd({
  command: "timeline [session]",
  describe: "show a recording's spans — or list the sessions that have one",
  builder: (y) =>
    y
      .positional("session", { type: "string", describe: "session id (omit to list)" })
      .option("source", { type: "string", describe: "only this source: agent_act|marker|asr|vision" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const session = args.session as string | undefined

    if (!session) {
      const sessions = listSessions()
      if (args.json) return void UI.println(JSON.stringify(sessions, null, 2))
      if (!sessions.length) {
        UI.println(`  ${dim("No timelines yet.")}`)
        UI.println(`  ${dim("A marker makes one:  iris obs marker \"hook\"")}`)
        return
      }
      UI.println(`  ${sessions.length} timeline(s)`)
      UI.empty()
      for (const s of sessions) {
        UI.println(`  ${s.session}  ${dim(`${s.spans} span(s)`)}  ${dim(s.sources.join(" "))}`)
      }
      return
    }

    let spans = readSpans(session)
    if (args.source) spans = spans.filter((s) => s.source === args.source)

    if (args.json) return void UI.println(JSON.stringify(spans, null, 2))

    // An empty timeline and an unreadable one must not print the same thing.
    if (!existsSync(timelinePath(session))) {
      UI.println(`  ${dim(`No timeline called ${session}.`)}`)
      UI.println(`  ${dim("iris video timeline    — list what exists")}`)
      process.exitCode = 1
      return
    }
    if (!spans.length) {
      UI.println(`  ${dim(`${session} exists and holds no spans${args.source ? ` from ${args.source}` : ""}.`)}`)
      return
    }

    const free = spans.filter((s) => s.source === "agent_act" || s.source === "marker").length
    UI.println(`  ${session}  ${dim(`${spans.length} span(s)`)}`)
    UI.empty()
    for (const s of spans) {
      const tag = SOURCE_TAG[s.source] ?? s.source
      const when = s.t1 !== null && s.t1 !== s.t0 ? `${fmtTime(s.t0)}–${fmtTime(s.t1).trim()}` : fmtTime(s.t0)
      const note = s.unanchored ? dim("  (no recording — unanchored)") : ""
      UI.println(`  ${dim(tag)} ${when}  ${s.label.slice(0, 76)}${note}`)
    }
    UI.empty()
    UI.println(`  ${dim(`${free} of ${spans.length} span(s) cost nothing — they came from acts and markers.`)}`)
  },
})

const IndexCommand = cmd({
  command: "index <audio>",
  describe: "add spoken spans to a timeline — transcribes on-device by default",
  builder: (y) =>
    y
      .positional("audio", { type: "string", demandOption: true, describe: "audio or video file" })
      .option("session", { type: "string", demandOption: true, describe: "timeline to append to" })
      .option("language", { type: "string", describe: "ISO 639-1 hint, e.g. en" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const file = args.audio as string
    if (!existsSync(file)) {
      prompts.log.error(`Not found: ${file}`)
      process.exitCode = 1
      return
    }
    const session = args.session as string
    const spinner = prompts.spinner()
    spinner.start(`Transcribing on-device…`)
    try {
      const segs: TranscriptSegment[] = []
      const text = await transcribeLocal(file, {
        language: args.language as string | undefined,
        onSegments: (s) => segs.push(...s),
      })

      // whisper produced words but no timings: say so rather than writing spans with no time,
      // which would read downstream as "this was said at the start".
      if (!segs.length) {
        spinner.stop(text.trim() ? "Transcribed, but with no timings" : "Nothing transcribed", 1)
        if (text.trim()) {
          prompts.log.warn("No segment timings came back, so no spans were written.")
          prompts.log.info("A span without a time is not a span. The text is still on stdout below.")
          UI.println(text.trim().slice(0, 400))
        }
        process.exitCode = 1
        return
      }

      const spans = segmentsToSpans(segs, { file, provider: "whisper-local", on_device: true })
      const path = appendSpans(session, spans)
      spinner.stop(success(`✓ ${spans.length} spoken span(s) → ${session}`))
      if (args.json) UI.println(JSON.stringify(spans, null, 2))
      else {
        UI.println(`  ${dim(path)}`)
        UI.println(`  ${dim(`See it:  iris video timeline ${session}`)}`)
      }
    } catch (err) {
      spinner.stop("Failed", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

export const VideoCommand = cmd({
  command: "video <command>",
  describe: "recording timelines — spans you can query instead of a file you re-watch",
  builder: (y) => y.command(TimelineCommand).command(IndexCommand).demandCommand(1),
  async handler() {},
})
