import { cmd } from "./cmd"
import { FL_API, dim, bold } from "./iris-api"
import { writeFileSync, readFileSync, existsSync } from "fs"
import { EOL } from "os"
import { join } from "path"
import { atlasHome, isGranted, readPolicy, readManifest, shortHash } from "./platform-atlas-store"
import { classifyRef, explainWrongRef } from "./reference-kind"
import { irisFetch, requireAuth } from "./iris-api"

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
export function resolveRef(ref: string): string | null {
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
  const lines = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`]
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
export function buildMarkdown(item: any, url: string): string {
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
    // An HTML artifact is markup, not prose. Now that `content_format` is declared
    // rather than guessed, fence it: an agent reading this can tell the difference
    // between a document it should follow and a rendered artifact it should treat as
    // data. Unfenced, a <style> block reads as instructions.
    if (String(item?.content_format).toLowerCase() === "html") {
      out.push("```html")
      out.push(body.trim())
      out.push("```")
    } else {
      out.push(body.trim())
    }
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

  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  )
}

/** Said out loud everywhere the seal refuses something, so the claim never grows. */
export function describeSeal(): string {
  // Kept in one place and printed at every refusal, so the claim cannot quietly grow.
  return "the seal stops THIS PROCESS — not curl, not another binary, and not a process that already holds the bytes"
}

