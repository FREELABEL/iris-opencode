import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, irisFetch, requireAuth, writeJson, PUBLIC_SITE, IRIS_API } from "./iris-api"
import { resolveWalkthrough } from "../lib/walkthrough"
import { execFileSync } from "child_process"

// ============================================================================
// iris newsroom — a front door for the writer that already exists.
//
// `article:draft` (fl-iris-api) has done text → verified article → filed on a bloq for a while,
// and `POST /api/v1/article/draft` has exposed it. Neither was reachable from the CLI, so the
// only way to run it was `railway ssh`, which re-shells its argv and mangles anything with
// quotes. That is why transcript → article was being done by hand.
//
// The input is an audio file OR a transcript: resolveWalkthrough transcribes on-device when it
// is given audio, so a recording of the thing can go straight in.
//
// TWO REFUSALS THAT ARE NOT BUGS, and which this command must therefore explain rather than
// swallow:
//   - A bloq inside a PHI boundary is refused BEFORE the model call — the structuring request is
//     itself the disclosure. Filing an article from a PHI workspace is supposed to fail.
//   - Blocking lint findings stop a --publish and never a draft. Filing a flawed draft is how it
//     gets fixed; publishing one is how a fabricated quote reaches a public URL.
// Both arrive as a 422 carrying the reason, so the reason is printed.
// ============================================================================

/** ArticleDraftController validates `text` at max:200000. Caught here so the failure names the size. */
export const MAX_SOURCE_CHARS = 200_000

export interface LintFinding {
  rule?: string
  severity?: string
  path?: string
  message?: string
}

/**
 * Split findings by severity.
 *
 * Unknown severities count as warnings rather than being dropped: a finding this CLI does not
 * recognise is still something a reviewer should see, and silently discarding it would make a
 * new rule invisible until someone noticed an article it should have stopped.
 */
export function lintSummary(lint: unknown): { blockers: LintFinding[]; warnings: LintFinding[] } {
  const findings: LintFinding[] = Array.isArray(lint) ? (lint as LintFinding[]) : []
  const blockers: LintFinding[] = []
  const warnings: LintFinding[] = []
  for (const f of findings) {
    const severity = String(f?.severity ?? "").toLowerCase()
    if (severity === "blocker" || severity === "error" || severity === "critical") blockers.push(f)
    else warnings.push(f)
  }
  return { blockers, warnings }
}

export function formatFinding(f: LintFinding): string {
  const rule = f?.rule ? `${f.rule}: ` : ""
  const where = f?.path ? dim(` (${f.path})`) : ""
  return `${rule}${f?.message ?? "(no message)"}${where}`
}

/**
 * Build the request body, dropping anything not set.
 *
 * Sending `undefined` keys would defeat the endpoint's `nullable` rules and make an unset flag
 * look like an explicit null.
 */
