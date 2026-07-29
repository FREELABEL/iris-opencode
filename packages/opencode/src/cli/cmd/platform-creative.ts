import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { FL_API, requireAuth, resolveUserId, success, dim, printKV, printDivider } from "./iris-api"
import { existsSync, statSync, readFileSync } from "fs"
import { basename, extname } from "path"
import { Auth } from "../../auth"

/**
 * `iris creative register` — the client half of the Remotion → Review Studio
 * pipeline.
 *
 * Uploading a render used to leave it invisible: `cloud:upload`, `cloud:upload
 * --bloq` and `bloqs ingest` all report success but only create a CloudFile,
 * while Review Studio renders BloqItems. The only thing that creates a
 * reviewable item is POST .../bloqs/{bloqId}/creatives, which had no CLI
 * wrapper — so every generated asset stayed stranded on the machine that made
 * it (#178071, and the "client half" left open by the 2026-07-11 audit).
 *
 * This posts the file(s) to that endpoint, which hosts to R2 server-side. The
 * client needs only its auth token — no R2 credentials, no `railway run`.
 */

// registerCreative validates: 50MB per file, max 20 files, image/video only.
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_FILES = 20
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov"])

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
}

async function resolveToken(): Promise<string> {
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) return stored.key
  if (process.env.FL_API_TOKEN) return process.env.FL_API_TOKEN
  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  return ""
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)} ${units[i]}`
}

export const PlatformCreativeCommand = cmd({
  command: "creative <command>",
  describe: "register rendered creative into a bloq so it appears in Review Studio",
  builder: (y) =>
    y
      .command(
        "register <bloq> <files..>",
        "upload render(s) as a reviewable creative item",
        (yy: any) =>
          yy
            .positional("bloq", { describe: "bloq (board) ID", type: "number" })
            .positional("files", { describe: "one or more image/video paths", type: "string" })
            .option("title", { alias: "t", describe: "item title", type: "string" })
            .option("caption", { alias: "c", describe: "caption / generated content", type: "string" })
            .option("platform", { alias: "p", describe: "target platform", type: "string", default: "instagram" })
            .option("campaign", { describe: "outreach campaign ID", type: "number" })
            .option("separate", {
              describe: "register each file as its own item instead of one carousel",
              type: "boolean",
              default: false,
            })
            .option("json", { describe: "JSON output", type: "boolean", default: false }),
        async (args: any) => registerHandler(args),
      )
      .demandCommand(1, "Specify a subcommand, e.g. `iris creative register 545 flyer.png`"),
  async handler() {
    // yargs dispatches to the subcommand; this only runs for a bare `iris creative`.
  },
})

async function registerHandler(args: any) {
  UI.empty()
  if (!args.json) prompts.intro("◈  Register Creative")

  if (!(await requireAuth())) {
    prompts.outro("Done")
    return
  }

  const paths: string[] = (Array.isArray(args.files) ? args.files : [args.files]).filter(Boolean)

  // Validate everything BEFORE uploading anything — a half-registered batch is
  // worse than a refused one.
  const problems: string[] = []
  for (const p of paths) {
    if (!existsSync(p)) {
      problems.push(`not found: ${p}`)
      continue
    }
    const ext = extname(p).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      problems.push(`unsupported type ${ext || "(none)"}: ${basename(p)} — images and video only`)
      continue
    }
    const size = statSync(p).size
    if (size > MAX_FILE_BYTES) {
      problems.push(`too large (${formatBytes(size)}, limit 50 MB): ${basename(p)}`)
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) prompts.log.error(problem)
    prompts.outro("Done")
    process.exitCode = 1
    return
  }

  const userId = await resolveUserId()
  if (!userId) {
    prompts.log.error("Could not resolve a user ID — run `iris login` or set IRIS_USER_ID.")
    prompts.outro("Done")
    process.exitCode = 1
    return
  }

  // Multiple files in one call become a CAROUSEL item server-side. --separate
  // registers each as its own item, which is what a batch of unrelated renders
  // usually wants.
  const batches: string[][] = args.separate ? paths.map((p) => [p]) : [paths]

  for (const batch of batches) {
    if (batch.length > MAX_FILES) {
      prompts.log.error(`${batch.length} files exceeds the ${MAX_FILES}-file limit for one item.`)
      process.exitCode = 1
      return
    }
  }

  const token = await resolveToken()
  const results: any[] = []
  let failed = 0

  for (const batch of batches) {
    const label = batch.length === 1 ? basename(batch[0]) : `${batch.length} files (carousel)`
    const sp = args.json ? null : prompts.spinner()
    sp?.start(`Registering ${label}…`)

    const form = new FormData()
    for (const p of batch) {
      const buffer = readFileSync(p)
      const mime = MIME_BY_EXT[extname(p).toLowerCase()] ?? "application/octet-stream"
      form.append("files[]", new Blob([new Uint8Array(buffer)], { type: mime }), basename(p))
    }
    if (args.title) form.append("title", args.title)
    if (args.caption) form.append("caption", args.caption)
    if (args.platform) form.append("platform", args.platform)
    if (args.campaign) form.append("campaign_id", String(args.campaign))

    const headers: Record<string, string> = { Accept: "application/json" }
    if (token) headers["Authorization"] = `Bearer ${token}`

    try {
      const res = await fetch(`${FL_API}/api/v1/user/${userId}/bloqs/${args.bloq}/creatives`, {
        method: "POST",
        body: form,
        headers,
      })

      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        sp?.stop("Failed", 1)
        if (!args.json) prompts.log.error(`${label}: ${msg.slice(0, 240)}`)
        results.push({ files: batch.map((f) => basename(f)), ok: false, error: msg.slice(0, 240) })
        failed++
        continue
      }

      const data = (await res.json()) as any
      const item = data?.data ?? data?.item ?? data
      const itemId = item?.id ?? null

      sp?.stop(success(`Registered ${label}`))
      if (!args.json && itemId) prompts.log.info(dim(`  item #${itemId}`))
      results.push({ files: batch.map((f) => basename(f)), ok: true, item_id: itemId })
    } catch (err: any) {
      sp?.stop("Failed", 1)
      if (!args.json) prompts.log.error(`${label}: ${err?.message ?? err}`)
      results.push({ files: batch.map((f) => basename(f)), ok: false, error: String(err?.message ?? err) })
      failed++
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ bloq_id: Number(args.bloq), registered: results }, null, 2))
    if (failed > 0) process.exitCode = 1
    return
  }

  const ok = results.filter((r) => r.ok).length
  printDivider()
  printKV("Bloq", String(args.bloq))
  printKV("Registered", `${ok} item(s)`)
  if (failed > 0) printKV("Failed", String(failed))
  printDivider()
  prompts.log.info(dim(`iris bloqs get ${args.bloq}`))
  prompts.outro("Done")

  // Non-zero on partial failure so a batch script can't mistake it for success —
  // the whole point of this command is that silent success was the bug.
  if (failed > 0) process.exitCode = 1
}
