import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, irisFetch, requireAuth, handleApiError } from "./iris-api"
import { resolveWalkthrough, extractJson, slugify } from "../lib/walkthrough"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"

// ============================================================================
// iris sop draft — the same walkthrough, written for a person
//
// A playbook and an SOP are not two formats of one thing. A playbook is what an agent executes:
// terse, ordered, no context, because the runtime supplies it. An SOP is what a human opens at
// 4pm on their second week, when the person who recorded the walkthrough is unavailable. It has
// to say who does this, what they need first, how to tell it worked, and what to do when it
// does not. Reformatting a playbook into headings produces a document that answers none of that
// and looks like it does.
//
// So this asks for different information from the same transcript, rather than restyling the
// playbook output.
// ============================================================================

interface SopStep {
  action: string
  /** How the operator knows the step succeeded. The part a generated procedure always omits. */
  expected: string
}

interface Sop {
  title: string
  purpose: string
  /** Who performs this. Vague is fine and honest; invented is not. */
  role: string
  prerequisites: string[]
  steps: SopStep[]
  verification: string[]
  pitfalls: string[]
  /** What the speaker never covered. Named rather than smoothed over. */
  gaps: string[]
}

const SYSTEM = [
  "You turn a spoken walkthrough into a standard operating procedure written for a HUMAN reader",
  "who has not done this before and cannot ask the speaker any questions.",
  "",
  "Rules:",
  "- Use only what the speaker actually said. Never invent a command, path, flag, URL, threshold,",
  "  role, or approval step. If they were vague, keep it vague rather than inventing precision.",
  "- Each step is one action, in the order performed, phrased as an instruction to the reader.",
  "- For each step give the expected result — how the reader knows it worked. If the speaker did",
  '  not say, write "not stated in the walkthrough" rather than guessing.',
  "- Keep warnings and gotchas the speaker mentioned; those are the most valuable part.",
  '- List in "gaps" anything a person would obviously need that the speaker never covered',
  "  (who approves it, how often it runs, what to do when a step fails, access required).",
  "  Be specific. This is what tells the author what to record next.",
  "",
  'Return ONLY JSON: {"title":"Title Case","purpose":"1-2 sentences","role":"who does this",',
  '"prerequisites":["..."],"steps":[{"action":"...","expected":"..."}],"verification":["..."],',
  '"pitfalls":["..."],"gaps":["..."]}',
  "No prose, no code fences.",
].join("\n")

function renderSop(s: Sop, source: string): string {
  const L: string[] = []
  const bullets = (xs: string[], empty: string) =>
    xs.length ? xs.map((x) => `- ${x}`) : [`- ${empty}`]

  L.push(`# ${s.title}`, "")
  L.push(
    "> **Draft — not yet approved.** Generated from a spoken walkthrough and not reviewed by",
    "> anyone. Check it against what actually happens before handing it to someone who is going",
    "> to follow it.",
    "",
  )
  L.push(`_Source: ${source}_`, "")

  L.push("## Purpose", "", s.purpose, "")
  L.push("## Who does this", "", s.role || "Not stated in the walkthrough.", "")

  L.push("## Before you start", "")
  L.push(...bullets(s.prerequisites, "Nothing stated in the walkthrough."))
  L.push("")

  L.push("## Procedure", "")
  L.push("| # | Do this | You should see |")
  L.push("|---|---------|----------------|")
  s.steps.forEach((st, i) => {
    const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim()
    L.push(`| ${i + 1} | ${cell(st.action)} | ${cell(st.expected || "Not stated in the walkthrough.")} |`)
  })
  L.push("")

  L.push("## How to tell it worked", "")
  L.push(...bullets(s.verification, "Not stated in the walkthrough."))
  L.push("")

  if (s.pitfalls.length) {
    L.push("## Known mistakes to avoid", "")
    L.push(...bullets(s.pitfalls, ""))
    L.push("")
  }

  // The most useful section, and the one a polished-looking generated SOP normally hides. An SOP
  // that silently omits "who approves this" reads as complete and gets followed as if it were.
  L.push("## Not covered in the walkthrough", "")
  if (s.gaps.length) {
    L.push(
      "These came up as missing while writing this up. Record a follow-up covering them, or answer",
      "them here by hand before this SOP is handed to anyone.",
      "",
    )
    L.push(...bullets(s.gaps, ""))
  } else {
    L.push("Nothing obvious. That is unusual for a first pass — read the procedure once more before", "trusting it.")
  }
  L.push("")

  L.push("---", "")
  L.push(
    "_Drafted by `iris sop draft`. Steps and expected results come from the recording; anything",
    "the speaker did not say is marked as such rather than filled in._",
    "",
  )

  return L.join("\n")
}