export function draftPayload(
  text: string,
  args: {
    bloq?: number
    angle?: string
    model?: string
    title?: string
    lane?: string
    publish?: boolean
    force?: boolean
    skipLint?: boolean
  },
  opts: { filing: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { text }
  if (args.bloq !== undefined) body.bloq_id = args.bloq
  if (args.angle) body.angle = args.angle
  if (args.model) body.model = args.model
  if (args.title) body.title = args.title
  if (args.skipLint) body.skip_lint = true
  if (opts.filing) {
    if (args.lane) body.lane = args.lane
    if (args.publish) body.publish = true
    if (args.force) body.force = true
  }
  return body
}

/**
 * The same request, as arguments to `php artisan article:draft`.
 *
 * The text is NOT here — it goes in on stdin via `--stdin`. That is the whole reason this
 * fallback is viable: a transcript is multi-line and full of quotes, and every documented attempt
 * to carry one through a re-shelled argv (`railway ssh -- <cmd>`) has mangled it. Arguments stay
 * short and structural; the words go down a pipe.
 */
export function artisanArgs(
  bloq: number,
  args: {
    angle?: string
    model?: string
    title?: string
    lane?: string
    publish?: boolean
    force?: boolean
    skipLint?: boolean
    json?: boolean
  },
  opts: { filing: boolean },
): string[] {
  const out = ["php", "artisan", "article:draft", String(bloq), "--stdin"]
  if (!opts.filing) out.push("--dry-run")
  if (args.angle) out.push(`--angle=${args.angle}`)
  if (args.model) out.push(`--model=${args.model}`)
  if (args.title) out.push(`--title=${args.title}`)
  if (args.skipLint) out.push("--skip-lint")
  if (opts.filing) {
    if (args.lane) out.push(`--lane=${args.lane}`)
    if (args.publish) out.push("--publish")
    if (args.force) out.push("--force")
  }
  if (args.json) out.push("--json")
  return out
}

/**
 * A 404 means the service we reached does not have this route — an iris-api too old to have
 * ArticleDraftController, or IRIS_API pointing somewhere else. That is worth a second transport.
 * A 422 (bad input, PHI boundary, blocking findings) is the endpoint working correctly, and
 * retrying it elsewhere would only launder a refusal into a second opinion.
 */
export function shouldTryLocalContainer(status: number | null): boolean {
  return status === null || status === 404 || status === 502 || status === 503
}

/** The local dev container, if one is running. Absent on any machine without the stack. */
export function findLocalIrisContainer(): string | null {
  try {
    const names = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return names.split("\n").map((n) => n.trim()).find((n) => n === "fl-iris-api") ?? null
  } catch {
    return null
  }
}

/** One-line shape of the drafted document, for someone deciding whether to keep it. */
export function documentLines(doc: any): string[] {
  const sections = Array.isArray(doc?.sections) ? doc.sections.length : 0
  const quotes = Array.isArray(doc?.pullQuotes) ? doc.pullQuotes.length : 0
  const gaps: string[] = Array.isArray(doc?.gaps) ? doc.gaps : []
  const lines = [
    `${dim("Title:")}      ${bold(String(doc?.title ?? "(untitled)"))}`,
    ...(doc?.dek ? [`${dim("Dek:")}        ${String(doc.dek)}`] : []),
    `${dim("Shape:")}      ${sections} section(s) · ${quotes} pull quote(s) · ${doc?.wordCount ?? "?"} words`,
  ]
  if (gaps.length) lines.push(`${dim("Gaps:")}       ${gaps.length} noted by the writer`)
  return lines
}

const NewsroomDraftCommand = cmd({
  command: "draft <input>",
  describe: "turn a recording, transcript or notes into a verified article filed on a bloq",
  builder: (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        demandOption: true,
        describe: "Audio file to transcribe on-device, or a .txt/.md transcript, notes or outline",
      })
      .option("bloq", { type: "number", describe: "Bloq to file it on (required unless --dry-run)" })
      .option("angle", { type: "string", describe: 'What to foreground, e.g. "focus on the pricing change"' })
      .option("lane", { type: "string", describe: 'List to file under; default: the newsroom deliverables list, else "Drafts"' })
      .option("title", { type: "string", describe: "Override the drafted title" })
      .option("model", { type: "string", describe: "Nano model override (server default: gpt-4.1-nano)" })
      .option("brand", { type: "number", describe: "Brand whose vocabulary to bias transcription toward" })
      .option("publish", { type: "boolean", default: false, describe: "Publish it now instead of leaving a draft" })
      .option("force", { type: "boolean", default: false, describe: "Publish even when verification finds blockers" })
      .option("skip-lint", { type: "boolean", default: false, describe: "Do not run the verification pass" })
      .option("dry-run", { type: "boolean", default: false, describe: "Structure it and print it, write nothing — start here" })
      .option("json", { type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  Newsroom Draft")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const filing = !args["dry-run"]
    if (filing && args.bloq === undefined) {
      prompts.log.error("Which bloq should this be filed on? Pass --bloq <id>, or --dry-run to structure it without writing.")
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 1. Words ------------------------------------------------------------
    const sp = prompts.spinner()
    let walk
    try {
      walk = await resolveWalkthrough(String(args.input), {
        brandId: args.brand ? Number(args.brand) : undefined,
        onTranscribeStart: (hinted) =>
          sp.start(hinted ? "Transcribing (on-device, brand vocabulary)…" : "Transcribing (on-device)…"),
      })
      sp.stop(`Source: ${walk.source} · ${walk.transcript.length.toLocaleString()} chars`)
    } catch (e) {
      sp.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    if (walk.transcript.length > MAX_SOURCE_CHARS) {
      prompts.log.error(
        `That source is ${walk.transcript.length.toLocaleString()} chars; the endpoint accepts ${MAX_SOURCE_CHARS.toLocaleString()}. ` +
          "Nothing was sent. Split it and draft the parts separately — one article per run is the current shape.",
      )
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // ---- 2. Structure, verify, and (unless dry-run) file ---------------------
    const path = filing ? "/api/v1/article/draft" : "/api/v1/article/structure"
    const body = draftPayload(walk.transcript, {
      bloq: args.bloq,
      angle: args.angle,
      model: args.model,
      title: args.title,
      lane: args.lane,
      publish: args.publish,
      force: args.force,
      skipLint: args["skip-lint"],
    }, { filing })

    const sp2 = prompts.spinner()
    sp2.start(filing ? "Writing it up and filing it…" : "Writing it up…")
    // IRIS_API, not the irisFetch default of FL_API: these two routes live in fl-iris-api
    // alongside ArticleDraftService. Against fl-api they 404 — which is what this did first,
    // with a green typecheck and passing unit tests.
    let res: Response | null = null
    let transportError: string | null = null
    try {
      res = await irisFetch(path, { method: "POST", body: JSON.stringify(body) }, IRIS_API)
    } catch (e) {
      transportError = e instanceof Error ? e.message : String(e)
    }
    const payload = res ? ((await res.json().catch(() => null)) as any) : null

    if (!res || !res.ok) {
      const status = res ? res.status : null
      const container = shouldTryLocalContainer(status) && args.bloq !== undefined ? findLocalIrisContainer() : null

      if (container) {
        // Announced, never silent: a fallback that hides an unreachable API turns a broken
        // deployment into a mystery that only shows up on a machine without the container.
        sp2.stop(`${IRIS_API} could not serve ${path} (${status ?? transportError}) — using the local ${container} container`, 1)
        try {
          const out = execFileSync(
            "docker",
            ["exec", "-i", container, ...artisanArgs(Number(args.bloq), {
              angle: args.angle,
              model: args.model,
              title: args.title,
              lane: args.lane,
              publish: args.publish,
              force: args.force,
              skipLint: args["skip-lint"],
              json: args.json,
            }, { filing })],
            { input: walk.transcript, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
          )
          prompts.log.message(out.trim())
          prompts.outro("Done")
          return
        } catch (e: any) {
          prompts.log.error(String(e?.stdout || e?.stderr || e?.message || e))
          process.exitCode = 1
          prompts.outro("Done")
          return
        }
      }

      sp2.stop("Failed", 1)
      // The refusals are the feature. Print what the gate said, and its findings.
      prompts.log.error(String(payload?.error ?? transportError ?? `${status} from ${path}`))
      const { blockers, warnings } = lintSummary(payload?.lint)
      for (const f of [...blockers, ...warnings]) prompts.log.warn(formatFinding(f))
      if (shouldTryLocalContainer(status)) {
        prompts.log.info(
          args.bloq === undefined
            ? "No local fl-iris-api container to fall back to, and --dry-run cannot use one without --bloq."
            : "No local fl-iris-api container to fall back to.",
        )
      }
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    sp2.stop(filing ? "Filed" : "Structured")

    const data = payload?.data ?? payload
    if (args.json) {
      await writeJson(data)
      prompts.outro("Done")
      return
    }

    prompts.log.message(documentLines(data?.document).join("\n"))

    const { blockers, warnings } = lintSummary(data?.lint)
    if (blockers.length || warnings.length) {
      prompts.log.message(
        [
          "",
          bold(`Verification: ${blockers.length} blocking · ${warnings.length} to look at`),
          ...blockers.map((f) => `  ${highlight("BLOCKS PUBLISH")} ${formatFinding(f)}`),
          ...warnings.map((f) => `  ${dim("·")} ${formatFinding(f)}`),
        ].join("\n"),
      )
    } else if (!args["skip-lint"]) {
      prompts.log.message(`\n${bold("Verification:")} ${success("clean")}`)
    }

    if (!filing) {
      prompts.log.info(`Nothing was written. File it with: ${dim(`iris newsroom draft ${args.input} --bloq <id>`)}`)
      prompts.outro("Done")
      return
    }

    const slug = data?.promotion?.slug ?? data?.promotion?.page_slug
    prompts.log.message(
      [
        "",
        `${dim("Filed as:")}   item #${data?.item_id} in ${bold(String(data?.lane ?? "?"))}`,
        `${dim("State:")}      ${data?.published ? success("published") : "draft"}`,
        ...(slug ? [`${dim("Page:")}       ${PUBLIC_SITE}/p/${slug}`] : []),
      ].join("\n"),
    )

    if (!data?.published) {
      prompts.log.info(
        "Drafts are promoted to a page within the hour, then emailed to the reviewer. " +
          `Publish it now with ${dim("--publish")}.`,
      )
    }

    prompts.outro("Done")
  },
})

export const PlatformNewsroomCommand = cmd({
  command: "newsroom",
  aliases: ["article"],
  describe: "newsroom — draft articles from recordings, transcripts, notes or outlines",
  builder: (yargs) =>
    yargs
      .command(NewsroomDraftCommand)
      .epilogue(
        [
          `${bold("Related:")}`,
          `  ${dim("iris content-engine init <bloq>")}  set a workspace up as a newsroom (lists + config)`,
          `  ${dim("iris content-engine status <bloq>")} what a newsroom is configured to do`,
          `  ${dim("iris editorial review <slug>")}      score an article that is already published`,
        ].join("\n"),
      )
      .demandCommand(),
  async handler() {},
})
