import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  IRIS_API,
  requireAuth,
  requireUserId,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { transcribeLocal } from "../lib/transcription"
import { treatTranscript, listTreatments } from "../lib/walkthrough"
import { homedir, tmpdir } from "os"
import { join, basename, extname, resolve } from "path"

const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout.trim()
  return p && r.status === 0 ? p : null
}


/**
 * The account's own transcription vocabulary, resolved server-side.
 *
 * On-device whisper is the default for local files, and it was the one path that could never
 * use the tenant's vocabulary — whisper.cpp cannot look up a brand. It does take `--prompt`,
 * so we fetch the resolved string and pass it locally. Only the vocabulary crosses the wire;
 * the audio never leaves the machine, which is the whole point of the local default.
 *
 * Never throws and never blocks: no auth, no network, no glossary set — all of them mean
 * "transcribe unhinted", which is the correct degradation. A missing hint costs accuracy; a
 * failed transcription costs the recording.
 */
async function fetchGlossary(brandId?: number): Promise<string | undefined> {
  try {
    const qs = brandId ? `?brand_id=${brandId}` : ""
    const res = await irisFetch(`/api/v1/transcribe/glossary${qs}`, {}, IRIS_API)
    if (!res.ok) return undefined
    const body = (await res.json()) as any
    const g = body?.data?.glossary
    return typeof g === "string" && g.trim() ? g : undefined
  } catch {
    return undefined
  }
}

/**
 * Server-side transcription — the fallback when local whisper cannot run.
 *
 * POSTs the audio to iris-api, which transcribes with **gpt-transcribe** ($0.0045/min, and the
 * model OpenAI rates highest for accuracy). Deliberately server-side rather than calling OpenAI
 * from here: the API key stays on the server, the model choice stays in one place, and the call
 * is metered with everything else.
 *
 * Returns null when the fallback is unavailable too, so the caller can fail loudly rather than
 * proceed on an empty transcript.
 */
async function transcribeViaServer(absPath: string, language?: string, brandId?: number): Promise<string | null> {
  const sp = prompts.spinner()
  sp.start("Transcribing on the server (gpt-transcribe)…")

  // The endpoint caps uploads at 25MB. Saying so beats a 413 the user has to decode, and the
  // remedy (install whisper-cpp, which has no size limit) is genuinely the right answer here.
  const SERVER_MAX_MB = 25
  try {
    const sizeMb = statSync(absPath).size / 1024 / 1024
    if (sizeMb > SERVER_MAX_MB) {
      sp.stop("Too large for the server", 1)
      prompts.log.error(
        `${sizeMb.toFixed(1)}MB exceeds the ${SERVER_MAX_MB}MB server limit.\n` +
          `For files this size install local transcription: brew install whisper-cpp`,
      )
      return null
    }
  } catch {
    // Unreadable size is not itself fatal — let the upload attempt report the real problem.
  }

  try {
    const form = new FormData()
    // Buffer -> Uint8Array: Node's Buffer is not a BlobPart under this tsconfig.
    const bytes = new Uint8Array(readFileSync(absPath))
    form.append("file", new Blob([bytes]), basename(absPath))
    if (language) form.append("language", language)
    // Which brand's vocabulary, for an account managing several. The server filters it by
    // owner, so this cannot reach another tenant's glossary.
    if (brandId) form.append("brand_id", String(brandId))
    // 'whisper' is the server's name for the OpenAI leg — Supadata only handles URLs, and this
    // path is always a local file.
    form.append("provider", "whisper")

    const res = await irisFetch("/api/v1/transcribe", { method: "POST", body: form }, IRIS_API)
    if (!res.ok) {
      sp.stop("Failed", 1)
      prompts.log.error(`Server transcription failed (HTTP ${res.status}). ${await res.text().catch(() => "")}`.slice(0, 300))
      return null
    }

    const body = (await res.json()) as any
    const text = body?.data?.text ?? body?.text ?? ""
    if (!text.trim()) {
      // An empty transcript from a successful call is the silent-failure shape: it looks like
      // "this audio had no speech" and is usually "the provider returned nothing".
      sp.stop("Empty transcript", 1)
      prompts.log.error("The server returned no text. Nothing was written.")
      return null
    }

    sp.stop(`${success("✓")} Transcribed on the server ${dim("(gpt-transcribe)")}`)
    return text
  } catch (err) {
    sp.stop("Failed", 1)
    prompts.log.error(err instanceof Error ? err.message : String(err))
    return null
  }
}

