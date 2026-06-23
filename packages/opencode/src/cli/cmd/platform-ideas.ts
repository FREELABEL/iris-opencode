import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, dim, bold, success, IRIS_API } from "./iris-api"
import { transcribeAudio } from "../lib/transcription"

// ============================================================================
// iris ideas capture — voice/text idea capture (#1089)
//
// audio (or already-transcribed text) → transcription seam (Layer 2, default
// on-device whisper.cpp) → nano structuring into titled ideas → each posted as
// a note on a lead. Input is pluggable: --audio transcribes; --text/stdin lets
// WhisperFlow / any dictation tool feed the SAME pipeline.
// ============================================================================

const DEFAULT_LEAD = 28307 // David Baker
const DEFAULT_MODEL = "iris/gpt-4.1-nano" // nano-only per global rule

interface Idea {
  title: string
  body: string
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8").trim()
}

/** nano pass: split raw dictation into discrete, titled ideas. */
async function structureIdeas(transcript: string, model: string): Promise<Idea[]> {
  const sys =
    "You turn a person's raw dictated thoughts into a clean list of discrete ideas. "
    + "Split the input into self-contained ideas (one idea = one thing they want to do/remember/explore). "
    + "Clean up filler and false starts but keep their meaning and voice. "
    + 'Return ONLY a JSON array, each item {"title": "<=8 words", "body": "1-3 cleaned sentences"}. No prose, no code fences.'
  const res = await irisFetch("/api/v6/openai/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: transcript },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    }),
  }, IRIS_API)
  if (!res.ok) {
    throw new Error(`Idea structuring failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as any
  let content = String(data?.choices?.[0]?.message?.content ?? "").trim()
  const m = content.match(/\[[\s\S]*\]/)
  if (m) content = m[0]
  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    // Fail soft: treat the whole transcript as one idea rather than losing it.
    return [{ title: "Captured idea", body: transcript.slice(0, 500) }]
  }
  if (!Array.isArray(parsed)) return [{ title: "Captured idea", body: transcript.slice(0, 500) }]
  return parsed
    .map((i: any) => ({ title: String(i?.title ?? "").trim() || "Idea", body: String(i?.body ?? "").trim() }))
    .filter((i: Idea) => i.body)
}

const IdeasCaptureCommand = cmd({
  command: "capture",
  aliases: ["add"],
  describe: "capture voice/text ideas → structured → posted to a lead's notes",
  builder: (y) =>
    y
      .option("audio", { type: "string", describe: "audio file to transcribe (m4a/mp3/wav)" })
      .option("text", { type: "string", describe: "already-transcribed text (e.g. from WhisperFlow); skips transcription" })
      .option("lead", { type: "number", default: DEFAULT_LEAD, describe: "lead ID to attach ideas to" })
      .option("provider", { type: "string", describe: "transcription provider (default: whisper-local / on-device)" })
      .option("language", { type: "string", describe: "ISO 639-1 hint for transcription (e.g. 'en')" })
      .option("model", { type: "string", default: DEFAULT_MODEL, describe: "LLM for structuring (nano only)" })
      .option("dry-run", { type: "boolean", default: false, describe: "show parsed ideas without posting" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Ideas Capture")

    // 1. Get the transcript text.
    let transcript = ""
    let source = "text"
    if (args.text) {
      transcript = String(args.text).trim()
    } else if (args.audio) {
      const sp = prompts.spinner()
      sp.start(`Transcribing (${args.provider || "whisper-local"})…`)
      try {
        const r = await transcribeAudio(String(args.audio), { provider: args.provider, language: args.language })
        transcript = r.text.trim()
        source = r.provider
        sp.stop(`Transcribed via ${r.provider}`)
      } catch (e) {
        sp.stop("Transcription failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.outro("Done")
        return
      }
    } else {
      transcript = await readStdin()
    }

    if (!transcript) {
      prompts.log.error("No input. Provide --audio <file>, --text \"…\", or pipe text via stdin.")
      prompts.outro("Done")
      return
    }

    // 2. Structure into ideas (nano).
    const sp2 = prompts.spinner()
    sp2.start("Structuring ideas…")
    let ideas: Idea[]
    try {
      const token = await requireAuth()
      if (!token) { sp2.stop("Not authenticated", 1); prompts.outro("Done"); return }
      ideas = await structureIdeas(transcript, String(args.model))
    } catch (e) {
      sp2.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
      return
    }
    sp2.stop(`${ideas.length} idea(s)`)

    if (args.json) {
      console.log(JSON.stringify({ source, lead: args.lead, dry_run: !!args["dry-run"], ideas }, null, 2))
    } else {
      console.log(dim("  " + "─".repeat(60)))
      for (const i of ideas) console.log(`  💡 ${bold(i.title)}\n     ${dim(i.body)}`)
      console.log(dim("  " + "─".repeat(60)))
    }

    if (args["dry-run"]) {
      prompts.outro(`Dry run — ${ideas.length} idea(s), nothing posted.`)
      return
    }

    // 3. Post each idea as a lead note.
    const sp3 = prompts.spinner()
    sp3.start(`Posting ${ideas.length} idea(s) to lead ${args.lead}…`)
    let posted = 0
    for (const i of ideas) {
      const res = await irisFetch(`/api/v1/leads/${args.lead}/notes`, {
        method: "POST",
        body: JSON.stringify({ message: `💡 ${i.title}\n\n${i.body}`, type: "note" }),
      })
      if (res.ok) posted++
    }
    sp3.stop(success(`posted ${posted}/${ideas.length} idea(s) to lead ${args.lead}`))
    prompts.outro("Done")
  },
})

export const PlatformIdeasCommand = cmd({
  command: "ideas",
  describe: "capture and manage ideas (voice/text → lead notes)",
  builder: (y) => y.command(IdeasCaptureCommand).demandCommand(),
  async handler() {},
})
