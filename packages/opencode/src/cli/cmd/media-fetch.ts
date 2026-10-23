import * as prompts from "./clack"
import { highlight } from "./iris-api"
import { spawnSync, type SpawnSyncReturns } from "child_process"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

/**
 * The one media downloader every CLI command uses (#190460).
 *
 * `iris download`, `iris transcribe <url>`, `iris copycat audio`, `iris discover playlist` and
 * `iris content ingest-channel` each had their own copy of "find yt-dlp, try cookies, report the
 * error", and each copy had fixes the others lacked: transcribe found yt-dlp off PATH (#187135),
 * installed it without brew (#188318), walked a format ladder (#147267) and self-updated on a
 * YouTube player change (#152290); download warned on a stale build (#178722) and streamed
 * progress (#137384). A bug fixed in one came back in the next. Now there is one locate, one
 * retry ladder and one error report; a command only says what it wants.
 */

export function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout.trim()
  return p && r.status === 0 ? p : null
}

/** True when the user asked for logs — yt-dlp's own progress and errors then go to the terminal. */
export function isVerbose(argv: string[] = process.argv): boolean {
  return (
    argv.includes("--print-logs") ||
    argv.includes("--log-level=DEBUG") ||
    (argv.includes("--log-level") && (argv[argv.indexOf("--log-level") + 1] || "").toUpperCase() === "DEBUG")
  )
}

// ── locate ──────────────────────────────────────────────────────────────────────

/** Days after which a yt-dlp build is considered stale enough to break YouTube. */
const YTDLP_STALE_DAYS = 90

/** Age in days of a date-stamped yt-dlp version ("2026.09.30" or "2026.09.30.123456"), or null. */
export function ytDlpAgeDays(version: string, now: number = Date.now()): number | null {
  const m = version.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/)
  if (!m) return null
  return Math.floor((now - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 86_400_000)
}

/**
 * Warn when yt-dlp is old enough that YouTube extraction silently degrades.
 *
 * Once a build is a few months behind, YouTube's player/n-challenge has rotated past it:
 * unauthenticated it falls back to the legacy muxed 360p format 18, and WITH cookies the JS
 * challenge solver fails outright and returns no video formats at all — while the download
 * still exits 0 (#178722, recurrence of #152290). Warn loudly instead of shipping a degraded file.
 */
export function warnIfYtDlpStale(ytdlp: string): void {
  try {
    const raw = (spawnSync(ytdlp, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout || "").trim()
    const age = ytDlpAgeDays(raw)
    if (age === null || age < YTDLP_STALE_DAYS) return
    prompts.log.warn(
      `yt-dlp ${raw} is ${age} days old — YouTube downloads may silently drop to 360p ` +
        `or return no formats at all.\n  Upgrade:  pip3 install --upgrade yt-dlp   (or: brew upgrade yt-dlp)`,
    )
  } catch {
    // Never let a version probe block a download.
  }
}

/**
 * Where yt-dlp may live when `which` cannot see it. The CLI's PATH can be minimal (#187135: a
 * Homebrew yt-dlp reported "not found" on a Mac that had it), and the standalone build installed
 * on machines with no brew goes to ~/.iris/bin, which is on nobody's PATH.
 */
export const YTDLP_SELF = join(homedir(), ".iris", "bin", "yt-dlp")
export function findYtDlp(exists: (p: string) => boolean = existsSync): string | null {
  const onPath = which("yt-dlp")
  if (onPath) return onPath
  for (const p of [YTDLP_SELF, "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", join(homedir(), ".local", "bin", "yt-dlp")]) {
    if (exists(p)) return p
  }
  return null
}

/** The official standalone release asset for this machine — no Python, no package manager. */
export function ytDlpAsset(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "darwin") return "yt-dlp_macos"
  if (platform === "linux") return arch === "arm64" ? "yt-dlp_linux_aarch64" : arch === "x64" ? "yt-dlp_linux" : null
  if (platform === "win32") return "yt-dlp.exe"
  return null
}

/**
 * #188318 row 5: the only install path was `brew install yt-dlp`, so a Linux Hive node with no
 * brew could not download anything — it printed "Install: brew install yt-dlp" on a machine where
 * that command does not exist. Fall back to the project's own release binary.
 */
