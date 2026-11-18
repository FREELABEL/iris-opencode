import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { FL_API, requireAuth, printDivider, printKV, dim, bold, success, highlight, warn, writeJson } from "./iris-api"
import { existsSync, statSync, readFileSync } from "fs"
import { basename } from "path"
import { Auth } from "../../auth"

const DIRECT_UPLOAD_THRESHOLD = 95 * 1024 * 1024

/**
 * #193366 — the default used to be "180" days for EVERY file. A share card (og:image), an email
 * image, a newsletter figure or an ad creative is referenced forever from a page or an email that
 * is already out, so a 180-day link breaks it six months later with nothing to warn anybody. The
 * server's own default is permanent (no expires_days → expires_at NULL), so the CLI was the only
 * thing adding a fuse.
 *
 * Now: files that get EMBEDDED somewhere (images, HTML/CSS, PDF, video, audio, fonts) default to
 * never. Anything else (zips, CSVs, exports, archives) keeps a 180-day default, and the output says
 * so loudly, with the date and the flag that keeps it. An explicit --expires always wins, and a
 * value we cannot parse is an error instead of quietly becoming 180 days.
 */
export const DEFAULT_EXPIRES_DAYS = 180

export const PERMANENT_BY_DEFAULT_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp", "tif", "tiff", "heic", "heif",
  // web documents
  "html", "htm", "css",
  // documents
  "pdf",
  // video
  "mp4", "mov", "webm", "m4v", "mkv", "avi",
  // audio
  "mp3", "wav", "m4a", "aac", "ogg", "flac",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
])

export interface ParsedExpiration {
  days: number
  hours: number
  label: string
}

export interface ResolvedExpiration extends ParsedExpiration {
  /** true when no expires_days is sent: the file never expires. */
  permanent: boolean
  /** "flag" when --expires was given, "type" when the file's kind picked the default. */
  source: "flag" | "type"
}

/** Parse an --expires value. Returns null for anything we do not understand. */
export function parseExpiration(input: string): ParsedExpiration | null {
  const s = (input ?? "").toString().toLowerCase().trim()
  if (["", "0", "never", "permanent", "none"].includes(s)) {
    return { days: 0, hours: 0, label: "Never (permanent)" }
  }
  const m = s.match(/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|m|mo|mos|month|months|y|yr|yrs|year|years)?$/)
  if (!m) return null
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

export function fileExtension(filename: string): string {
  const m = (filename ?? "").toLowerCase().match(/\.([a-z0-9]{1,6})$/)
  return m ? m[1] : ""
}

/** Should a file with this name be permanent when --expires is not given? */
export function isPermanentByDefault(filename: string): boolean {
  return PERMANENT_BY_DEFAULT_EXTENSIONS.has(fileExtension(filename))
}

/**
 * The expiry actually applied. `expires` is the raw --expires value (undefined when not given).
 * Throws on a value that cannot be parsed.
 */
export function resolveExpiration(expires: string | undefined, filename: string): ResolvedExpiration {
  if (expires !== undefined && expires !== null) {
    const parsed = parseExpiration(String(expires))
    if (!parsed) {
      throw new Error(
        `Can't read --expires "${expires}". Use a number of days (90), a unit (12h, 2w, 6mo, 1y) or "never".`,
      )
    }
    return { ...parsed, permanent: parsed.days === 0, source: "flag" }
  }
  if (isPermanentByDefault(filename)) {
    return { days: 0, hours: 0, label: "Never (permanent)", permanent: true, source: "type" }
  }
  return {
    days: DEFAULT_EXPIRES_DAYS,
    hours: 0,
    label: `${DEFAULT_EXPIRES_DAYS} days (default for this file type)`,
    permanent: false,
    source: "type",
  }
}

/** The date a non-permanent upload stops working, as YYYY-MM-DD. */
export function expiryDate(resolved: ResolvedExpiration, expiresAt: string | null, now = new Date()): string | null {
  if (resolved.permanent) return null
  if (expiresAt) {
    const d = new Date(expiresAt)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  return new Date(now.getTime() + resolved.days * 86_400_000).toISOString().slice(0, 10)
}

/** The plain-language warning printed (and put in --json) when a link will die. */
export function expiryWarning(resolved: ResolvedExpiration, date: string | null): string | null {
  if (resolved.permanent) return null
  const when = date ? `on ${date}` : `in ${resolved.label}`
  return (
    `This link STOPS WORKING ${when}. Anything that embeds it (a page, an email, a post) will break then. ` +
    `To keep it, upload with --expires never.`
  )
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
  // Prefer FL_API_TOKEN (JWT) for cloud-files endpoint, fall back to IRIS_API_KEY
  if (process.env.FL_API_TOKEN) return process.env.FL_API_TOKEN
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
      .option("expires", {
        alias: "e",
        describe:
          "expiration: 90, 12h, 2w, 6mo, 1y or never. Default: never for images, HTML/CSS, PDF, video, audio and fonts; 180 days for anything else",
        type: "string",
      })
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
        // Derive a real extension — Content-Type first (authoritative), then the URL
        // path. Without one the stored object is served as text/plain and the image
        // won't render in an <img> (#152289 — e.g. `--title` with no extension).
        const ctMap: Record<string, string> = {
          "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
          "image/gif": "gif", "image/svg+xml": "svg", "application/pdf": "pdf", "video/mp4": "mp4",
        }
        const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
        const urlExt = (args.url.split("?")[0].split(".").pop() ?? "").toLowerCase()
        const ext = ctMap[ct] ?? (/^[a-z0-9]{2,5}$/.test(urlExt) ? urlExt : "")
        tempFile = `/tmp/iris_cloud_upload_${Date.now()}${ext ? "." + ext : ""}`
        require("fs").writeFileSync(tempFile, buf)
        localPath = tempFile
        let base = args.title ?? basename(args.url.split("?")[0])
        if (ext && !/\.[a-z0-9]{2,5}$/i.test(base)) base = `${base}.${ext}` // keep an extension so MIME is correct
        originalFilename = base
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

      let expiration: ResolvedExpiration
      try {
        expiration = resolveExpiration(args.expires, originalFilename)
      } catch (e) {
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.outro("Done")
        process.exitCode = 1
        return
      }
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
      // user_id required by cloud-files endpoint
      const userId = process.env.IRIS_USER_ID ?? "193"
      form.append("user_id", userId)

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

      const dies = expiryDate(expiration, expiresAt)
      const warning = expiryWarning(expiration, dies)

      if (args.json) {
        await writeJson({
          file_id: fileId,
          title,
          cdn_url: cdnUrl,
          share_url: shareUrl,
          size: result.file_size ?? fileSize,
          expires_at: expiresAt,
          expires: expiration.label,
          permanent: expiration.permanent,
          expires_source: expiration.source,
          warning,
        })
        // stderr too, so a script that only keeps stdout's JSON still shows a person the warning
        if (warning) process.stderr.write(`WARNING: ${warning}\n`)
      } else {
        printDivider()
        printKV("File ID", fileId)
        printKV("Title", title)
        printKV("Size", formatBytes(fileSize))
        if (expiration.permanent) {
          printKV("Expires", success("Never (permanent)"))
        } else {
          printKV("Expires", bold(warn(`${dies ?? expiration.label}  (${expiration.label})`)))
        }
        console.log()
        console.log(`  ${dim("CDN:")}    ${highlight(cdnUrl)}`)
        console.log(`  ${dim("Share:")}  ${highlight(shareUrl)}`)
        printDivider()
        if (warning) prompts.log.warn(bold(warn(warning)))
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
