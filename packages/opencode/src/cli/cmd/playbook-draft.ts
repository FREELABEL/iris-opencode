import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, irisFetch, requireAuth, IRIS_API } from "./iris-api"
import { transcribeLocal } from "../lib/transcription"
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { join, resolve, extname } from "path"

// ============================================================================
// iris playbook draft — the missing link between talking and having a procedure
//
// The pitch is "walk through it once and it becomes the procedure". Everything on both ends of
// that sentence already existed: `iris transcribe` produced text, and playbooks ran, synced to
// .claude/skills/, and published to the marketplace. Nothing joined them. Recording a
// walkthrough got you a .txt in ~/.iris/transcripts and a manual authoring job — which is the
// part a person was hoping to skip.
//
// This drafts a PLAYBOOK.md from speech. It does NOT run it, and it does not pretend the draft
// is finished: a transcript of somebody thinking out loud is a starting point, and a generated
// procedure that presents itself as authoritative is worse than no procedure at all.
// ============================================================================

const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".aiff", ".aac", ".ogg", ".flac", ".mp4", ".mov", ".webm"])

interface DraftedStep {
  id: string
  title: string
  instruction: string
}

interface Drafted {
  name: string
  description: string
  steps: DraftedStep[]
  notes: string[]
}

/** Fetch the caller's brand vocabulary so the walkthrough's domain nouns survive transcription. */
async function fetchGlossary(): Promise<string | undefined> {
  try {
    const res = await irisFetch("/api/v1/transcribe/glossary", {}, IRIS_API)
    if (!res.ok) return undefined
    const body = (await res.json()) as any
    const g = body?.data?.glossary
    return typeof g === "string" && g.trim() ? g : undefined
  } catch {
    return undefined
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/**
 * Turn spoken narration into a structured procedure.
 *
 * Deliberately asks for INSTRUCTIONS, never commands. See writePlaybook for why.
 */
async function draftFromTranscript(transcript: string, model: string): Promise<Drafted> {
  const sys = [
    "You turn a spoken walkthrough of a process into a structured procedure.",
    "The speaker is describing how they do something, out loud, with false starts and asides.",
    "Extract the actual steps in the order they are performed. Merge duplicated narration.",
    "Drop commentary that is not part of the procedure, but keep warnings and gotchas as notes.",
    "Each step is ONE action with a clear outcome. Write instructions a competent colleague could",
    "follow — not shell commands, and never invent a command, path, flag, or URL the speaker did",
    "not say. If they were vague, say so plainly in the instruction rather than guessing.",
    'Return ONLY JSON: {"name":"kebab-case-name","description":"one sentence","steps":[{"id":"kebab-id","title":"<=8 words","instruction":"1-4 sentences"}],"notes":["gotcha or warning"]}',
    "No prose, no code fences.",
  ].join(" ")

  const res = await irisFetch(
    "/api/v6/openai/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: transcript },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      }),
    },
    IRIS_API,
  )

  if (!res.ok) {
    throw new Error(`Draft failed (HTTP ${res.status}). ${(await res.text().catch(() => "")).slice(0, 200)}`)
  }

  const data = (await res.json()) as any
  let content = String(data?.choices?.[0]?.message?.content ?? "").trim()
  const m = content.match(/\{[\s\S]*\}/)
  if (m) content = m[0]

  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error("The model did not return a usable procedure. The transcript is still saved.")
  }

  const steps: DraftedStep[] = Array.isArray(parsed?.steps)
    ? parsed.steps
        .map((s: any, i: number) => ({
          id: slugify(String(s?.id ?? s?.title ?? `step-${i + 1}`)) || `step-${i + 1}`,
          title: String(s?.title ?? "").trim() || `Step ${i + 1}`,
          instruction: String(s?.instruction ?? "").trim(),
        }))
        .filter((s: DraftedStep) => s.instruction)
    : []

  if (!steps.length) {
    throw new Error("No steps could be extracted. Was the recording a walkthrough of a process?")
  }

  return {
    name: slugify(String(parsed?.name ?? "")) || "drafted-playbook",
    description: String(parsed?.description ?? "").trim() || "Drafted from a spoken walkthrough.",
    steps,
    notes: Array.isArray(parsed?.notes) ? parsed.notes.map((n: any) => String(n).trim()).filter(Boolean) : [],
  }
}

/**
 * Write the PLAYBOOK.md.
 *
 * EVERY STEP IS `mode: agent`, AND THAT IS NOT A LIMITATION.
 *
 * The obvious version of this feature emits `mode: shell` blocks so the playbook runs
 * immediately. Consider what that means: a transcription of someone saying "and then I clear out
 * the old records" becomes a shell block, in a file that `iris playbook run` executes, drafted by
 * a model from audio that may itself have been misheard. The glossary work upstream exists
 * precisely because transcription mishears domain nouns — `bloq` still comes back as `block`.
 *
 * So a drafted step is an instruction for an agent or a person to carry out, which is reviewable
 * before anything happens. Turning a reviewed instruction into a shell step is a deliberate edit
 * by someone who knows the command. That edit is the point at which a human takes responsibility,
 * and it should be explicit.
 */
