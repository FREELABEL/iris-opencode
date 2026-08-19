import { cmd } from "./cmd"
import { FL_API, dim, bold } from "./iris-api"
import { writeFileSync } from "fs"
import { EOL } from "os"

// ============================================================================
// iris atlas use <ref> — pull one Atlas item's context into an agent.
//
// WHY STDOUT AND NOT "THE SESSION".
//
// The obvious design is "load this into the current session". That only works
// inside the IRIS CLI, and the people who need this command are usually somewhere
// else — Claude Code, Cursor, a shell script — where IRIS does not own a session
// to load into. A command that works in one harness and silently no-ops in every
// other one is the exact shape of the tool-availability bugs we keep filing.
//
// So the interface is the universal one: context goes to STDOUT, progress goes to
// STDERR. That makes every harness a supported harness:
//
//   iris atlas use <ref>                      read it
//   iris atlas use <ref> | pbcopy             paste it anywhere
//   iris atlas use <ref> --out ctx.md         a file an agent can @-mention
//   iris atlas use <ref> --json | jq .dataset script against it
//
// The endpoint is the PUBLIC one, deliberately: the ref comes off a shared page,
// so `use` must work for an item you were sent and do not own. No auth is
// required, and none is sent.
// ============================================================================

/** Accepts a bare uuid or any URL containing one. */
function resolveRef(ref: string): string | null {
  const s = (ref || "").trim()
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (uuid) return uuid[0].toLowerCase()
  return null
}

/** A dataset rendered as a markdown table — the form every agent already reads. */
function datasetToMarkdown(ds: any): string {
  const cols: string[] = Array.isArray(ds?.columns) ? ds.columns.map(String) : []
  const rows: any[] = Array.isArray(ds?.rows) ? ds.rows : []
  if (!cols.length || !rows.length) return ""

  const cell = (v: any) => String(v ?? "").replace(/\|/g, "\\|")
  const lines = [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
  ]
  for (const r of rows) {
    const vals = Array.isArray(r) ? r : cols.map((c) => (r as any)?.[c])
    lines.push(`| ${vals.map(cell).join(" | ")} |`)
  }
  return lines.join("\n")
}

/**
 * The context document.
 *
 * Front-matter carries the addressing so an agent that re-reads the file later
 * can tell where it came from without being told — the same provenance the shared
 * page shows, in the form a file can hold.
 */
