import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, irisFetch, requireAuth, handleApiError, writeJson } from "./iris-api"
import { resolveWalkthrough, structureWalkthrough, slugify } from "../lib/walkthrough"
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
    // Server-side, so the CLI and the CardEditor produce the same document from the same words.
    const sp2 = prompts.spinner()
    sp2.start("Writing it up…")
    let doc
    try {
      doc = await structureWalkthrough(walk.transcript, "sop", String(args.model))
      sp2.stop("Written")
    } catch (e) {
      sp2.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const gaps: string[] = Array.isArray(doc.structured?.gaps) ? doc.structured.gaps : []
    const stepCount = Array.isArray(doc.structured?.steps) ? doc.structured.steps.length : 0

    // ---- 3. Save --------------------------------------------------------------
    const name = slugify(String(args.name ?? doc.title)) || "sop"
    const target = args.output ? resolve(String(args.output)) : join(process.cwd(), "sops", `${name}.md`)

    if (existsSync(target) && !args.force) {
      prompts.log.error(`${target} already exists. Pass --force to overwrite, or --name for a different one.`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const markdown = doc.markdown
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, markdown)

    // ---- 4. Optionally file it against a service request ----------------------
    let filedAs: number | null = null
    if (args.request) {
      const res = await irisFetch(`/api/v1/services/requests/${Number(args.request)}/sops`, {
        method: "POST",
        body: JSON.stringify({ title: doc.title, description: doc.structured?.purpose ?? '', content: markdown }),
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
      await writeJson({ title: doc.title, path: target, steps: stepCount, gaps, sop_id: filedAs })
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Drafted:")}  ${highlight(doc.title)}  ${dim(`${stepCount} steps`)}`)
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

    if (gaps.length) {
      console.log(`  ${bold("Not covered in the walkthrough")} ${dim("— record a follow-up or fill these in:")}`)
      for (const g of gaps) console.log(`    ${dim("·")} ${g}`)
      console.log()
    }

    console.log(`  ${success("Next")}`)
    console.log(`    ${dim("$")} iris playbook draft <same file>   ${dim("# the agent-executable version")}`)
    if (!args.request) console.log(`    ${dim("$")} iris sop draft <file> --request <id>   ${dim("# file it against a client request")}`)
    console.log()

    prompts.outro("Done")
  },
})

