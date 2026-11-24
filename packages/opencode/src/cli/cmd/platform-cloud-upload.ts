import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { FL_API, requireAuth, resolveUserId, printDivider, printKV, dim, bold, success, highlight, warn, writeJson } from "./iris-api"
import { existsSync, statSync, readFileSync } from "fs"
import { basename } from "path"
import { Auth } from "../../auth"

export const DIRECT_UPLOAD_THRESHOLD = 95 * 1024 * 1024

/**
 * #194118 — a file over the limit used to print a pointer to a "PHP CLI" nobody has, then
 * "Done", and exit 0. Scripts, playbooks and agents recorded an upload that never happened.
 * Every path that uploads nothing now says so and exits 1.
 */
export function tooLargeMessage(size: number): string {
  return (
    `${formatBytes(size)} is over ${formatBytes(DIRECT_UPLOAD_THRESHOLD)} and this server does not take large uploads yet — nothing was uploaded. ` +
    `Share it from Google Drive, Dropbox or AirDrop, or split it into parts under ${formatBytes(DIRECT_UPLOAD_THRESHOLD)}.`
  )
}

/** Content-Type for a direct upload. The presigned URL is signed for exactly this value. */
export function guessContentType(filename: string): string {
  const map: Record<string, string> = {
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
    rar: "application/vnd.rar", pdf: "application/pdf", json: "application/json", csv: "text/csv", txt: "text/plain",
    wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
    aif: "audio/aiff", aiff: "audio/aiff", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mkv: "video/x-matroska", m4v: "video/x-m4v", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", psd: "image/vnd.adobe.photoshop",
  }
  return map[fileExtension(filename)] ?? "application/octet-stream"
}

/**
 * A refused upload, in words (#194118). The server says why (file_too_large,
 * quota_exceeded) and how much space is left; say that, not "HTTP 413".
 */
export function refusalMessage(body: any, status: number): string {
  const msg = body?.message ?? (typeof body === "string" ? body : "")
  const st = body?.storage
  const usage =
    st && typeof st.used_bytes === "number" && typeof st.quota_bytes === "number" && st.quota_bytes >= 0
      ? ` (using ${formatBytes(st.used_bytes)} of ${formatBytes(st.quota_bytes)}${st.tier_name ? ` on ${st.tier_name}` : ""} — see \`iris cloud:usage\`)`
      : ""
  return `${msg || `Upload refused (HTTP ${status})`}${usage}`
}

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

