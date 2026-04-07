import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { FL_API, requireAuth, printDivider, printKV, dim, success, highlight } from "./iris-api"
import { existsSync, statSync, readFileSync } from "fs"
import { basename } from "path"
import { Auth } from "../../auth"

const DIRECT_UPLOAD_THRESHOLD = 95 * 1024 * 1024

interface ParsedExpiration {
  days: number
  hours: number
  label: string
}

function parseExpiration(input: string): ParsedExpiration {
  const s = (input ?? "").toString().toLowerCase().trim()
  if (["", "0", "never", "permanent", "none"].includes(s)) {
    return { days: 0, hours: 0, label: "Never (permanent)" }
  }
  const m = s.match(/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|m|mo|mos|month|months|y|yr|yrs|year|years)?$/)
  if (m) {
    const value = parseInt(m[1], 10)
    const unit = m[2] ?? "d"
    if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) {
      return { days: Math.ceil(value / 24), hours: value, label: `${value} hour${value !== 1 ? "s" : ""}` }
    }
    if (["w", "wk", "wks", "week", "weeks"].includes(unit)) {
      return { days: value * 7, hours: 0, label: `${value} week${value !== 1 ? "s" : ""}` }
    }
    if (["m", "mo", "mos", "month", "months"].includes(unit)) {
      return { days: value * 30, hours: 0, label: `${value} month${value !== 1 ? "s" : ""}` }
    }
    if (["y", "yr", "yrs", "year", "years"].includes(unit)) {
      return { days: value * 365, hours: 0, label: `${value} year${value !== 1 ? "s" : ""}` }
    }
    return { days: value, hours: 0, label: `${value} day${value !== 1 ? "s" : ""}` }
  }
  if (/^\d+$/.test(s)) {
    const v = parseInt(s, 10)
    return { days: v, hours: 0, label: `${v} day${v !== 1 ? "s" : ""}` }
  }
  return { days: 180, hours: 0, label: "180 days (default)" }
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

async function resolveToken(): Promise<string> {
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) return stored.key
  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  return ""
}

export const PlatformCloudUploadCommand = cmd({
  command: "cloud:upload [file]",
  describe: "upload a file to cloud storage and get CDN + share URLs",
  builder: (y) =>
    y
      .positional("file", { describe: "local file path", type: "string" })
      .option("url", { describe: "download from URL instead", type: "string" })
      .option("title", { alias: "t", describe: "custom title", type: "string" })
      .option("description", { alias: "d", describe: "description", type: "string" })
      .option("expires", { alias: "e", describe: "expiration (e.g. 1d, 12h, 90, never)", type: "string", default: "180" })
      .option("bloq", { alias: "b", describe: "bloq ID to associate", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!args.json) prompts.intro("◈  Cloud Upload")

    if (!args.file && !args.url) {
      prompts.log.error("Provide a file path or --url")
      prompts.outro("Done")
      return
    }

    if (!(await requireAuth())) { prompts.outro("Done"); return }

    let localPath: string
    let originalFilename: string
    let tempFile: string | null = null

    try {
      if (args.url) {
        const sp = prompts.spinner()
        sp.start(`Downloading from ${args.url}…`)
        const r = await fetch(args.url)
        if (!r.ok) { sp.stop("Failed", 1); prompts.outro("Done"); return }
        const buf = Buffer.from(await r.arrayBuffer())
        const ext = (args.url.split("?")[0].split(".").pop() ?? "").slice(0, 6)
        tempFile = `/tmp/iris_cloud_upload_${Date.now()}${ext ? "." + ext : ""}`
        require("fs").writeFileSync(tempFile, buf)
        localPath = tempFile
        originalFilename = args.title ?? basename(args.url.split("?")[0])
        sp.stop(`Downloaded ${formatBytes(buf.length)}`)
      } else {
        if (!existsSync(args.file!)) {
          prompts.log.error(`File not found: ${args.file}`)
          prompts.outro("Done")
          return
        }
        localPath = args.file!
        originalFilename = basename(args.file!)
      }

      const fileSize = statSync(localPath).size
      if (!args.json) {
        prompts.log.info(`File: ${originalFilename}`)
        prompts.log.info(`Size: ${formatBytes(fileSize)}`)
      }

      if (fileSize > DIRECT_UPLOAD_THRESHOLD) {
        prompts.log.error(
          `File >95MB. Direct S3 upload not yet supported in TypeScript port — use the PHP CLI for large files.`,
        )
        prompts.outro("Done")
        return
      }

      const expiration = parseExpiration(args.expires)
      const sp = prompts.spinner()
      sp.start("Uploading…")

      const fileBuffer = readFileSync(localPath)
      const blob = new Blob([new Uint8Array(fileBuffer)])
      const form = new FormData()
      form.append("file", blob, originalFilename)
      form.append("type", "digital_product")
      if (args.title) form.append("title", args.title)
      if (args.description) form.append("description", args.description)
      if (args.bloq) form.append("bloq_id", String(args.bloq))
      if (expiration.days > 0) form.append("expires_days", String(expiration.days))

      const token = await resolveToken()
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token) headers["Authorization"] = `Bearer ${token}`

      const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, {
        method: "POST",
        body: form,
        headers,
      })

      if (!res.ok) {
        sp.stop("Failed", 1)
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        prompts.log.error(`Upload failed: ${msg.slice(0, 300)}`)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as any
      const result = data?.data ?? data
      const fileId = result.id
      const cdnUrl = result.cdn_url ?? result.url ?? result.filepath ?? ""
      const shareUrl = result.share_url ?? (fileId ? `https://elon.freelabel.net/content/Cloud/file/${fileId}` : "")
      const title = result.title ?? originalFilename
      const expiresAt = result.expires_at ?? null

      sp.stop(success("Uploaded"))

      if (args.json) {
        console.log(JSON.stringify({
          file_id: fileId,
          title,
          cdn_url: cdnUrl,
          share_url: shareUrl,
          size: result.file_size ?? fileSize,
          expires_at: expiresAt,
          expires: expiration.label,
        }, null, 2))
      } else {
        printDivider()
        printKV("File ID", fileId)
        printKV("Title", title)
        printKV("Size", formatBytes(fileSize))
        printKV("Expires", expiration.label + (expiresAt ? ` (${expiresAt})` : ""))
        console.log()
        console.log(`  ${dim("CDN:")}    ${highlight(cdnUrl)}`)
        console.log(`  ${dim("Share:")}  ${highlight(shareUrl)}`)
        printDivider()
        prompts.outro("Done")
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    } finally {
      if (tempFile) {
        try { require("fs").unlinkSync(tempFile) } catch {}
      }
    }
  },
})
