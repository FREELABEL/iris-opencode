import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, requireAuth, writeJson } from "./iris-api"
import { resolveWalkthrough, structureWalkthrough, slugify } from "../lib/walkthrough"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"

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

    // ---- 1. Get the transcript -------------------------------------------------
    // Shared with `iris sop draft` — same words, different artifact. See lib/walkthrough.
    const sp = prompts.spinner()
    let walk
    try {
      walk = await resolveWalkthrough(String(args.input), {
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
    // ---- 2. Structure it -------------------------------------------------------
    // Server-side, so the CLI and the CardEditor produce the same document from the same words.
    const sp2 = prompts.spinner()
    sp2.start("Drafting the procedure…")
    let doc
    try {
      doc = await structureWalkthrough(walk.transcript, "playbook", String(args.model))
      sp2.stop("Drafted")
    } catch (e) {
      sp2.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const name = args.name ? slugify(String(args.name)) : doc.title
    const steps: Array<{ title: string }> = Array.isArray(doc.structured?.steps) ? doc.structured.steps : []

    // ---- 3. Write it -----------------------------------------------------------
    const target = args.output
      ? resolve(String(args.output))
      : join(process.cwd(), ".iris", "playbooks", name, "PLAYBOOK.md")

    if (existsSync(target) && !args.force) {
      // Overwriting somebody's authored playbook with a draft is not recoverable from here.
      prompts.log.error(`${target} already exists. Pass --force to overwrite, or --name for a different one.`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, doc.markdown)

    if (args.json) {
      await writeJson({ name, path: target, steps: steps.length, notes: doc.structured?.notes ?? [] })
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Drafted:")}  ${highlight(name)}  ${dim(`${steps.length} steps`)}`)
    console.log(`  ${bold("Written:")}  ${highlight(target)}`)
    printDivider()
    console.log()
    for (const s of steps) console.log(`  ${dim("·")} ${s.title}`)
    console.log()
    console.log(`  ${success("Next")} — this is a draft, so read it before you trust it:`)
    console.log(`    ${dim("$")} iris playbook show ${name}`)
    console.log(`    ${dim("$")} iris playbook sync            ${dim("# → .claude/skills/, usable by Claude")}`)
    console.log(`    ${dim("$")} iris playbook publish ${name}   ${dim("# → marketplace, when it is right")}`)
    console.log()

    prompts.outro("Done")
  },
})