function buildMarkdown(item: any, url: string): string {
  const ctx = item?.context ?? {}
  const out: string[] = []

  out.push("---")
  out.push(`source: ${url}`)
  if (item?.title) out.push(`title: ${JSON.stringify(item.title)}`)
  if (ctx?.bloq?.name) out.push(`knowledge_base: ${JSON.stringify(ctx.bloq.name)}`)
  if (ctx?.list?.name) out.push(`list: ${JSON.stringify(ctx.list.name)}`)
  if (item?.public_uuid) out.push(`ref: ${item.public_uuid}`)
  if (item?.updated_at) out.push(`revised: ${item.updated_at}`)
  out.push("---")
  out.push("")

  if (item?.title) {
    out.push(`# ${item.title}`)
    out.push("")
  }

  // The body. `content` is a markdown string, or a JSON wrapper whose prose lives
  // under one of a few keys depending on which editor wrote it.
  const raw = item?.content
  let body = ""
  let dataset: any = null

  if (typeof raw === "string") {
    body = raw
  } else if (raw && typeof raw === "object") {
    body = raw.text ?? raw.body ?? raw.content ?? raw.markdown ?? ""
    dataset = raw.dataset ?? null
  }

  if (body.trim()) {
    out.push(body.trim())
    out.push("")
  }

  if (dataset) {
    const table = datasetToMarkdown(dataset)
    if (table) {
      out.push(`## ${dataset.name || "Dataset"}`)
      out.push("")
      out.push(table)
      out.push("")
    }
  }

  const files = Array.isArray(ctx?.attachments) ? ctx.attachments : []
  if (files.length) {
    // Named, not fetched. The public payload gives names and sizes and no paths,
    // so listing them tells an agent what exists without pretending it has them.
    out.push("## Attachments")
    out.push("")
    for (const f of files) {
      out.push(`- ${f?.name ?? "untitled"}${f?.type ? ` (${f.type})` : ""}`)
    }
    out.push("")
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

export const AtlasUseCommand = cmd({
  command: "use <ref>",
  aliases: ["context", "pull"],
  describe: "pull a shared Atlas item's context to stdout (pipe it into any agent)",
  builder: (yargs) =>
    yargs
      .positional("ref", {
        describe: "the item's public URL, or its uuid",
        type: "string",
        demandOption: true,
      })
      .option("json", { describe: "structured output instead of markdown", type: "boolean", default: false })
      .option("out", { describe: "write to a file instead of stdout", type: "string" })
      .option("quiet", { describe: "suppress the summary on stderr", type: "boolean", default: false })
      .example("iris atlas use https://heyiris.io/n/<uuid>", "print the context")
      .example("iris atlas use <uuid> --out ctx.md", "save it for an agent to read")
      .example("iris atlas use <uuid> --json | jq .dataset", "script against the data"),

  async handler(args: any) {
    const uuid = resolveRef(args.ref)

    if (!uuid) {
      // The short REF shown on a shared page (e.g. FC6E2A27) is a display prefix,
      // not an address — there is no public endpoint that resolves one. Say so,
      // rather than 404ing and letting it look like the item is gone.
      process.stderr.write(
        `Not a full reference: ${args.ref}${EOL}` +
          `Pass the item's public URL, or its full uuid.${EOL}` +
          dim(`  iris atlas use https://heyiris.io/n/<uuid>`) + EOL,
      )
      process.exitCode = 1
      return
    }

    const url = `${FL_API}/api/v1/bloq/item/${uuid}`
    let res: Response
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } })
    } catch (e: any) {
      process.stderr.write(`Could not reach ${FL_API}: ${e?.message ?? e}${EOL}`)
      process.exitCode = 1
      return
    }

    // The item's own access ladder, reported as itself. A sealed item is not a
    // failure of this command, and saying "not found" for one would be a lie.
    if (res.status === 404) {
      process.stderr.write(`No public item with that reference.${EOL}`)
      process.exitCode = 1
      return
    }
    if (res.status === 410) {
      process.stderr.write(`That item has been withdrawn — the link has expired.${EOL}`)
      process.exitCode = 1
      return
    }
    if (res.status === 401) {
      process.stderr.write(
        `That item is sealed behind a password.${EOL}` +
          dim(`Open it in a browser to unseal: https://heyiris.io/n/${uuid}`) + EOL,
      )
      process.exitCode = 1
      return
    }
    if (!res.ok) {
      process.stderr.write(`Request failed (${res.status}).${EOL}`)
      process.exitCode = 1
      return
    }

    const body: any = await res.json().catch(() => null)
    const item = body?.data
    if (!item) {
      process.stderr.write(`Unexpected response shape from ${url}${EOL}`)
      process.exitCode = 1
      return
    }

    const payload = args.json ? JSON.stringify(item, null, 2) + "\n" : buildMarkdown(item, `https://heyiris.io/n/${uuid}`)

    if (args.out) {
      writeFileSync(args.out, payload, "utf8")
    } else {
      process.stdout.write(payload)
    }

    // Summary on STDERR so a pipe stays clean. `--quiet` for scripts that want
    // nothing at all.
    if (!args.quiet) {
      const ctx = item.context ?? {}
      const where = [ctx?.bloq?.name, ctx?.list?.name].filter(Boolean).join(" / ")
      const bits = [
        item.content_format ? String(item.content_format) : "document",
        ctx?.attachments?.length ? `${ctx.attachments.length} attachment(s)` : null,
        ctx?.tasks ? `${ctx.tasks.open}/${ctx.tasks.total} tasks open` : null,
      ].filter(Boolean)

      process.stderr.write(
        EOL +
          bold(`  ${item.title ?? "Untitled"}`) + EOL +
          (where ? dim(`  ${where}`) + EOL : "") +
          dim(`  ${bits.join(" · ")}`) + EOL +
          (args.out ? dim(`  written to ${args.out}`) + EOL : "") +
          EOL,
      )
    }
  },
})
