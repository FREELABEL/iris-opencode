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

/** Export one bloq into baseDir. Returns its manifest. Shared by single + --all. */
async function exportOneBloq(
  bloqId: number,
  userId: number,
  baseDir: string,
  opts: { attachments: boolean; markdown: boolean },
  progress?: (msg: string) => void,
): Promise<Record<string, any>> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
  if (!res.ok) throw new Error(`fetch bloq ${bloqId}: HTTP ${res.status}`)

  const payload = (await res.json()) as { data?: any }
  const bloq = payload?.data ?? payload
  if (!bloq || (!bloq.id && !bloq.name)) throw new Error(`bloq ${bloqId}: empty response`)

  const lists: any[] = bloq?.lists ?? []
  const itemCount = lists.reduce((n, l) => n + (l?.items?.length ?? 0), 0)

  progress?.("Fetching attachments…")
  let files: any[] = []
  try {
    const filesRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/files`)
    if (filesRes.ok) {
      const filesData = (await filesRes.json()) as { data?: any[] }
      files = filesData?.data ?? []
    }
  } catch {
    // Non-fatal: an export missing attachments still beats no export. The
    // manifest records what we got, so the gap is visible rather than silent.
  }

  const slug = slugify(bloq?.name ?? "", `bloq-${bloqId}`)
  const outDir = path.join(baseDir, `bloq-${bloqId}-${slug}`)
  fs.mkdirSync(outDir, { recursive: true })

  progress?.("Writing JSON…")
  fs.writeFileSync(path.join(outDir, "bloq.json"), JSON.stringify(bloq, null, 2))
  if (files.length > 0) {
    fs.writeFileSync(path.join(outDir, "files.json"), JSON.stringify(files, null, 2))
  }

  let markdownWritten = 0
  if (opts.markdown) {
    progress?.("Writing markdown…")
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

  let filesDownloaded = 0
  let filesFailed = 0
  let bytesDownloaded = 0
  if (opts.attachments && files.length > 0) {
    const filesDir = path.join(outDir, "attachments")
    fs.mkdirSync(filesDir, { recursive: true })
    for (const [fi, f] of files.entries()) {
      const url = f?.url ?? f?.cdn_url ?? f?.public_url ?? f?.path
      const name = f?.original_name ?? f?.name ?? f?.filename ?? `file-${f?.id ?? fi}`
      if (!url) { filesFailed++; continue }
      progress?.(`Downloading ${fi + 1}/${files.length}…`)
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

  const manifest = {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    source: { api: "iris", bloq_id: bloqId, bloq_name: bloq?.name ?? null, user_id: userId },
    counts: {
      lists: lists.length,
      items: itemCount,
      markdown_files: markdownWritten,
      attachments_listed: files.length,
      attachments_downloaded: filesDownloaded,
      attachments_failed: filesFailed,
      attachment_bytes: bytesDownloaded,
    },
    includes_attachments: opts.attachments,
    notes: opts.attachments ? undefined : "Attachment BYTES were not downloaded (re-run with --attachments). files.json lists them.",
    output_dir: outDir,
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
  return manifest
}

export const BloqsExportCommand = cmd({
  command: "export [id]",
  describe: "export a bloq (lists, items, attachments) to a local folder — your data, off our servers",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID or name (omit with --all)", type: "string" })
      .option("all", { describe: "export EVERY bloq you own — a full workspace backup", type: "boolean", default: false })
      .option("out", { alias: "o", describe: "output directory (default: ./iris-export)", type: "string" })
      .option("attachments", { describe: "also download attached files (can be large)", type: "boolean", default: false })
      .option("no-markdown", { describe: "skip the human-readable markdown tree, JSON only", type: "boolean", default: false })
      .option("json", { describe: "JSON output (prints the manifest)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    const wantsAll = Boolean(args.all)

    // Guard before the intro — otherwise a bare `bloqs export` greets you with
    // "Export bloq undefined" before telling you what it actually wants.
    if (!wantsAll && !args.id) {
      if (args.json) console.log(JSON.stringify({ error: "Pass a bloq id/name, or --all to export everything." }, null, 2))
      else {
        UI.empty()
        console.error(`  Pass a bloq id/name, or ${bold("--all")} to export every bloq.`)
        console.error(`  ${dim("e.g. iris bloqs export 503   ·   iris bloqs export --all -o ~/iris-backup")}`)
        UI.empty()
      }
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(wantsAll ? "◈  Export workspace" : `◈  Export bloq ${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const baseDir = path.resolve(String(args.out ?? "./iris-export"))
    const opts = { attachments: Boolean(args.attachments), markdown: !args["no-markdown"] }
    const spinner = args.json ? null : prompts.spinner()

    try {
      // ── Whole-workspace backup ────────────────────────────────────────────
      // The point of --all is that one command (and therefore one cron line)
      // captures everything. A per-bloq failure must not abort the run, or a
      // single bad bloq costs you the whole backup — so failures are collected
      // and reported, never thrown away silently.
      if (wantsAll) {
        if (spinner) spinner.start("Listing bloqs…")
        const listRes = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=200`)
        if (!listRes.ok) {
          if (spinner) spinner.stop("Failed", 1)
          await handleApiError(listRes, "List bloqs")
          if (!args.json) prompts.outro("Done")
          return
        }
        const listData = (await listRes.json()) as { data?: any[] }
        const bloqs: any[] = listData?.data ?? []

        const results: Record<string, any>[] = []
        const failures: { bloq_id: number; name: string | null; error: string }[] = []

        for (const [i, b] of bloqs.entries()) {
          const bid = Number(b?.id)
          if (!Number.isInteger(bid)) continue
          if (spinner) spinner.message(`(${i + 1}/${bloqs.length}) ${b?.name ?? bid}…`)
          try {
            results.push(await exportOneBloq(bid, userId, baseDir, opts))
          } catch (e: any) {
            failures.push({ bloq_id: bid, name: b?.name ?? null, error: e?.message ?? String(e) })
          }
        }

        const totals = results.reduce(
          (acc, m) => ({
            lists: acc.lists + (m.counts?.lists ?? 0),
            items: acc.items + (m.counts?.items ?? 0),
            attachments_downloaded: acc.attachments_downloaded + (m.counts?.attachments_downloaded ?? 0),
          }),
          { lists: 0, items: 0, attachments_downloaded: 0 },
        )

        const wsManifest = {
          format_version: EXPORT_FORMAT_VERSION,
          exported_at: new Date().toISOString(),
          scope: "workspace",
          source: { api: "iris", user_id: userId },
          counts: { bloqs_found: bloqs.length, bloqs_exported: results.length, bloqs_failed: failures.length, ...totals },
          failures,
          includes_attachments: opts.attachments,
          bloqs: results.map((m) => ({ bloq_id: m.source?.bloq_id, name: m.source?.bloq_name, ...m.counts })),
          output_dir: baseDir,
        }
        fs.mkdirSync(baseDir, { recursive: true })
        fs.writeFileSync(path.join(baseDir, "workspace-manifest.json"), JSON.stringify(wsManifest, null, 2))

        if (spinner) spinner.stop(failures.length ? "Exported (with failures)" : "Exported")
        if (args.json) { console.log(JSON.stringify(wsManifest, null, 2)); return }

        printDivider()
        printKV("Bloqs", `${results.length}/${bloqs.length} exported${failures.length ? ` ${dim(`· ${failures.length} failed`)}` : ""}`)
        printKV("Lists", String(totals.lists))
        printKV("Items", String(totals.items))
        if (opts.attachments) printKV("Attachments", String(totals.attachments_downloaded))
        printKV("Output", baseDir)
        printDivider()
        if (failures.length) {
          console.log(`  ${dim("Failed:")}`)
          for (const f of failures.slice(0, 10)) console.log(`    ${dim("—")} #${f.bloq_id} ${f.name ?? ""} ${dim(f.error)}`)
          console.log()
        }
        console.log(`  ${success("✓")} ${dim("workspace-manifest.json lists every bloq and every failure")}`)
        console.log()
        prompts.outro("Done")
        return
      }

      // ── Single bloq ───────────────────────────────────────────────────────
      const resolvedId = await resolveBloqId(args.id as any, userId, Boolean(args.json))
      if (resolvedId === null) { if (!args.json) prompts.outro("Done"); return }

      if (spinner) spinner.start("Fetching bloq…")
      const manifest = await exportOneBloq(resolvedId, userId, baseDir, opts, (m) => spinner?.message(m))
      if (spinner) spinner.stop("Exported")

      if (args.json) { console.log(JSON.stringify(manifest, null, 2)); return }

      printDivider()
      printKV("Bloq", `${bold(String(manifest.source?.bloq_name ?? resolvedId))} ${dim(`#${resolvedId}`)}`)
      printKV("Lists", String(manifest.counts?.lists ?? 0))
      printKV("Items", String(manifest.counts?.items ?? 0))
      if ((manifest.counts?.attachments_listed ?? 0) > 0) {
        printKV(
          "Attachments",
          opts.attachments
            ? `${manifest.counts.attachments_downloaded}/${manifest.counts.attachments_listed} downloaded ${dim(`(${formatBytes(manifest.counts.attachment_bytes ?? 0)})`)}${manifest.counts.attachments_failed ? ` ${dim(`· ${manifest.counts.attachments_failed} failed`)}` : ""}`
            : `${manifest.counts.attachments_listed} listed ${dim("(re-run with --attachments to download)")}`,
        )
      }
      printKV("Output", manifest.output_dir)
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