export const SopDraftCommand = cmd({
  command: "draft <input>",
  describe: "draft a human-readable SOP from a recorded walkthrough (audio or transcript)",
  builder: (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        demandOption: true,
        describe: "Audio file to transcribe, or a .txt/.md transcript",
      })
      .option("name", { type: "string", describe: "Override the generated file name" })
      .option("request", { type: "number", describe: "Also file it against this service request id" })
      .option("brand", { type: "number", describe: "Brand whose vocabulary to bias transcription toward" })
      .option("model", { type: "string", default: "iris/gpt-4.1-nano", describe: "Model used to structure it (nano only)" })
      .option("output", { type: "string", describe: "Write here instead of ./sops/<name>.md" })
      .option("force", { type: "boolean", default: false, describe: "Overwrite an existing file" })
      .option("json", { type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  SOP Draft")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    // ---- 1. Words -------------------------------------------------------------
    const sp = prompts.spinner()
    let walk
    try {
      walk = await resolveWalkthrough(String(args.input), {
        brandId: args.brand ? Number(args.brand) : undefined,
        onTranscribeStart: (hinted) =>
          sp.start(hinted ? "Transcribing (on-device, brand vocabulary)…" : "Transcribing (on-device)…"),
      })
      sp.stop("Transcribed")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 2. Structure ---------------------------------------------------------
    const sp2 = prompts.spinner()
    sp2.start("Writing it up…")
    let sop: Sop
    try {
      const raw = await extractJson<any>(SYSTEM, walk.transcript, String(args.model))
      sop = {
        title: String(raw?.title ?? "").trim() || "Untitled Procedure",
        purpose: String(raw?.purpose ?? "").trim() || "Not stated in the walkthrough.",
        role: String(raw?.role ?? "").trim(),
        prerequisites: asList(raw?.prerequisites),
        steps: Array.isArray(raw?.steps)
          ? raw.steps
              .map((s: any) => ({
                action: String(s?.action ?? "").trim(),
                expected: String(s?.expected ?? "").trim(),
              }))
              .filter((s: SopStep) => s.action)
          : [],
        verification: asList(raw?.verification),
        pitfalls: asList(raw?.pitfalls),
        gaps: asList(raw?.gaps),
      }
      if (!sop.steps.length) throw new Error("No steps could be extracted. Was this a walkthrough of a process?")
      sp2.stop("Written")
    } catch (e) {
      sp2.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 3. Save --------------------------------------------------------------
    const name = slugify(String(args.name ?? sop.title)) || "sop"
    const target = args.output ? resolve(String(args.output)) : join(process.cwd(), "sops", `${name}.md`)

    if (existsSync(target) && !args.force) {
      prompts.log.error(`${target} already exists. Pass --force to overwrite, or --name for a different one.`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const markdown = renderSop(sop, walk.source)
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, markdown)

    // ---- 4. Optionally file it against a service request ----------------------
    let filedAs: number | null = null
    if (args.request) {
      const res = await irisFetch(`/api/v1/services/requests/${Number(args.request)}/sops`, {
        method: "POST",
        body: JSON.stringify({ title: sop.title, description: sop.purpose, content: markdown }),
      })
      const ok = await handleApiError(res, "File SOP")
      if (ok) {
        const body = (await res.json()) as any
        filedAs = body?.data?.id ?? null
      }
      // A failed upload must not read as a failed draft — the file is written either way, and
      // saying "Done" over a silent 500 is the exact shape this codebase keeps getting wrong.
    }

    if (args.json) {
      console.log(JSON.stringify({ title: sop.title, path: target, steps: sop.steps.length, gaps: sop.gaps, sop_id: filedAs }, null, 2))
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Drafted:")}  ${highlight(sop.title)}  ${dim(`${sop.steps.length} steps`)}`)
    console.log(`  ${bold("Written:")}  ${highlight(target)}`)
    if (filedAs) console.log(`  ${bold("Filed:")}    ${highlight(`SOP #${filedAs}`)} ${dim(`on request ${args.request}`)}`)
    printDivider()
    console.log()

    if (!walk.hinted) {
      // Worth saying out loud: an unhinted transcript mishears domain nouns, and those errors
      // end up inside the procedure rather than in a throwaway transcript.
      console.log(`  ${dim("No brand vocabulary was applied — domain terms may be misheard.")}`)
      console.log(`  ${dim("Set one with: iris brands glossary set <slug> \"Likely terms: ...\"")}`)
      console.log()
    }

    if (sop.gaps.length) {
      console.log(`  ${bold("Not covered in the walkthrough")} ${dim("— record a follow-up or fill these in:")}`)
      for (const g of sop.gaps) console.log(`    ${dim("·")} ${g}`)
      console.log()
    }

    console.log(`  ${success("Next")}`)
    console.log(`    ${dim("$")} iris playbook draft <same file>   ${dim("# the agent-executable version")}`)
    if (!args.request) console.log(`    ${dim("$")} iris sop draft <file> --request <id>   ${dim("# file it against a client request")}`)
    console.log()

    prompts.outro("Done")
  },
})

function asList(v: any): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean)
}