export const AtlasUseCommand = cmd({
  command: "use <ref>",
  aliases: ["context", "pull"],
  describe: "READ a published note or Atlas item as markdown text on stdout (pipe it into any agent)",
  builder: (yargs) =>
    yargs
      .positional("ref", {
        describe: "the item's public URL, its uuid, or a bloq item id",
        type: "string",
        demandOption: true,
      })
      .option("json", { describe: "structured output instead of markdown", type: "boolean", default: false })
      .option("out", { describe: "write to a file instead of stdout", type: "string" })
      .option("quiet", { describe: "suppress the summary on stderr", type: "boolean", default: false })
      .option("fresh", {
        describe: "on a sealed machine, read from the cloud instead of the local pin",
        type: "boolean",
        default: false,
      })
      .example("iris atlas use https://heyiris.io/n/<uuid>", "print the context")
      .example("iris atlas use <uuid> --out ctx.md", "save it for an agent to read")
      .example("iris atlas use <uuid> --json | jq .dataset", "script against the data")
      .example("iris atlas use 184598", "read a bloq item you own, by its id"),

  async handler(args: any) {
    const ref = classifyRef(args.ref)

    // A BLOQ ITEM ID is a legitimate reference (#184599): `get-item` takes one, and a
    // user holding one reasonably expects its sibling to take it too. It resolves
    // through the AUTHED endpoint rather than the public one, because an item id
    // addresses a document you own — it is not a share link and may not be published.
    if (ref.kind === "item-id") {
      const home = atlasHome()
      if (readPolicy(home).sealed) {
        // A sealed machine reads what it was GRANTED, and grants are keyed by uuid.
        // Resolving an arbitrary item id would reach past the seal by another name.
        process.stderr.write(
          `Sealed: this machine reads by pinned reference, and ${ref.value} is a bloq item id.${EOL}` +
            dim(`  ${describeSeal()}`) +
            EOL +
            dim(`  iris atlas pins            what this machine holds`) +
            EOL,
        )
        process.exitCode = 1
        return
      }
      const token = await requireAuth()
      if (!token) {
        process.exitCode = 1
        return
      }
      const r = await irisFetch(`/api/v1/user/bloqs/list/item/${ref.value}`)
      if (!r.ok) {
        process.stderr.write(
          r.status === 404
            ? `No item ${ref.value} visible to this account. Check the id, or whether the board is shared with you.${EOL}`
            : `Request failed (${r.status}).${EOL}`,
        )
        process.exitCode = 1
        return
      }
      const b: any = await r.json().catch(() => null)
      const it = b?.data ?? b
      if (!it) {
        process.stderr.write(`Unexpected response shape reading item ${ref.value}${EOL}`)
        process.exitCode = 1
        return
      }
      const link = it.public_uuid ? `https://heyiris.io/n/${it.public_uuid}` : `bloq:item:${ref.value}`
      const md = args.json ? JSON.stringify(it, null, 2) + "\n" : buildMarkdown(it, link)
      if (args.out) writeFileSync(args.out, md, "utf8")
      else process.stdout.write(md)
      if (!args.quiet) {
        process.stderr.write(
          EOL +
            bold(`  ${it.title ?? "Untitled"}`) +
            EOL +
            dim(
              `  bloq item #${ref.value}${it.public_uuid ? "" : " · not published, read over your own credentials"}`,
            ) +
            EOL +
            (args.out ? dim(`  written to ${args.out}`) + EOL : "") +
            EOL,
        )
      }
      return
    }

    const uuid = resolveRef(args.ref)

    if (!uuid) {
      // The short REF shown on a shared page (e.g. FC6E2A27) is a display prefix,
      // not an address — there is no public endpoint that resolves one. Say so,
      // rather than 404ing and letting it look like the item is gone.
      process.stderr.write(
        explainWrongRef(ref, "uuid") + EOL + dim(`  iris atlas use https://heyiris.io/n/<uuid>`) + EOL,
      )
      process.exitCode = 1
      return
    }

    // THE SEAL (epic #184607, component 7). On a sealed machine this command may
    // only read what the machine was granted. This is the TOOL layer and nothing
    // more — it does not stop curl, another binary, or a process that already has
    // the bytes — so the refusal says which boundary it is, rather than implying a
    // guarantee the CLI cannot make.
    const home = atlasHome()
    const sealed = readPolicy(home).sealed

    // A SEALED machine serves a granted item from its own disk, not from the cloud.
    // This is the point of the epic rather than a shortcut: "cognition is a deployed
    // artifact" is only true if reading an item does not quietly become a live query
    // whose answer can change under you mid-mission — and it is what makes this
    // command keep working with the cloud unreachable. `--fresh` bypasses it, which
    // is allowed for a GRANTED item because reading it was already granted.
    if (sealed && isGranted(home, uuid) && !args.fresh) {
      const pin = readManifest(home).pins[uuid]
      const abs = join(home, pin.path)
      if (existsSync(abs)) {
        const local = readFileSync(abs, "utf8")
        if (args.out) writeFileSync(args.out, local, "utf8")
        else process.stdout.write(local)
        if (!args.quiet)
          process.stderr.write(
            EOL +
              bold(`  ${pin.title}`) +
              EOL +
              dim(`  served from this machine's pin @${shortHash(pin.sha256)} · sealed, no network`) +
              EOL +
              (args.out ? dim(`  written to ${args.out}`) + EOL : "") +
              EOL,
          )
        return
      }
      // Granted, sealed, and the file is gone. Say that, rather than silently
      // reaching for the cloud — a machine that repairs itself over the network is
      // not a pinned machine, and the drift is the thing worth knowing.
      process.stderr.write(
        `Granted but not held: ${pin.path} is missing from this machine.${EOL}` +
          dim(`  iris atlas status        see the drift`) +
          EOL +
          dim(`  iris atlas use ${uuid.slice(0, 8)}… --fresh   re-read from the cloud`) +
          EOL,
      )
      process.exitCode = 1
      return
    }

    if (sealed && !isGranted(home, uuid)) {
      process.stderr.write(
        `Sealed: this machine was not granted ${uuid}.${EOL}` +
          dim(`  ${describeSeal()}`) +
          EOL +
          dim(`  iris atlas pins            what this machine holds`) +
          EOL +
          dim(`  iris atlas unseal          lift the seal (an operator decision, recorded)`) +
          EOL,
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
          dim(`Open it in a browser to unseal: https://heyiris.io/n/${uuid}`) +
          EOL,
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

    const payload = args.json
      ? JSON.stringify(item, null, 2) + "\n"
      : buildMarkdown(item, `https://heyiris.io/n/${uuid}`)

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
          bold(`  ${item.title ?? "Untitled"}`) +
          EOL +
          (where ? dim(`  ${where}`) + EOL : "") +
          dim(`  ${bits.join(" · ")}`) +
          EOL +
          (args.out ? dim(`  written to ${args.out}`) + EOL : "") +
          EOL,
      )
    }
  },
})