async function runLocalWhisper(
  filePath: string,
  language: string | undefined,
  asJson: boolean,
  sourceUrl?: string,
  output?: string,
  brandId?: number,
  forceRemote?: boolean,
  treatment?: string,
): Promise<boolean> {
  const abs = resolve(filePath)
  let provider = "whisper.cpp (local)"

  // --remote skips the device entirely. Handled here rather than in a parallel branch so the
  // save location, JSON shape, and knowledge-base sync stay in ONE place — a second copy of
  // the persistence logic is a second thing to forget to update.
  if (forceRemote) {
    const remote = await transcribeViaServer(abs, language, brandId)
    if (remote === null) {
      process.exitCode = 1
      return false
    }
    return finishTranscript(abs, remote, "gpt-transcribe (server)", asJson, sourceUrl, output, filePath, treatment)
  }

  // Fetched BEFORE the spinner starts so a slow lookup does not look like slow transcription.
  // Undefined here just means unhinted — see fetchGlossary.
  const glossary = await fetchGlossary(brandId)

  const sp = prompts.spinner()
  sp.start(glossary ? "Transcribing locally (whisper.cpp, brand vocabulary)…" : "Transcribing locally (whisper.cpp)…")
  let text: string
  try {
    text = await transcribeLocal(abs, { language, prompt: glossary })
  } catch (e) {
    // Local whisper is optional infrastructure: it needs `brew install whisper-cpp` and a
    // 148MB model download. Before this, a machine without it got "install whisper-cpp" and
    // an exit 1 — on a product whose whole pitch is "talk through it once and it becomes the
    // procedure". The first thing a new user does is the thing that did not work.
    //
    // So fall through to the server, which transcribes with gpt-transcribe. The API key stays
    // server-side; the client only uploads audio.
    const localError = e instanceof Error ? e.message : String(e)
    sp.stop(dim("Local transcription unavailable"))
    prompts.log.info(dim(localError))

    const remote = await transcribeViaServer(abs, language, brandId)
    if (remote === null) {
      process.exitCode = 1 // #152292 — fail loudly so automation doesn't proceed on no transcript
      return false
    }
    text = remote
    provider = "gpt-transcribe (server)"
  }
  if (!text || !text.trim()) {
    sp.stop("Failed", 1)
    prompts.log.error("Transcription produced no text.")
    process.exitCode = 1 // #152292 — empty result is a failure
    return false
  }
  sp.stop("Done")

  return finishTranscript(abs, text, provider, asJson, sourceUrl, output, filePath, treatment)
}

/**
 * Persist, sync, and print a finished transcript. Shared by every route into the command so
 * "where did it save" has one answer regardless of which engine produced the text.
 */
async function finishTranscript(
  abs: string,
  text: string,
  provider: string,
  asJson: boolean,
  sourceUrl: string | undefined,
  output: string | undefined,
  filePath: string,
  treatment?: string,
): Promise<boolean> {
  // A treatment rewrites what somebody said. If one ran, BOTH files are written — the treated
  // transcript where the reader expects it, and the untouched original next to it. A rewrite
  // you cannot compare against the original is one you cannot audit, and this path handles
  // clinical dictation.
  const treated = await treatTranscript(text, treatment ?? "raw")
  const rawText = text
  text = treated.text
  // Output location (#152293): default to ~/.iris/transcripts — NOT the CWD (it littered
  // git repos). Honor --output (dir or file). Skip the file entirely for --json with no
  // explicit --output, since the JSON already carries the text.
  const name = `${basename(abs, extname(abs))}-transcript.txt`
  let txtPath: string | null
  if (output) {
    txtPath = existsSync(output) && statSync(output).isDirectory() ? join(output, name) : output
  } else if (asJson) {
    txtPath = null
  } else {
    const dir = join(homedir(), ".iris", "transcripts")
    mkdirSync(dir, { recursive: true })
    txtPath = join(dir, name)
  }
  if (txtPath) writeFileSync(txtPath, text)
  if (txtPath && treated.changed) {
    writeFileSync(txtPath.replace(/(\.[^.]+)?$/, ".raw$1"), rawText)
  }

  // Best-effort server sync so it's searchable in the knowledge base.
  const estimatedDuration = Math.round((text.split(/\s+/).length / 150) * 60)
  const syncUrl = sourceUrl ?? (/^https?:\/\//i.test(filePath) ? filePath : undefined)
  try {
    if (syncUrl && text) {
      await irisFetch("/api/v1/transcripts", {
        method: "POST",
        body: JSON.stringify({
          url: syncUrl,
          text,
          // The real engine, not a hardcoded "local" — the knowledge base was recording every
          // transcript as whisper.cpp even when the server produced it, which quietly made the
          // provenance wrong for exactly the transcripts most likely to be re-checked.
          provider,
          duration_seconds: estimatedDuration,
        }),
      })
    }
  } catch {
    // Silent — server sync is best-effort
  }

  if (asJson) {
    console.log(JSON.stringify({ provider, file: abs, transcript_path: txtPath, text }, null, 2))
    return true
  }

  printDivider()
  if (txtPath) console.log(`  ${bold("Saved:")}  ${highlight(txtPath)}`)
  printDivider()
  console.log()
  console.log(text)
  console.log()
  return true
}

// ============================================================================
// Smart URL detection
// ============================================================================

function isSocialMediaUrl(url: string): boolean {
  return /instagram\.com|tiktok\.com|twitter\.com|x\.com|threads\.net|facebook\.com/i.test(url)
}

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com|youtu\.be/i.test(url)
}