async function installYtDlpStandalone(): Promise<string | null> {
  const asset = ytDlpAsset()
  if (!asset) return null
  try {
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { redirect: "follow" })
    if (!res.ok) return null
    mkdirSync(dirname(YTDLP_SELF), { recursive: true })
    writeFileSync(YTDLP_SELF, Buffer.from(await res.arrayBuffer()), { mode: 0o755 })
    return spawnSync(YTDLP_SELF, ["--version"], { stdio: "pipe", timeout: 30_000 }).status === 0 ? YTDLP_SELF : null
  } catch {
    return null
  }
}

/**
 * Find yt-dlp, installing it if needed: brew, then pip, then the standalone release. Prints one
 * clear line and returns null when nothing works.
 */
export async function locateYtDlp(): Promise<string | null> {
  let ytdlp = findYtDlp()
  if (ytdlp) {
    warnIfYtDlpStale(ytdlp)
    return ytdlp
  }
  prompts.log.info("Installing yt-dlp…")
  if (which("brew")) spawnSync("brew", ["install", "yt-dlp"], { stdio: "pipe", timeout: 120_000 })
  ytdlp = findYtDlp()
  if (!ytdlp && which("pip3")) {
    spawnSync("pip3", ["install", "--user", "yt-dlp"], { stdio: "pipe", timeout: 60_000 })
    ytdlp = findYtDlp()
  }
  if (!ytdlp) ytdlp = await installYtDlpStandalone()
  if (!ytdlp) {
    prompts.log.error(
      `yt-dlp not found and could not be installed. Get it from https://github.com/yt-dlp/yt-dlp/releases and put it on your PATH or at ${YTDLP_SELF}`,
    )
  }
  return ytdlp
}

// ── fetch ───────────────────────────────────────────────────────────────────────

/** A failure that almost always means yt-dlp is too old for YouTube's current player (#152290). */
export function isStaleSignatureError(err: string): boolean {
  return /format is not available|requested format|nsig|only images|player|signature|ssap/i.test(err)
}

export const COOKIE_BROWSERS = ["chrome", "firefox", "safari"] as const

export interface FetchOptions {
  /** Format selectors tried in order; `null` lets yt-dlp pick its own default. Default `[null]`. */
  formats?: (string | null)[]
  /** Arguments every attempt carries (output template, -x, --no-playlist, …). */
  args: string[]
  /** The file a successful run must leave behind. Without it, success = exit 0 with output on stdout. */
  expect?: string
  /** "auto" tries each browser's cookies, then none (Instagram and age-gated videos need them). */
  cookies?: "auto" | "none"
  /** Per attempt. */
  timeoutMs?: number
  /** On a player/signature failure, update yt-dlp once and run the whole ladder again. Default true. */
  selfUpdate?: boolean
  /** Stream yt-dlp's output to the terminal. Default: when the user asked for logs. */
  verbose?: boolean
  /** Injected in tests. */
  run?: (bin: string, args: string[], opts: { stdio: any; timeout: number }) => SpawnSyncReturns<string>
  exists?: (p: string) => boolean
}

export interface Attempt {
  format: string | null
  cookies: string | null
  status: number | null
  error?: string
}

export interface FetchResult {
  ok: boolean
  /** `expect`, when the run produced it. */
  path?: string
  /** stdout of the successful run (for --print / --dump-json), or of the last failed one. */
  stdout?: string
  /** The last line worth showing a person. */
  error?: string
  /** The full stderr of the last failure — nsig/SSAP diagnostics live past the last line (#152290). */
  stderr?: string
  timedOut?: boolean
  updated?: boolean
  attempts: Attempt[]
}

/**
 * Run yt-dlp against one target (a URL or a `ytsearch1:` term) through the ladder:
 * every format × every cookie source, then — if the failure looks like a stale player — one
 * self-update and the ladder again. Returns the REAL cause on failure, never a guess.
 */