function renderPlaybook(d: Drafted, sourceNote: string): string {
  const lines: string[] = [
    "---",
    `name: ${d.name}`,
    `description: ${d.description}`,
    "version: 2",
    "on-error: stop",
    "---",
    "",
    `# ${d.name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())}`,
    "",
    d.description,
    "",
    "> **Draft.** Generated from a spoken walkthrough and not yet verified. Read every step before",
    "> running it. Steps are written as instructions rather than commands on purpose — see the",
    "> note at the bottom.",
    "",
    `_Source: ${sourceNote}_`,
    "",
  ]

  if (d.notes.length) {
    lines.push("## Notes from the walkthrough", "")
    for (const n of d.notes) lines.push(`- ${n}`)
    lines.push("")
  }

  lines.push("## Steps", "")

  for (const s of d.steps) {
    lines.push(`### step:${s.id} ${s.title}`, "")
    lines.push("```yaml", "mode: agent", "```", "")
    lines.push("```", s.instruction, "```", "")
  }

  lines.push(
    "---",
    "",
    "## Why these steps are instructions, not commands",
    "",
    "This was drafted from speech. Transcription mishears domain terms, and a model filling in a",
    "command the speaker never said is how a procedure quietly acquires a step nobody approved.",
    "Each step is an instruction an agent or a person carries out and can be checked first.",
    "",
    "Promote a step to `mode: shell` yourself once you know the exact command. That edit is where",
    "a human takes responsibility for what runs, and it should be deliberate.",
    "",
  )

  return lines.join("\n")
}

export const PlaybookDraftCommand = cmd({
  command: "draft <input>",
  describe: "draft a playbook from a recorded walkthrough (audio file or transcript)",
  builder: (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        demandOption: true,
        describe: "Audio file to transcribe, or a .txt/.md transcript",
      })
      .option("name", { type: "string", describe: "Override the generated playbook name" })
      // The proxy namespaces models by provider; a bare "gpt-4.1-nano" 404s. Nano-only per the
      // standing rule — this is extraction from a transcript, not reasoning.
      .option("model", { type: "string", default: "iris/gpt-4.1-nano", describe: "Model used to structure the steps (nano only)" })
      .option("output", { type: "string", describe: "Write here instead of .iris/playbooks/<name>/PLAYBOOK.md" })
      .option("force", { type: "boolean", default: false, describe: "Overwrite an existing playbook of the same name" })
      .option("json", { type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  Playbook Draft")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const input = resolve(String(args.input))
    if (!existsSync(input)) {
      prompts.log.error(`Not found: ${input}`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 1. Get the transcript -------------------------------------------------
    let transcript: string
    let sourceNote: string

    if (AUDIO_EXT.has(extname(input).toLowerCase())) {
      const glossary = await fetchGlossary()
      const sp = prompts.spinner()
      sp.start(glossary ? "Transcribing (on-device, brand vocabulary)…" : "Transcribing (on-device)…")
      try {
        transcript = await transcribeLocal(input, { prompt: glossary })
        sp.stop("Transcribed")
      } catch (e) {
        // No server fallback here on purpose. `iris transcribe` owns that chain; duplicating it
        // would mean two places to fix the next time it changes.
        sp.stop("Transcription failed", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.log.info(dim("Transcribe it first with `iris transcribe`, then pass the .txt here."))
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      sourceNote = `spoken walkthrough, ${input.split("/").pop()}`
    } else {
      transcript = readFileSync(input, "utf8").trim()
      sourceNote = `transcript, ${input.split("/").pop()}`
    }

    if (transcript.length < 80) {
      // A three-word recording produces a confident, empty procedure. Say so instead.
      prompts.log.error("That transcript is too short to be a walkthrough of anything.")
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 2. Structure it -------------------------------------------------------
    const sp2 = prompts.spinner()
    sp2.start("Drafting the procedure…")
    let drafted: Drafted
    try {
      drafted = await draftFromTranscript(transcript, String(args.model))
      sp2.stop("Drafted")
    } catch (e) {
      sp2.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    if (args.name) drafted.name = slugify(String(args.name))

    // ---- 3. Write it -----------------------------------------------------------
    const target = args.output
      ? resolve(String(args.output))
      : join(process.cwd(), ".iris", "playbooks", drafted.name, "PLAYBOOK.md")

    if (existsSync(target) && !args.force) {
      // Overwriting somebody's authored playbook with a draft is not recoverable from here.
      prompts.log.error(`${target} already exists. Pass --force to overwrite, or --name for a different one.`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, renderPlaybook(drafted, sourceNote))

    if (args.json) {
      console.log(JSON.stringify({ name: drafted.name, path: target, steps: drafted.steps.length, notes: drafted.notes }, null, 2))
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Drafted:")}  ${highlight(drafted.name)}  ${dim(`${drafted.steps.length} steps`)}`)
    console.log(`  ${bold("Written:")}  ${highlight(target)}`)
    printDivider()
    console.log()
    for (const s of drafted.steps) console.log(`  ${dim("·")} ${s.title}`)
    console.log()
    console.log(`  ${success("Next")} — this is a draft, so read it before you trust it:`)
    console.log(`    ${dim("$")} iris playbook show ${drafted.name}`)
    console.log(`    ${dim("$")} iris playbook sync            ${dim("# → .claude/skills/, usable by Claude")}`)
    console.log(`    ${dim("$")} iris playbook publish ${drafted.name}   ${dim("# → marketplace, when it is right")}`)
    console.log()

    prompts.outro("Done")
  },
})