function ensureDep(name: string, installCmd: string): string | null {
  const bin = which(name)
  if (bin) return bin
  // Try to auto-install
  const sp2 = spawnSync("brew", ["install", name], { stdio: "pipe", timeout: 120_000 })
  if (sp2.status === 0) return which(name)
  return null
}

// ============================================================================
// Local video download via yt-dlp (runs on user's machine, uses their cookies)
// ============================================================================

async function downloadVideoLocally(url: string): Promise<string | null> {
  let ytdlp = which("yt-dlp")
  if (!ytdlp) {
    prompts.log.info("Installing yt-dlp…")
    const install = spawnSync("brew", ["install", "yt-dlp"], { stdio: "pipe", timeout: 120_000 })
    if (install.status !== 0) {
      // Try pip fallback
      spawnSync("pip3", ["install", "--user", "yt-dlp"], { stdio: "pipe", timeout: 60_000 })
    }
    ytdlp = which("yt-dlp")
    if (!ytdlp) {
      prompts.log.error("yt-dlp not found. Install: brew install yt-dlp")
      return null
    }
  }

  const outPath = join(tmpdir(), `iris-dl-${Date.now()}.mp4`)

  // Format ladder — try most-specific (small m4a audio) first, then progressively
  // looser selectors, ending with NO -f so yt-dlp picks its own default. A single
  // hardcoded selector was the cause of "Requested format is not available"
  // (#147267) when YouTube didn't offer that exact format. Each entry is tried
  // both with browser cookies and without.
  const formatLadder = [
    "bestaudio[ext=m4a]/bestaudio/best",
    "bestaudio/best",
    "worstaudio/worst",
    null, // let yt-dlp choose its default format
  ]
  // Keep --no-warnings OFF so nsig/SSAP/"Only images" diagnostics reach stderr (#152290).
  const commonArgs = ["--no-playlist", "-o", outPath]

  const tryLadder = (): { path?: string; err: string } => {
    let lastErr = "Download failed"
    for (const fmt of formatLadder) {
      const fmtArgs = fmt ? ["-f", fmt] : []
      // Cookies first (Instagram/age-gated need them), then a cookieless attempt.
      for (const browser of ["chrome", "firefox", "safari", null]) {
        const cookieArgs = browser ? ["--cookies-from-browser", browser] : []
        const dl = spawnSync(ytdlp!, [...fmtArgs, ...commonArgs, ...cookieArgs, url], {
          encoding: "utf8",
          timeout: 60_000,
        })
        if (dl.status === 0 && existsSync(outPath)) return { path: outPath, err: "" }
        const out = (dl.stderr || dl.stdout || "").trim()
        if (out) lastErr = out // keep the FULL stderr, not just the last line (#152290)
      }
    }
    return { err: lastErr }
  }

  const isStaleSignatureError = (err: string) =>
    /format is not available|requested format|nsig|only images|player|signature|ssap/i.test(err)

  let res = tryLadder()
  if (res.path) return res.path

  // #152290 — a format/nsig failure is almost always a STALE yt-dlp that can't solve
  // YouTube's current player signature. Self-update once and retry, rather than misleading
  // the user with a bare "Requested format is not available".
  if (isStaleSignatureError(res.err)) {
    prompts.log.info(`yt-dlp couldn't solve YouTube's player (likely stale) — updating (${highlight("yt-dlp -U")})…`)
    spawnSync(ytdlp, ["-U"], { stdio: "pipe", timeout: 120_000 })
    spawnSync("brew", ["upgrade", "yt-dlp"], { stdio: "pipe", timeout: 120_000 }) // -U no-ops on brew installs
    res = tryLadder()
    if (res.path) return res.path
  }

  // Everything failed — surface the REAL yt-dlp error (full stderr incl. nsig/SSAP/"Only
  // images"), not a swallowed generic line.
  prompts.log.error(res.err)
  if (isStaleSignatureError(res.err)) {
    prompts.log.info(`yt-dlp may still be stale — ${highlight("brew upgrade yt-dlp")} or ${highlight("pip3 install -U yt-dlp")}`)
  }
  return null
}

