import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, printDivider, requireAuth } from "./iris-api"
import { resolveWalkthrough } from "../lib/walkthrough"
import { draftArticle, fileArticle, articleSlug, type LintFinding } from "../lib/article"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"

// ============================================================================
// iris article draft — any text becomes a publishable article
//
// AUDIO IS OPTIONAL, AND THAT IS THE POINT. `resolveWalkthrough` accepts an audio file OR a
// .txt/.md transcript, and transcribes on-device when it gets audio. So a recording never has to
// leave the machine to become an article, and someone who ALREADY has a transcript — the common
// case — is not on a second-class path.
//
// The structuring, the verification pass and the component mapping are all server-side, shared
// with `php artisan article:draft`. A draft produced here and one produced in a prod container
// are the same article; the difference is only how you invoked it.
// ============================================================================

function renderFindings(findings: LintFinding[]): void {
  if (!findings.length) {
    console.log(`  ${success("✓")} verification: clean`)
    return
  }

  // Printed on every run, including a publish. A verification pass whose output only appears
  // when you ask for it is a verification pass nobody reads.
  console.log(`  ${bold("Verification")}`)
  for (const f of findings) {
    const label = f.severity === "error" ? "ERROR" : f.severity === "warning" ? "WARN " : "INFO "
    const where = f.path ? `${f.path} — ` : ""
    console.log(`    ${label}  ${where}${f.message}`)
  }
}

export const ArticleDraftCommand = cmd({
  command: "draft <input>",
  describe: "draft a publishable article from a transcript, notes, or a recording",
  builder: (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        demandOption: true,
        describe: "A .txt/.md transcript or notes file, or an audio file to transcribe first",
      })
      .option("bloq", { type: "number", describe: "File it on this bloq (omit to only write a local file)" })
      .option("lane", { type: "string", describe: "List to file it under. Default: the newsroom lane, else 'Drafts'" })
      .option("publish", { type: "boolean", default: false, describe: "Publish it as a Genesis page (implies --bloq)" })
      .option("angle", { type: "string", describe: 'What to foreground, e.g. "focus on the pricing change"' })
      .option("title", { type: "string", describe: "Override the drafted title" })
      .option("brand", { type: "number", describe: "Brand whose vocabulary to bias transcription toward" })
      .option("model", { type: "string", default: "iris/gpt-4.1-nano", describe: "Model used to structure it (nano only)" })
      .option("output", { type: "string", alias: "o", describe: "Write here instead of ./articles/<slug>.md" })
      .option("no-save", { type: "boolean", default: false, describe: "Do not write a local markdown file" })
      .option("force", { type: "boolean", default: false, describe: "Overwrite an existing file, and publish despite blocking findings" })
      .option("skip-lint", { type: "boolean", default: false, describe: "Skip the verification pass" })
      .option("json", { type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  Article Draft")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    if (args.publish && !args.bloq) {
      prompts.log.error("--publish needs --bloq: an article is published as a page owned by a workspace.")
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 1. Words -------------------------------------------------------------
    const sp = prompts.spinner()
    let walk
    try {
      walk = await resolveWalkthrough(String(args.input), {
        brandId: args.brand ? Number(args.brand) : undefined,
        onTranscribeStart: (hinted: boolean) =>
          sp.start(hinted ? "Transcribing (on-device, brand vocabulary)…" : "Transcribing (on-device)…"),
      })
      sp.stop("Read")
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 2. Structure + verify ------------------------------------------------
    const sp2 = prompts.spinner()
    sp2.start("Writing it up…")

    const shared = {
      angle: args.angle ? String(args.angle) : undefined,
      model: String(args.model),
      title: args.title ? String(args.title) : undefined,
      skipLint: Boolean(args["skip-lint"]),
    }

    let drafted
    let filed
    try {
      if (args.bloq) {
        // One call: structure, verify, file — and publish if asked. Splitting it would let the
        // CLI show a reviewer one article and file a different one.
        filed = await fileArticle(walk.transcript, {
          ...shared,
          bloqId: Number(args.bloq),
          lane: args.lane ? String(args.lane) : undefined,
          publish: Boolean(args.publish),
          force: Boolean(args.force),
        })
        drafted = filed
      } else {
        drafted = await draftArticle(walk.transcript, shared)
      }
      sp2.stop("Written")
    } catch (e) {
      sp2.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      // A refusal to publish carries the findings that caused it. Printing them is the whole
      // point — "blocked" without "by what" is not actionable.
      const lint = (e as Error & { lint?: LintFinding[] }).lint
      if (lint?.length) {
        console.log()
        renderFindings(lint)
        console.log()
      }
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const doc = drafted.document
    const gaps = doc.gaps ?? []

    // ---- 3. Save a local copy -------------------------------------------------
    let target: string | null = null
    if (!args["no-save"]) {
      const name = articleSlug(String(args.title ?? doc.title)) || "article"
      target = args.output ? resolve(String(args.output)) : join(process.cwd(), "articles", `${name}.md`)

      if (existsSync(target) && !args.force) {
        prompts.log.error(`${target} already exists. Pass --force to overwrite, or --title for a different name.`)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      mkdirSync(join(target, ".."), { recursive: true })
      writeFileSync(target, drafted.markdown)
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            title: doc.title,
            path: target,
            sections: doc.sections?.length ?? 0,
            quotes: doc.pullQuotes?.length ?? 0,
            words: doc.wordCount ?? 0,
            gaps,
            lint: drafted.lint,
            item_id: filed?.item_id ?? null,
            lane: filed?.lane ?? null,
            published: filed?.published ?? false,
          },
          null,
          2,
        ),
      )
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold(doc.title)}`)
    if (doc.dek) console.log(`  ${dim(doc.dek)}`)
    console.log()
    for (const [i, s] of (doc.sections ?? []).entries()) {
      console.log(`  ${dim(String(i + 1) + ".")} ${s.heading}`)
    }
    console.log()
    console.log(
      `  ${dim(`${doc.wordCount ?? 0} words · ${doc.sections?.length ?? 0} sections · ${doc.pullQuotes?.length ?? 0} quotes verified`)}`,
    )
    console.log()
    renderFindings(drafted.lint ?? [])

    // GAPS ARE PRINTED EVEN THOUGH THEY NEVER REACH THE PAGE.
    //
    // They are the most useful part of a draft and are deliberately excluded from the published
    // components. If they only lived in the markdown, someone running --publish would never see
    // them — and the point of the section is that it is read before the thing goes live.
    if (gaps.length) {
      console.log()
      console.log(`  ${bold("Not covered in the source")}`)
      for (const g of gaps) console.log(`    · ${g}`)
    }
    printDivider()
    console.log()

    if (target) console.log(`  ${dim("saved")}  ${target}`)
    if (filed) {
      console.log(`  ${dim("filed")}  item #${filed.item_id} in ${filed.lane}`)
      if (args.publish) {
        if (filed.published) {
          for (const p of filed.promotion?.promoted ?? []) {
            console.log(`  ${success("published")}  /p/${p.slug ?? "?"}`)
          }
        } else {
          prompts.log.warn(`Not published: ${filed.promotion?.reason ?? "unknown"}`)
        }
      }
    }
    console.log()

    prompts.outro("Done")
  },
})
