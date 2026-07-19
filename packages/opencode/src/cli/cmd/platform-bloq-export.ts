import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success } from "./iris-api"
import { resolveBloqId } from "./platform-bloqs"
import fs from "fs"
import path from "path"

// ============================================================================
// iris bloqs export — get your data OUT.
//
// Every other data path we ship points inward: `data-sources sync` pulls cloud
// storage INTO a bloq, `bloqs ingest` uploads a file INTO a bloq. The only way
// out was a per-entity `pull <id>` (boards/leads/agents/…), one id at a time,
// and the bloq container itself — lists, items, attachments — had no pull at
// all. So "can I get my data out?" had no good answer.
//
// This is that answer: walk one bloq and write it to disk, in a form that
// survives us (raw JSON for fidelity + markdown for humans).
// ============================================================================

const EXPORT_FORMAT_VERSION = 1

/** Filesystem-safe slug for a name, so exports are browsable, not hash soup. */
function slugify(input: string, fallback: string): string {
  const s = String(input ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60)
  return s || fallback
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Best-effort title for an item, mirroring the board UI's own fallback chain. */
function exportItemTitle(item: Record<string, any>): string {
  return item?.title ?? item?.name ?? item?.content?.title ?? `item-${item?.id ?? "unknown"}`
}

/** Item body as markdown — content is sometimes a string, sometimes an object. */
function exportItemBody(item: Record<string, any>): string {
  const c = item?.content
  if (typeof c === "string") return c
  if (c && typeof c === "object") {
    if (typeof c.body === "string") return c.body
    if (typeof c.text === "string") return c.text
    if (typeof c.markdown === "string") return c.markdown
    return "```json\n" + JSON.stringify(c, null, 2) + "\n```"
  }
  if (typeof item?.description === "string") return item.description
  return ""
}

/** One item → a portable markdown file with its metadata in frontmatter. */
function itemToMarkdown(item: Record<string, any>, listName: string): string {
  const fm: string[] = ["---"]
  fm.push(`iris_item_id: ${item?.id ?? "null"}`)
  fm.push(`title: ${JSON.stringify(exportItemTitle(item))}`)
  fm.push(`list: ${JSON.stringify(listName)}`)
  if (item?.status) fm.push(`status: ${JSON.stringify(String(item.status))}`)
  if (item?.type) fm.push(`type: ${JSON.stringify(String(item.type))}`)
  if (item?.priority) fm.push(`priority: ${JSON.stringify(String(item.priority))}`)
  if (item?.due_date) fm.push(`due_date: ${JSON.stringify(String(item.due_date))}`)
  if (item?.created_at) fm.push(`created_at: ${JSON.stringify(String(item.created_at))}`)
  if (item?.updated_at) fm.push(`updated_at: ${JSON.stringify(String(item.updated_at))}`)
  fm.push("---", "")

  // Don't stack a second H1 on bodies that already open with one — published
  // docs (`bloqs publish`) carry their own title, so prepending here gave every
  // one of them a duplicated heading.
  const body = exportItemBody(item)
  const opensWithHeading = /^\s*#\s+\S/.test(body)
  const heading = opensWithHeading ? "" : `# ${exportItemTitle(item)}\n\n`
  return fm.join("\n") + heading + body.replace(/^\s+/, "") + "\n"
}

export const BloqsExportCommand = cmd({
  command: "export <id>",
  describe: "export a bloq (lists, items, attachments) to a local folder — your data, off our servers",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID or name", type: "string", demandOption: true })
      .option("out", { alias: "o", describe: "output directory (default: ./iris-export)", type: "string" })
      .option("attachments", { describe: "also download attached files (can be large)", type: "boolean", default: false })
      .option("no-markdown", { describe: "skip the human-readable markdown tree, JSON only", type: "boolean", default: false })
      .option("json", { describe: "JSON output (prints the manifest)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Export bloq ${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const resolvedId = await resolveBloqId(args.id as any, userId, Boolean(args.json))
    if (resolvedId === null) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Fetching bloq…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${resolvedId}`)
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        await handleApiError(res, "Export bloq")
        if (!args.json) prompts.outro("Done")
        return
      }

      const payload = (await res.json()) as { data?: any }
      const bloq = payload?.data ?? payload
      if (!bloq || (!bloq.id && !bloq.name)) {
        if (spinner) spinner.stop("Empty response", 1)
        if (!args.json) prompts.outro("Done")
        return
      }

      const lists: any[] = bloq?.lists ?? []
      const itemCount = lists.reduce((n, l) => n + (l?.items?.length ?? 0), 0)

      // Attachments are a separate endpoint — the bloq payload doesn't carry them.
      if (spinner) spinner.message("Fetching attachments…")
      let files: any[] = []
      try {
        const filesRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${resolvedId}/files`)
        if (filesRes.ok) {
          const filesData = (await filesRes.json()) as { data?: any[] }
          files = filesData?.data ?? []
        }
      } catch {
        // Non-fatal: an export missing attachments still beats no export. The
        // manifest records what we got, so the gap is visible rather than silent.
      }

      const slug = slugify(bloq?.name ?? "", `bloq-${resolvedId}`)
      const baseDir = path.resolve(String(args.out ?? "./iris-export"))
      const outDir = path.join(baseDir, `bloq-${resolvedId}-${slug}`)
      fs.mkdirSync(outDir, { recursive: true })

      // 1. Raw payload — the fidelity copy. Everything the API gave us, verbatim.
      if (spinner) spinner.message("Writing JSON…")
      fs.writeFileSync(path.join(outDir, "bloq.json"), JSON.stringify(bloq, null, 2))
      if (files.length > 0) {
        fs.writeFileSync(path.join(outDir, "files.json"), JSON.stringify(files, null, 2))
      }

      // 2. Markdown tree — the copy that stays readable without us.
      let markdownWritten = 0
      if (!args["no-markdown"]) {
        if (spinner) spinner.message("Writing markdown…")
        const itemsRoot = path.join(outDir, "items")
        fs.mkdirSync(itemsRoot, { recursive: true })

        for (const [li, list] of lists.entries()) {
          const listName = list?.name ?? `list-${list?.id ?? li}`
          const listDir = path.join(itemsRoot, `${String(li + 1).padStart(2, "0")}-${slugify(listName, `list-${li + 1}`)}`)
          fs.mkdirSync(listDir, { recursive: true })

          for (const [ii, item] of (list?.items ?? []).entries()) {
            const fileName = `${String(ii + 1).padStart(3, "0")}-${slugify(exportItemTitle(item), `item-${ii + 1}`)}.md`
            fs.writeFileSync(path.join(listDir, fileName), itemToMarkdown(item, listName))
            markdownWritten++
          }
        }
      }

      // 3. Attachments — opt-in, because these are the bytes that get big.
      let filesDownloaded = 0
      let filesFailed = 0
      let bytesDownloaded = 0
      if (args.attachments && files.length > 0) {
        const filesDir = path.join(outDir, "attachments")
        fs.mkdirSync(filesDir, { recursive: true })

        for (const [fi, f] of files.entries()) {
          const url = f?.url ?? f?.cdn_url ?? f?.public_url ?? f?.path
          const name = f?.original_name ?? f?.name ?? f?.filename ?? `file-${f?.id ?? fi}`
          if (!url) { filesFailed++; continue }
          if (spinner) spinner.message(`Downloading ${fi + 1}/${files.length}…`)
          try {
            const dl = await fetch(String(url))
            if (!dl.ok) { filesFailed++; continue }
            const buf = Buffer.from(await dl.arrayBuffer())
            fs.writeFileSync(path.join(filesDir, `${String(fi + 1).padStart(3, "0")}-${name}`), buf)
            filesDownloaded++
            bytesDownloaded += buf.length
          } catch {
            filesFailed++
          }
        }
      }

      // 4. Manifest — what this export contains and what it does NOT. An export
      // you can't verify is an export you can't trust, so counts go on disk.
      const manifest = {
        format_version: EXPORT_FORMAT_VERSION,
        exported_at: new Date().toISOString(),
        source: { api: "iris", bloq_id: Number(resolvedId), bloq_name: bloq?.name ?? null, user_id: userId },
        counts: {
          lists: lists.length,
          items: itemCount,
          markdown_files: markdownWritten,
          attachments_listed: files.length,
          attachments_downloaded: filesDownloaded,
          attachments_failed: filesFailed,
        },
        includes_attachments: Boolean(args.attachments),
        notes: args.attachments
          ? undefined
          : "Attachment BYTES were not downloaded (re-run with --attachments). files.json lists them.",
        output_dir: outDir,
      }
      fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))

      if (spinner) spinner.stop("Exported")

      if (args.json) {
        console.log(JSON.stringify(manifest, null, 2))
        return
      }

      printDivider()
      printKV("Bloq", `${bold(String(bloq?.name ?? resolvedId))} ${dim(`#${resolvedId}`)}`)
      printKV("Lists", String(lists.length))
      printKV("Items", String(itemCount))
      if (files.length > 0) {
        printKV(
          "Attachments",
          args.attachments
            ? `${filesDownloaded}/${files.length} downloaded ${dim(`(${formatBytes(bytesDownloaded)})`)}${filesFailed ? ` ${dim(`· ${filesFailed} failed`)}` : ""}`
            : `${files.length} listed ${dim("(re-run with --attachments to download)")}`,
        )
      }
      printKV("Output", outDir)
      printDivider()
      console.log(`  ${success("✓")} ${dim("bloq.json (full fidelity) · items/ (markdown) · manifest.json")}`)
      console.log()
      prompts.outro("Done")
    } catch (err: any) {
      if (spinner) spinner.stop("Failed", 1)
      if (args.json) {
        console.log(JSON.stringify({ error: err?.message ?? String(err) }, null, 2))
      } else {
        console.error(`  Export failed: ${err?.message ?? String(err)}`)
        prompts.outro("Done")
      }
    }
  },
})