// Server-side transcription via the SAME path that `iris tools invoke
// transcribevideo` uses and that the bug report (#147267) proved works:
//   POST /api/v1/tools/invoke  on IRIS_API (freelabel.net)  { tool, params }
//
// The old code POSTed to `/api/v1/v6/tools/execute` WITHOUT the IRIS_API host
// arg → irisFetch defaulted to FL_API (raichu.heyiris.io), where that route is
// dead → "Server unavailable" on every YouTube transcribe while the underlying
// tool was fine. Tool name is lowercase `transcribevideo` to match the registry.
async function invokeTranscribeTool(url: string, userId?: number): Promise<{ ok: boolean; data?: any }> {
  try {
    // user_id is REQUIRED for V6 tool execution — without it the tool errors
    // "user_id required" and the CLI silently fell to local whisper on every call,
    // so the (working) Supadata cloud path was never actually reached (#152291).
    const params: Record<string, any> = { url }
    if (userId) params.user_id = userId
    const res = await irisFetch(
      `/api/v1/tools/invoke`,
      { method: "POST", body: JSON.stringify({ tool: "transcribevideo", params, user_id: userId }) },
      IRIS_API,
    )
    if (!res.ok) return { ok: false }
    const result = (await res.json()) as any
    const data = result?.data ?? result
    if (result?.status?.includes?.("error") || data?.error || !data?.text) return { ok: false }
    return { ok: true, data }
  } catch {
    return { ok: false }
  }
}

/**
 * `iris transcribe <url>` — smart transcription.
 *
 * Routing:
 * - Local file → whisper.cpp (offline)
 * - Instagram/TikTok/X/Threads → download locally with yt-dlp (uses browser cookies) → whisper.cpp
 * - YouTube → server-side Supadata (fast, cached) with local fallback
 * - --local flag → always local pipeline
 */
