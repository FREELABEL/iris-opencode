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
  highlight, writeJson } from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { transcribeLocal, resolveFfmpeg } from "../lib/transcription"
import { resolveSttPolicy } from "../lib/stt-policy"
import { treatTranscript, listTreatments, structureWalkthrough } from "../lib/walkthrough"
import {
  serverTranscriptVerdict,
  transcriptFileName,
  treatmentWarning,
  isStructuredTreatment,
} from "../lib/transcribe-outcome"
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
/**
 * Which local dependency is actually missing — checked, not assumed.
 *
 * The old text always said "brew install whisper-cpp". On the machine that prompted this,
 * whisper was installed and working; ffmpeg was present on PATH and could not load one of its
 * libraries. So the advice pointed at the one thing that was fine.
 */
function localDepAdvice(): string | null {
  const whisper = which("whisper-cli") || which("whisper-cpp")
  const ff = resolveFfmpeg()
  if (!whisper && !ff.bin) return `Install local transcription:  brew install whisper-cpp ffmpeg`
  if (!whisper) return `Install local transcription:  brew install whisper-cpp`
  if (!ff.bin) return ff.diagnosis || "ffmpeg is unavailable"
  // Both present and working — whatever failed was not a missing dependency, and claiming
  // otherwise would send someone to reinstall tools that are fine.
  return null
}