export function fetchWithYtDlp(ytdlp: string, target: string, o: FetchOptions): FetchResult {
  const run = o.run ?? ((bin, args, opts) => spawnSync(bin, args, { ...opts, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))
  const exists = o.exists ?? existsSync
  const verbose = o.verbose ?? isVerbose()
  const stdio: any = verbose ? ["ignore", "inherit", "inherit"] : "pipe"
  const timeout = o.timeoutMs ?? 300_000
  const formats = o.formats?.length ? o.formats : [null]
  const cookieSources: (string | null)[] = o.cookies === "none" ? [null] : [...COOKIE_BROWSERS, null]
  const attempts: Attempt[] = []
  let last: SpawnSyncReturns<string> | null = null

  const ladder = (): FetchResult | null => {
    for (const format of formats) {
      for (const browser of cookieSources) {
        const args = [
          ...(format ? ["-f", format] : []),
          ...o.args,
          ...(browser ? ["--cookies-from-browser", browser] : []),
          target,
        ]
        const r = run(ytdlp, args, { stdio, timeout })
        last = r
        const stdout = typeof r.stdout === "string" ? r.stdout : ""
        const done = r.status === 0 && (o.expect ? exists(o.expect) : stdout.trim().length > 0)
        attempts.push({ format, cookies: browser, status: r.status, error: done ? undefined : lastLine(r) })
        if (done) return { ok: true, path: o.expect, stdout, attempts }
      }
    }
    return null
  }

  const first = ladder()
  if (first) return first

  let updated = false
  const stderrOf = () => (typeof last?.stderr === "string" ? last.stderr.trim() : "")
  // A run that printed results got past the player; its errors are about single items.
  const lastRun = last as SpawnSyncReturns<string> | null
  const gotOutput = typeof lastRun?.stdout === "string" && lastRun.stdout.trim().length > 0
  if ((o.selfUpdate ?? true) && !gotOutput && isStaleSignatureError(stderrOf())) {
    prompts.log.info(`yt-dlp couldn't solve YouTube's player (likely stale) — updating (${highlight("yt-dlp -U")})…`)
    run(ytdlp, ["-U"], { stdio: "pipe", timeout: 120_000 })
    if (which("brew")) run("brew", ["upgrade", "yt-dlp"], { stdio: "pipe", timeout: 120_000 }) // -U no-ops on brew installs
    updated = true
    const second = ladder()
    if (second) return { ...second, updated }
  }

  // On timeout spawnSync sets .error(ETIMEDOUT)/SIGTERM; otherwise yt-dlp's stderr holds the
  // true error. A partial .part may remain — name it so nothing mistakes it for a finished file.
  const l = last as SpawnSyncReturns<string> | null
  const timedOut = (l?.error as any)?.code === "ETIMEDOUT" || l?.signal === "SIGTERM"
  const stderr = stderrOf()
  const partial = o.expect && exists(o.expect + ".part") ? o.expect + ".part" : null
  let error: string
  if (timedOut) error = `yt-dlp timed out after ${Math.round(timeout / 1000)}s${partial ? ` (incomplete ${partial} left in place)` : ""}`
  else if (stderr) error = stderr.split("\n").filter(Boolean).pop() || stderr
  else if (verbose) error = "yt-dlp failed (see output above)"
  else error = l?.error?.message || "yt-dlp failed — re-run with --print-logs to see why"
  // stdout survives a failure: --ignore-errors runs exit 1 with every line they did get.
  const stdout = typeof l?.stdout === "string" ? l.stdout : ""
  return { ok: false, stdout, error, stderr, timedOut, updated, attempts }
}

function lastLine(r: SpawnSyncReturns<string>): string {
  const s = (typeof r.stderr === "string" && r.stderr.trim()) || (typeof r.stdout === "string" && r.stdout.trim()) || r.error?.message || ""
  return s.split("\n").filter(Boolean).pop() || ""
}

// ── direct files ────────────────────────────────────────────────────────────────

const DIRECT_MEDIA = /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|mov|webm)$/i

/** A plain file link (our CDN, a SoundCloud/Bandcamp download) — fetched over HTTP, no yt-dlp. */
export function isDirectMediaUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === "https:" || u.protocol === "http:") && DIRECT_MEDIA.test(decodeURIComponent(u.pathname))
  } catch {
    return false
  }
}

/** Download a plain file link to `outPath`. Refuses an HTML page served under a media name. */
export async function fetchDirect(url: string, outPath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const res = await fetch(url, { redirect: "follow" })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${new URL(url).host}` }
    const type = res.headers.get("content-type") || ""
    if (/text\/html/i.test(type)) return { ok: false, error: `${new URL(url).host} answered with a web page, not a media file` }
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, Buffer.from(await res.arrayBuffer()))
    return { ok: true, path: outPath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