export const PlatformTranscribeCommand = cmd({
  command: "transcribe [url]",
  describe: "transcribe a video/audio from a URL or local file",
  builder: (y) =>
    y
      .positional("url", {
        type: "string",
        // Optional so `--list-treatments` can answer "what can I do with a recording" without
        // needing one. Missing-and-not-listing is caught in the handler with a real message.
        describe: "Video/audio URL or local file path",
      })
      .option("language", {
        type: "string",
        describe: "ISO 639-1 language hint for Whisper (e.g. 'en')",
      })
      .option("local", {
        type: "boolean",
        default: false,
        describe: "Force local offline transcription via whisper.cpp",
      })
      .option("remote", {
        type: "boolean",
        default: false,
        describe: "Transcribe on the server (gpt-transcribe) instead of on-device",
      })
      .option("brand", {
        type: "number",
        describe: "Brand id whose vocabulary to bias toward (for accounts managing several)",
      })
      .option("treatment", {
        type: "string",
        describe: "What this recording IS: clean, notes, meeting, standup, captions, idea (default: raw)",
      })
      .option("list-treatments", {
        type: "boolean",
        default: false,
        describe: "Show the treatments available to you, including your brand's own",
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Write the transcript here (file or dir). Default: ~/.iris/transcripts",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Transcribe")

    // Answer "what can I do with a recording" without needing one.
    if (args["list-treatments"]) {
      const list = await listTreatments()
      if (!list.length) {
        prompts.log.error("Could not reach the treatments list. Check `iris login`.")
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const t of list) {
        const tag = t.custom ? dim(" (yours)") : ""
        console.log(`  ${bold(t.id.padEnd(10))} ${t.description}${tag}`)
      }
      printDivider()
      console.log()
      console.log(`  ${dim("$")} iris transcribe recording.m4a --treatment meeting`)
      console.log()
      prompts.outro("Done")
      return
    }

    if (!args.url) {
      prompts.log.error("Nothing to transcribe. Pass a file or URL, or use --list-treatments.")
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const url = String(args.url)
    const looksLikeFile =
      args.local || (!/^https?:\/\//i.test(url) && existsSync(resolve(url)))

    // ── Local file ──────────────────────────────────────────────
    if (looksLikeFile) {
      // --remote sends the audio to the server's gpt-transcribe instead of running on-device.
      // Worth having explicitly: until now the ONLY way to reach that engine was for local
      // whisper to fail, and a capability you can only get by breaking something is one nobody
      // uses. On-device stays the default — audio not leaving the machine is the right posture
      // for a product that transcribes clinical walkthroughs.
      await runLocalWhisper(
        url,
        args.language as string | undefined,
        !!args.json,
        undefined,
        args.output as string | undefined,
        args.brand ? Number(args.brand) : undefined,
        !!args.remote,
        args.treatment as string | undefined,
      )
      prompts.outro("Done")
      return
    }

    // ── Social media (Instagram, TikTok, X, Threads, Facebook) ─
    // Download locally with yt-dlp (uses browser cookies), then whisper locally.
    // No server auth needed. No round trips. Just works.
    if (isSocialMediaUrl(url) || args.local) {
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading video…")

      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) {
        dlSpinner.stop("Download failed", 1)
        process.exitCode = 1 // #152292
        prompts.outro("Done")
        return
      }
      dlSpinner.stop("Downloaded")

      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined)

      // Cleanup temp file
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    // ── YouTube → try server first (Supadata is fast), fall back to local ─
    if (isYouTubeUrl(url)) {
      const token = await requireAuth()
      if (token) {
        const userId = (await requireUserId(undefined)) ?? undefined
        const spinner = prompts.spinner()
        spinner.start("Transcribing on server…")
        const tool = await invokeTranscribeTool(url, userId)
        if (tool.ok) {
          const data = tool.data
          spinner.stop("Done")

          if (args.json) {
            console.log(JSON.stringify(data, null, 2))
            prompts.outro("Done")
            return
          }

          const text = data?.text ?? ""
          const provider = data?.provider ?? "?"
          const wordCount = data?.word_count ?? 0
          const duration = data?.duration_seconds ?? 0
          const cached = data?.cached ? success("(cached)") : dim("(fresh)")
          const transcriptUrl = data?.transcript_url

          printDivider()
          console.log(`  ${bold("Provider:")}  ${highlight(provider)} ${cached}`)
          console.log(`  ${bold("Words:")}     ${wordCount}`)
          console.log(`  ${bold("Duration:")}  ~${duration}s`)
          if (transcriptUrl) {
            console.log(`  ${bold("CDN:")}       ${highlight(transcriptUrl)}`)
          }
          printDivider()
          console.log()
          console.log(text)
          console.log()
          prompts.outro("Done")
          return
        }
        spinner.stop("Server path unavailable — falling back to local", 1)
      }

      // YouTube server failed → download locally + whisper
      prompts.log.info("Downloading YouTube audio locally…")
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) {
        dlSpinner.stop("Download failed", 1)
        process.exitCode = 1 // #152292
        prompts.outro("Done")
        return
      }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    // ── Other URLs → try server, fall back to local download ───
    const token = await requireAuth()
    if (!token) {
      // No auth — try local anyway
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) { dlSpinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const userId = (await requireUserId(undefined)) ?? undefined
    const spinner = prompts.spinner()
    spinner.start("Transcribing on server…")

    const tool = await invokeTranscribeTool(url, userId)
    if (!tool.ok) {
      spinner.stop("Server path unavailable — trying local", 1)
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) { dlSpinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const data = tool.data
    spinner.stop("Done")

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    const text = data?.text ?? ""
    const provider = data?.provider ?? "?"
    const wordCount = data?.word_count ?? 0
    const duration = data?.duration_seconds ?? 0
    printDivider()
    console.log(`  ${bold("Provider:")}  ${highlight(provider)}`)
    console.log(`  ${bold("Words:")}     ${wordCount}`)
    console.log(`  ${bold("Duration:")}  ~${duration}s`)
    printDivider()
    console.log()
    console.log(text)
    console.log()
    prompts.outro("Done")
  },
})