export function formatBytes(bytes: number): string {
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

export interface DirectUploadOptions {
  path: string
  filename: string
  size: number
  headers: Record<string, string>
  title?: string
  description?: string
  bloq?: number
  expiresDays?: number
  onProgress?: (message: string) => void
  /** injectable for tests */
  fetchImpl?: typeof fetch
  /** injectable for tests: the request body for the PUT */
  body?: BodyInit
}

export type DirectUploadResult = { ok: true; data: any } | { ok: false; error: string }

/**
 * upload-url → PUT → complete (#194118). Never leaves a half-done upload
 * behind on our side: if the PUT fails, it aborts, which deletes whatever
 * arrived and releases the reserved space. (If the process dies mid-PUT, the
 * server's cloud:reap-uploads does the same within a few hours.)
 */
export async function directUpload(o: DirectUploadOptions): Promise<DirectUploadResult> {
  const f = o.fetchImpl ?? fetch
  const json = { ...o.headers, "Content-Type": "application/json" }
  const contentType = guessContentType(o.filename)

  o.onProgress?.("Checking your storage…")
  const start = await f(`${FL_API}/api/v1/cloud-files/upload-url`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      original_filename: o.filename,
      file_size: o.size,
      filetype: contentType,
      title: o.title,
      description: o.description,
      bloq_id: o.bloq,
      expires_days: o.expiresDays,
    }),
  })
  const startBody: any = await start.json().catch(() => ({}))
  if (start.status === 404 || start.status === 405) return { ok: false, error: tooLargeMessage(o.size) }
  if (start.status === 413) return { ok: false, error: refusalMessage(startBody, 413) }
  if (!start.ok || !startBody?.data?.url) {
    return { ok: false, error: `Could not start the upload: ${startBody?.message ?? `HTTP ${start.status}`}` }
  }
  const { upload_id: id, url, headers: signed } = startBody.data

  const abort = () =>
    f(`${FL_API}/api/v1/cloud-files/uploads/${id}/abort`, { method: "POST", headers: json }).catch(() => undefined)

  const began = Date.now()
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - began) / 1000)
    o.onProgress?.(`Uploading ${formatBytes(o.size)} straight to storage… ${secs}s`)
  }, 1000)
  let put: Response
  try {
    put = await f(url, {
      method: "PUT",
      headers: { ...(signed ?? {}), "Content-Type": signed?.["Content-Type"] ?? contentType },
      // Bun.file streams from disk and sets Content-Length (signed URLs need it).
      body: o.body ?? (Bun.file(o.path) as any),
    })
  } catch (e) {
    clearInterval(tick)
    await abort()
    return { ok: false, error: `Upload interrupted: ${e instanceof Error ? e.message : String(e)} — nothing was kept.` }
  }
  clearInterval(tick)
  if (!put.ok) {
    const detail = (await put.text().catch(() => "")).slice(0, 200)
    await abort()
    return { ok: false, error: `Storage refused the file (HTTP ${put.status}) — nothing was kept. ${detail}`.trim() }
  }

  o.onProgress?.("Confirming…")
  const done = await f(`${FL_API}/api/v1/cloud-files/uploads/${id}/complete`, { method: "POST", headers: json })
  const doneBody: any = await done.json().catch(() => ({}))
  if (!done.ok) {
    if (done.status === 413) return { ok: false, error: refusalMessage(doneBody, 413) }
    return { ok: false, error: `Upload could not be confirmed: ${doneBody?.message ?? `HTTP ${done.status}`}` }
  }
  return { ok: true, data: doneBody.data ?? doneBody }
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

    // Every path that uploads nothing ends here: error, "Failed", exit 1 (#194118).
    const fail = (message: string) => {
      prompts.log.error(message)
      prompts.outro("Failed")
      process.exitCode = 1
    }

    if (!args.file && !args.url) {
      fail("Provide a file path or --url")
      return
    }

    if (!(await requireAuth())) { fail("Not signed in — run `iris login`"); return }

    let localPath: string
    let originalFilename: string
    let tempFile: string | null = null

    try {
      if (args.url) {
        const sp = prompts.spinner()
        sp.start(`Downloading from ${args.url}…`)
        const r = await fetch(args.url)
        if (!r.ok) { sp.stop("Failed", 1); fail(`Download failed: HTTP ${r.status}`); return }
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
          fail(`File not found: ${args.file}`)
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

      const direct = fileSize > DIRECT_UPLOAD_THRESHOLD

      let expiration: ResolvedExpiration
      try {
        expiration = resolveExpiration(args.expires, originalFilename)
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e))
        return
      }
      const sp = prompts.spinner()
      sp.start("Uploading…")

      const token = await resolveToken()
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token) headers["Authorization"] = `Bearer ${token}`

      let result: any
      if (direct) {
        // #194118 — large files go straight to storage: the server checks the
        // plan and reserves the space, we PUT to the signed URL, the server
        // measures what arrived and records it.
        const out = await directUpload({
          path: localPath, filename: originalFilename, size: fileSize, headers,
          title: args.title, description: args.description, bloq: args.bloq,
          expiresDays: expiration.permanent ? undefined : expiration.days,
          onProgress: (m) => sp.message(m),
        })
        if (!out.ok) {
          sp.stop("Failed", 1)
          fail(out.error)
          return
        }
        result = out.data
      } else {

      const fileBuffer = readFileSync(localPath)
      const blob = new Blob([new Uint8Array(fileBuffer)])
      const form = new FormData()
      form.append("file", blob, originalFilename)
      form.append("type", "digital_product")
      if (args.title) form.append("title", args.title)
      if (args.description) form.append("description", args.description)
      if (args.bloq) form.append("bloq_id", String(args.bloq))
      if (expiration.days > 0) form.append("expires_days", String(expiration.days))
      // user_id required by cloud-files endpoint. It must be the signed-in account: fl-api
      // refuses any other ("You may only act on your own account"), and a fixed fallback
      // claimed one account for everyone (#193865).
      const userId = await resolveUserId()
      if (!userId) {
        sp.stop("Failed", 1)
        fail("Could not tell which account you are signed in as. Run `iris login` and try again.")
        return
      }
      form.append("user_id", String(userId))

      const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, {
        method: "POST",
        body: form,
        headers,
      })

      if (!res.ok) {
        sp.stop("Failed", 1)
        const text = await res.text().catch(() => "")
        let body: any = text
        try { body = JSON.parse(text) } catch {}
        fail(res.status === 413 ? refusalMessage(body, 413) : `Upload failed: ${String(body?.message ?? text ?? `HTTP ${res.status}`).slice(0, 300)}`)
        return
      }

      const data = (await res.json()) as any
      result = data?.data ?? data
      }

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
      fail(err instanceof Error ? err.message : String(err))
    } finally {
      if (tempFile) {
        try { require("fs").unlinkSync(tempFile) } catch {}
      }
    }
  },
})