async function transcribeViaServer(
  absPath: string,
  language?: string,
  brandId?: number,
  /** The local failure was already explained to the user — do not say it twice. */
  localAlreadyExplained = false,
): Promise<string | null> {
  // POLICY GATE (epic #182784). This function uploads the audio via irisFetch directly,
  // so it does NOT pass through transcribeAudio()'s clamp — it was a second egress the
  // clamp could not see. Worse, it is reached AUTOMATICALLY when local whisper is merely
  // missing, so the machine least able to transcribe locally is the one that silently
  // uploads. Refuse before reading the file, not after.
  if (resolveSttPolicy() === "sovereign") {
    // Name the dependency that is ACTUALLY missing. Telling someone to install whisper when
    // whisper is installed and ffmpeg is the broken one sends them to the wrong place — which
    // is what happened: three messages in a row, all true, none of them the problem.
    // Only diagnose here when nothing upstream already did. Reached from --remote the user
    // has seen no local error at all and needs telling; reached from the local fallback the
    // diagnosis is already on screen, and repeating the same paragraph reads as a second,
    // different problem.
    const missing = localAlreadyExplained ? null : localDepAdvice()
    prompts.log.error(
      "Transcription policy is 'sovereign' — audio was NOT uploaded.\n" +
        (missing ? `  ${missing}\n` : "") +
        "  Or allow the server for this run:  IRIS_TRANSCRIPTION_POLICY=standard",
    )
    return null
  }

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

/**
 * Exported for `iris listen`, which records the audio this then transcribes. Sharing the
 * function rather than the logic keeps the device default, the brand glossary, treatments,
 * the save location and the knowledge-base sync in one place.
 */
export async function runLocalWhisper(
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

    const remote = await transcribeViaServer(abs, language, brandId, true)
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
  const rawText = text
  let treatedChanged = false

  // #183798 — someone reaches for --local precisely when the recording is sensitive, and the
  // most natural pairing on the whole command is --local --treatment meeting. The audio does
  // stay on the machine; the TEXT does not. Saying so at the moment it happens is the minimum;
  // whether --local should refuse, or run treatments on-device, is a product decision.
  if (treatment && treatment !== "raw" && !asJson) {
    prompts.log.info(dim(`Sending the transcript text to the server for the '${treatment}' treatment. The audio stays on this machine.`))
  }

  if (isStructuredTreatment(treatment)) {
    // sop and playbook are produced by /walkthrough/structure, not /walkthrough/treat. Sending
    // them to /treat is what made them 422 and silently fall back to the raw transcript
    // (#183796) — the treatment was never unsupported, just routed to the wrong endpoint.
    try {
      const structured = await structureWalkthrough(text, treatment as "sop" | "playbook")
      text = structured.markdown
      treatedChanged = true
    } catch (e) {
      // structureWalkthrough throws with the server's own message, which distinguishes "your
      // input is unusable" from "we could not produce a document". Pass it through rather than
      // losing the recording — but SAY so, which is the half that was missing.
      if (!asJson) prompts.log.warn(e instanceof Error ? e.message : String(e))
    }
  } else {
    const treated = await treatTranscript(text, treatment ?? "raw")
    text = treated.text
    treatedChanged = treated.changed
  }
  // treatTranscript returns the ORIGINAL on any failure, which is the right trade — losing a
  // recording because a tidy-up pass failed would be far worse. But an unannounced fallback is
  // indistinguishable from "your recording was already tidy" (#183796), and the reader then acts
  // on a document that is not the one they asked for.
  const treatNote = treatmentWarning(treatment, treatedChanged)
  if (treatNote && !asJson) prompts.log.warn(treatNote)
  // Output location (#152293): default to ~/.iris/transcripts — NOT the CWD (it littered
  // git repos). Honor --output (dir or file). Skip the file entirely for --json with no
  // explicit --output, since the JSON already carries the text.
  // A URL has no basename to take a name from, which is how --output came to be dropped
  // entirely on the server paths (#183797). transcriptFileName handles both, and guarantees the
  // result cannot escape the directory it is about to be joined onto.
  const name = sourceUrl ? transcriptFileName(sourceUrl) : `${basename(abs, extname(abs))}-transcript.txt`
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
  if (txtPath && treatedChanged) {
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
    await writeJson({ provider, file: abs, transcript_path: txtPath, text })
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
        describe: "Transcribe the AUDIO on-device via whisper.cpp. Note this does not make the whole run offline — a --treatment still sends the resulting text to the server",
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

      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined, args.brand ? Number(args.brand) : undefined, false, args.treatment as string | undefined)

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
        // `ok` is the transport's verdict, not the content's. A 200 carrying an empty transcript
        // used to read as success here: it printed nothing, ignored --output, and exited 0
        // (#183797). Falling through to the local download is the useful answer, not an error.
        const verdict = serverTranscriptVerdict(tool)
        if (verdict.kind === "finish") {
          const data = tool.data
          spinner.stop("Done")

          const provider = data?.provider ?? "?"
          const wordCount = data?.word_count ?? 0
          const duration = data?.duration_seconds ?? 0
          const cached = data?.cached ? success("(cached)") : dim("(fresh)")
          const transcriptUrl = data?.transcript_url

          if (!args.json) {
            printDivider()
            console.log(`  ${bold("Provider:")}  ${highlight(provider)} ${cached}`)
            console.log(`  ${bold("Words:")}     ${wordCount}`)
            console.log(`  ${bold("Duration:")}  ~${duration}s`)
            if (transcriptUrl) {
              console.log(`  ${bold("CDN:")}       ${highlight(transcriptUrl)}`)
            }
          }

          // Through the SAME finisher as every other route, so --output, --treatment, the raw
          // sidecar and the knowledge-base sync do not depend on which engine produced the text.
          await finishTranscript(
            url,
            verdict.text,
            String(provider),
            !!args.json,
            url,
            args.output as string | undefined,
            url,
            args.treatment as string | undefined,
          )
          prompts.outro("Done")
          return
        }
        spinner.stop(`Server path unavailable — ${verdict.reason}. Falling back to local`, 1)
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
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined, args.brand ? Number(args.brand) : undefined, false, args.treatment as string | undefined)
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
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined, args.brand ? Number(args.brand) : undefined, false, args.treatment as string | undefined)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const userId = (await requireUserId(undefined)) ?? undefined
    const spinner = prompts.spinner()
    spinner.start("Transcribing on server…")

    const tool = await invokeTranscribeTool(url, userId)
    // Same trap as the YouTube path: a 200 with no text is not a transcript (#183797).
    const verdict = serverTranscriptVerdict(tool)
    if (verdict.kind === "fallback") {
      spinner.stop(`Server path unavailable — ${verdict.reason}. Trying local`, 1)
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) { dlSpinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url, args.output as string | undefined, args.brand ? Number(args.brand) : undefined, false, args.treatment as string | undefined)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const data = tool.data
    spinner.stop("Done")

    const provider = data?.provider ?? "?"
    const wordCount = data?.word_count ?? 0
    const duration = data?.duration_seconds ?? 0
    if (!args.json) {
      printDivider()
      console.log(`  ${bold("Provider:")}  ${highlight(provider)}`)
      console.log(`  ${bold("Words:")}     ${wordCount}`)
      console.log(`  ${bold("Duration:")}  ~${duration}s`)
    }

    // Through the shared finisher — --output and --treatment were dropped here too.
    await finishTranscript(
      url,
      verdict.text,
      String(provider),
      !!args.json,
      url,
      args.output as string | undefined,
      url,
      args.treatment as string | undefined,
    )
    prompts.outro("Done")
  },
})
