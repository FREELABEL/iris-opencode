import { firstArray } from "../../util/array"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync } from "fs"
import { homedir, cpus } from "os"
import { join, basename, resolve, dirname } from "path"
import { irisFetch, FL_API } from "../cmd/iris-api"
import {
  auditTranscription,
  clampProvider,
  discardDir,
  resolveSttPolicy,
  sha256File,
  secureTempDir,
} from "./stt-policy"
import { resolvePlatformConfig, transcribePlatformChain, PlatformTranscribeError } from "./platform-transcribe"

// ============================================================================
// Transcription lib — the single client-side seam (Layer 2).
//
// transcribeLocal()  = on-device whisper.cpp (the HIPAA-safe default).
// transcribeAudio()  = provider router: whisper-local runs here; any cloud
//                      provider POSTs to the unified /api/v1/transcribe endpoint.
// Every consumer (the `transcribe` command, `ideas capture`, …) calls
// transcribeAudio() so providers are swappable behind one normalized return.
//
// Provider choice is CLAMPED by ./stt-policy (epic #182784). Local-first used to
// be a default here, which meant `--provider openai` could still upload audio and
// no setting could stop it. The clamp lives at this seam, not in the callers,
// because a policy each caller has to remember to apply is not a policy.
// ============================================================================

/** Hard ceiling on a single local transcription, so a wedged process can't hang the CLI. */
const LOCAL_TIMEOUT_MS = Number(process.env.IRIS_TRANSCRIPTION_TIMEOUT_MS ?? 10 * 60 * 1000)
/** Hard ceiling on the cloud upload leg. */
const CLOUD_TIMEOUT_MS = Number(process.env.IRIS_TRANSCRIPTION_TIMEOUT_MS ?? 5 * 60 * 1000)

const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

export function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout.trim()
  return p && r.status === 0 ? p : null
}

/**
 * Where `iris transcribe --install-local` puts whisper-cli. Not on PATH by default, so it is
 * looked up explicitly: an engine that installed fine and then "could not be found" is the same
 * dead end as one that never installed (#188318).
 */
export const LOCAL_WHISPER_DIR = join(homedir(), ".iris", "bin")

/** whisper-cli (Homebrew's name), whisper-cpp (the older name), or the one we built. */
export function resolveWhisper(): string | null {
  const own = join(LOCAL_WHISPER_DIR, "whisper-cli")
  return which("whisper-cli") || which("whisper-cpp") || (existsSync(own) ? own : null)
}

/**
 * The install line for THIS machine. It used to say "brew install whisper-cpp" everywhere,
 * including Linux Hive nodes that have no brew — so a sovereign-policy node could neither
 * upload nor install, and the advice was the dead end (#188318).
 */
export function localWhisperInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "brew install whisper-cpp"
  if (platform === "linux") return "iris transcribe --install-local   (builds whisper-cli into ~/.iris/bin — about a minute, no sudo)"
  return "download whisper-cli from github.com/ggml-org/whisper.cpp/releases and put it on your PATH"
}

/** Pinned so every node builds the same engine. Bump deliberately. */
const WHISPER_CPP_TAG = "v1.9.5"
const CMAKE_VERSION = "3.30.5"

/**
 * Build whisper-cli on Linux into ~/.iris/bin, with no root: a portable CMake from Kitware into
 * ~/.iris/tools, whisper.cpp at a pinned tag, a static Release build of the one target we use.
 * Proven 2026-10-07 on a 4-core Linux Hive node: 70 s to build, then a 32 s clip transcribed in
 * 10 s under the sovereign policy. macOS uses Homebrew. Runs only when asked (--install-local).
 */
export function installLocalWhisper(say: (msg: string) => void = () => {}): { ok: boolean; path?: string; detail: string } {
  if (process.platform === "darwin") {
    if (!which("brew")) return { ok: false, detail: "Homebrew is not installed. Install it from brew.sh, then: brew install whisper-cpp" }
    say("brew install whisper-cpp")
    const r = spawnSync("brew", ["install", "whisper-cpp"], { encoding: "utf8", timeout: 15 * 60 * 1000 })
    const path = resolveWhisper()
    return path ? { ok: true, path, detail: "installed with Homebrew" } : { ok: false, detail: (r.stderr || "brew install failed").slice(-500) }
  }
  if (process.platform !== "linux") return { ok: false, detail: localWhisperInstallHint() }

  const missing = ["git", "curl", "tar", "make", "cc", "c++"].filter((b) => !which(b))
  if (missing.length) return { ok: false, detail: `Missing build tools: ${missing.join(", ")} (e.g. sudo apt install build-essential git curl)` }
  if (process.arch !== "x64" && process.arch !== "arm64") return { ok: false, detail: `No portable CMake for ${process.arch}` }

  const tools = join(homedir(), ".iris", "tools")
  mkdirSync(tools, { recursive: true })
  mkdirSync(LOCAL_WHISPER_DIR, { recursive: true })
  const cmakeArch = process.arch === "x64" ? "x86_64" : "aarch64"
  const cmakeDir = join(tools, `cmake-${CMAKE_VERSION}-linux-${cmakeArch}`)
  const cmake = join(cmakeDir, "bin", "cmake")
  const run = (label: string, cmd: string, args: string[], cwd?: string) => {
    say(label)
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 20 * 60 * 1000 })
    if (r.status !== 0) throw new Error(`${label} failed: ${(r.stderr || r.stdout || "").slice(-400)}`)
  }
  try {
    if (!existsSync(cmake)) {
      const url = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-${cmakeArch}.tar.gz`
      run("Fetching CMake", "sh", ["-c", `curl -fsSL "${url}" | tar xz -C "${tools}"`])
    }
    const src = join(tools, `whisper.cpp-${WHISPER_CPP_TAG}`)
    if (!existsSync(src)) run(`Fetching whisper.cpp ${WHISPER_CPP_TAG}`, "git", ["clone", "-q", "--depth", "1", "--branch", WHISPER_CPP_TAG, "https://github.com/ggml-org/whisper.cpp.git", src])
    run("Configuring", cmake, ["-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF"], src)
    const jobs = String(Math.max(1, (cpus()?.length ?? 2)))
    run("Building whisper-cli (about a minute)", cmake, ["--build", "build", "-j", jobs, "--target", "whisper-cli"], src)
    const built = join(src, "build", "bin", "whisper-cli")
    const dest = join(LOCAL_WHISPER_DIR, "whisper-cli")
    run("Installing", "install", ["-m", "0755", built, dest])
    const v = spawnSync(dest, ["--help"], { encoding: "utf8", timeout: 30_000 })
    if (v.status !== 0 && !/usage/i.test((v.stdout || "") + (v.stderr || ""))) return { ok: false, detail: "built, but whisper-cli does not run" }
    return { ok: true, path: dest, detail: `built whisper.cpp ${WHISPER_CPP_TAG}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export interface TranscribeOptions {
  provider?: string
  language?: string
}

export interface TranscriptionResult {
  text: string
  provider: string
  meta: Record<string, unknown>
}

/**
 * Find an ffmpeg that ACTUALLY RUNS, not one that merely exists.
 *
 * `which ffmpeg` is the wrong question, and it is the same mistake this repo already fixed in
 * probeIsolation(): a binary can be on PATH and fail the moment it loads. Measured on a real
 * machine — Homebrew upgraded x265 from soname 215 to 217 without rebuilding ffmpeg, so:
 *
 *   dyld: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib
 *
 * `which` returned a path, the presence check passed, the conversion then failed with its
 * stderr discarded, and the user was told "ffmpeg conversion failed" plus a suggestion to
 * install whisper — which was already installed and was never the problem. Three layers of
 * true-but-useless.
 *
 * So: run `-version` on each candidate and take the first that answers. Candidates beyond PATH
 * are ones already present on the machine — a second Homebrew cellar, or a bundle that ships
 * its own dylibs beside it (Remotion, ffmpeg-static). Nothing is installed and nothing is
 * downloaded; this only reaches for what is already there.
 */
export interface FfmpegResolution {
  bin: string | null
  /** Extra env the binary needs — a bundled build wants its sibling dylibs on the path. */
  env?: NodeJS.ProcessEnv
  /** When bin is null: what was actually wrong, in the words the fix needs. */
  diagnosis?: string
}

function ffmpegRuns(bin: string, env?: NodeJS.ProcessEnv): { ok: boolean; err: string } {
  const r = spawnSync(bin, ["-version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (r.status === 0) return { ok: true, err: "" }
  const err = [r.stderr, (r.error as Error | undefined)?.message].filter(Boolean).join(" ").trim()
  return { ok: false, err }
}

/** A dyld failure names the library it wanted; that name IS the remedy. */
export function explainLoadFailure(err: string): string | null {
  const m = err.match(/Library not loaded:\s*(\S+)/)
  if (!m) return null
  const lib = m[1].split("/").pop() || m[1]
  const pkg = lib.replace(/^lib/, "").replace(/\.\d+\.dylib$/, "").replace(/\.dylib$/, "")
  return (
    `ffmpeg is installed but cannot load ${lib}. ` +
    `That library was upgraded without rebuilding ffmpeg against it. ` +
    `Fix: brew reinstall ffmpeg  (or: brew reinstall ${pkg} && brew reinstall ffmpeg)`
  )
}

export function resolveFfmpeg(): FfmpegResolution {
  const candidates: Array<{ bin: string; env?: NodeJS.ProcessEnv }> = []

  const onPath = which("ffmpeg")
  if (onPath) candidates.push({ bin: onPath })

  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (p !== onPath && existsSync(p)) candidates.push({ bin: p })
  }

  // Bundled builds that carry their own dylibs beside them, which is exactly why they survive
  // a broken system ffmpeg. Walked up from the working directory rather than checked only in
  // it: in a monorepo the bundle usually sits at a root several levels above wherever the
  // command was actually run. Bounded, and it never descends — searching the disk for a binary
  // to execute is not a thing a transcription command should do.
  const RELATIVE_BUNDLES = [
    "node_modules/@remotion/compositor-darwin-arm64/ffmpeg",
    "node_modules/@remotion/compositor-darwin-x64/ffmpeg",
    "node_modules/ffmpeg-static/ffmpeg",
  ]
  let dir = process.cwd()
  for (let up = 0; up < 6; up++) {
    for (const rel of RELATIVE_BUNDLES) {
      const p = join(dir, rel)
      if (existsSync(p)) candidates.push({ bin: p, env: { DYLD_LIBRARY_PATH: dirname(p) } })
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  let firstFailure = ""
  for (const c of candidates) {
    const { ok, err } = ffmpegRuns(c.bin, c.env)
    if (ok) return { bin: c.bin, env: c.env }
    if (!firstFailure) firstFailure = err
  }

  if (candidates.length === 0) {
    return { bin: null, diagnosis: "ffmpeg not found. Install: brew install ffmpeg" }
  }
  return {
    bin: null,
    diagnosis:
      explainLoadFailure(firstFailure) ||
      `ffmpeg is present but will not run: ${firstFailure.slice(-300) || "no error reported"}`,
  }
}

/**
 * On-device transcription via whisper.cpp. Returns the transcript text.
 * Throws on missing deps / conversion / transcription failure. Writes only to
 * a tmp dir and cleans up (callers decide where, if anywhere, to persist).
 */
/**
 * One timed span of speech. whisper.cpp computes these for every transcription; until
 * 2026-09-14 we asked for `-otxt` only and threw them away, which is why a transcript could
 * tell you WHAT was said and never WHEN. A span needs both.
 */
export type TranscriptSegment = { t0: number; t1: number; text: string }

export async function transcribeLocal(
  audioPath: string,
  opts: {
    language?: string
    prompt?: string
    /**
     * Receives timed segments when whisper produced them. A callback rather than a changed
     * return type: transcribeLocal() promises a string to a dozen callers and this must not
     * break any of them to add timings for one.
     */
    onSegments?: (segments: TranscriptSegment[]) => void
  } = {},
): Promise<string> {
  const abs = resolve(audioPath)
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)

  const ff = resolveFfmpeg()
  // whisper-cli is what Homebrew's whisper-cpp formula actually installs; whisper-cpp is the
  // older name. Both accepted — this one was already right.
  const whisper = resolveWhisper()
  if (!ff.bin) throw new Error(ff.diagnosis || "ffmpeg unavailable")
  if (!whisper) throw new Error(`Local transcription requires whisper.cpp. Install: ${localWhisperInstallHint()}`)
  const ffmpeg = ff.bin

  // Ensure model
  const modelDir = join(homedir(), ".whisper")
  const modelPath = join(modelDir, "ggml-base.en.bin")
  if (!existsSync(modelPath)) {
    mkdirSync(modelDir, { recursive: true })
    const dl = spawnSync("curl", ["-L", "-o", modelPath, WHISPER_MODEL_URL], { stdio: "ignore" })
    if (dl.status !== 0) throw new Error("Whisper model download failed")
  }

  const started = Date.now()
  const { sha256: digest, bytes } = await sha256File(abs)

  // One 0700 scratch dir for BOTH the converted WAV and whisper's .txt, removed in
  // `finally`. Previously these were loose files in tmpdir cleaned on the happy path
  // only, so a whisper crash left a 16kHz copy of the audio behind (epic #182784, B1).
  const work = secureTempDir("iris-stt-local-")
  try {
    const wavPath = join(work, "audio.wav")
    const conv = spawnSync(
      ffmpeg,
      ["-y", "-i", abs, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      // NOT stdio:"ignore". That discarded the one thing that explained the failure — the dyld
      // error naming the library ffmpeg could not load — and left the user with four words.
      { encoding: "utf8", timeout: LOCAL_TIMEOUT_MS, env: ff.env ? { ...process.env, ...ff.env } : process.env },
    )
    if (conv.status !== 0 || !existsSync(wavPath)) {
      const detail = (conv.stderr || "").trim()
      throw new Error(
        explainLoadFailure(detail) ||
          `ffmpeg could not convert this audio${detail ? `: ${detail.slice(-400)}` : ""}`,
      )
    }

    const outBase = join(work, "transcript")
    // -oj as well as -otxt: whisper has already done the work of timing every segment, and the
    // only reason a transcript arrived as undated prose was that we never asked for the JSON.
    const args = ["-m", modelPath, "-otxt", "-oj", "-of", outBase]
    if (opts.language) args.push("-l", opts.language)
    // Domain vocabulary. whisper.cpp caps the initial prompt at n_text_ctx/2 tokens and silently
    // truncates past that, so keep it to the same 2000 chars the server leg allows rather than
    // letting a long glossary quietly lose its tail.
    if (opts.prompt) args.push("--prompt", opts.prompt.slice(0, 2000))
    args.push(wavPath)
    const res = spawnSync(whisper, args, { encoding: "utf8", timeout: LOCAL_TIMEOUT_MS })
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`whisper-cli exceeded ${Math.round(LOCAL_TIMEOUT_MS / 1000)}s and was killed`)
    }
    if (res.status !== 0) throw new Error(res.stderr?.slice(-500) || "whisper-cli failed")

    const txtPath = `${outBase}.txt`
    const text = existsSync(txtPath) ? readFileSync(txtPath, "utf8") : ""

    // Read the timings HERE — `work` is removed in the finally block, so anything not parsed
    // before we return is gone. Failure to parse must not fail the transcription: the text is
    // the contract, the segments are an enrichment.
    if (opts.onSegments) {
      try {
        const jsonPath = `${outBase}.json`
        if (existsSync(jsonPath)) {
          const raw = JSON.parse(readFileSync(jsonPath, "utf8"))
          const rows: any[] = firstArray(raw?.transcription)
          const segments: TranscriptSegment[] = rows
            .map((r) => ({
              // whisper.cpp offsets are MILLISECONDS. Emitting them as seconds without
              // dividing would put every span 1000x down the timeline.
              t0: Math.round(((r?.offsets?.from ?? 0) / 1000) * 10) / 10,
              t1: Math.round(((r?.offsets?.to ?? 0) / 1000) * 10) / 10,
              text: String(r?.text ?? "").trim(),
            }))
            .filter((x) => x.text.length > 0)
          if (segments.length) opts.onSegments(segments)
        }
      } catch {
        /* timings are a bonus; never let them cost us the transcript */
      }
    }
    auditTranscription({
      provider: "whisper-local",
      policy: resolveSttPolicy(),
      bytes,
      sha256: digest,
      ms: Date.now() - started,
      ok: true,
    })
    return text.trim()
  } catch (err) {
    auditTranscription({
      provider: "whisper-local",
      policy: resolveSttPolicy(),
      bytes,
      sha256: digest,
      ms: Date.now() - started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    discardDir(work)
  }
}

/**
 * On-device whisper is usable RIGHT NOW: ffmpeg, a whisper binary and the model all present.
 * The fallback after the platform only runs when this is true — a 150 MB model download in the
 * middle of a dictation is not a fallback, it is a second failure (Desktop's localWhisperReady).
 */
export function localWhisperReady(): boolean {
  return (
    Boolean(resolveFfmpeg().bin) &&
    // resolveWhisper, not `which`: it also finds the engine `iris transcribe --install-local`
    // builds into ~/.iris/bin, which is not on PATH (#188318).
    Boolean(resolveWhisper()) &&
    existsSync(join(homedir(), ".whisper", "ggml-base.en.bin"))
  )
}

/**
 * Provider-agnostic transcription. Selection: opts.provider → env
 * IRIS_TRANSCRIPTION_PROVIDER → the DEFAULT, which is IRIS Desktop's order (#187808):
 * the IRIS platform (Grok first, board-scoped, PHI-gated) → on-device whisper if installed.
 * Under `IRIS_TRANSCRIPTION_POLICY=sovereign` the default is whisper-local, as before.
 */
export async function transcribeAudio(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
  if (!opts.provider && !process.env.IRIS_TRANSCRIPTION_PROVIDER && resolveSttPolicy() === "standard") {
    return transcribeDefault(audioPath, opts)
  }
  // `explicit` distinguishes a flag the user typed from an env var they inherited.
  // The first is refused loudly; the second is clamped with a warning. Silently
  // ignoring a typed flag would leave `provider: whisper-local` in the output as
  // the only clue, which nobody reads until after they assumed it uploaded.
  const explicit = Boolean(opts.provider)
  const requested = opts.provider || process.env.IRIS_TRANSCRIPTION_PROVIDER || "whisper-local"
  const provider = clampProvider(requested, { explicit })

  if (provider === "whisper-local") {
    const text = await transcribeLocal(audioPath, { language: opts.language })
    return { text, provider, meta: { on_device: true } }
  }

  // Cloud provider → unified backend endpoint (multipart upload).
  const abs = resolve(audioPath)
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const started = Date.now()
  const { sha256: digest, bytes } = await sha256File(abs)
  const form = new FormData()
  form.append("audio_file", new Blob([new Uint8Array(readFileSync(abs))]), basename(abs))
  form.append("provider", provider)
  if (opts.language) form.append("language", opts.language)

  const audit = (ok: boolean, error?: string) =>
    auditTranscription({ provider, policy: resolveSttPolicy(), bytes, sha256: digest, ms: Date.now() - started, ok, error })

  try {
    const res = await irisFetch(
      "/api/v1/transcribe",
      { method: "POST", body: form, signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) },
      FL_API,
    )
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      audit(false, `HTTP ${res.status}`)
      throw new Error(`Transcription failed (HTTP ${res.status}): ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as any
    const d = data?.data ?? {}
    audit(true)
    return {
      text: d.text ?? "",
      provider: d.provider ?? provider,
      meta: { duration: d.duration ?? null, language: d.language_code ?? null, speakers: d.speakers ?? [] },
    }
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      audit(false, "timeout")
      throw new Error(`Transcription upload exceeded ${Math.round(CLOUD_TIMEOUT_MS / 1000)}s and was aborted`)
    }
    throw err
  }
}

/**
 * The default path, the same as IRIS Desktop's chain: the platform first, on-device whisper only
 * when it is already installed. Each attempt is audited, cloud or local.
 */
async function transcribeDefault(audioPath: string, opts: TranscribeOptions): Promise<TranscriptionResult> {
  const abs = resolve(audioPath)
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const platform = await resolvePlatformConfig()
  let cloudError = "reason" in platform ? platform.reason : ""

  if ("config" in platform) {
    const started = Date.now()
    const { sha256: digest, bytes } = await sha256File(abs)
    try {
      const r = await transcribePlatformChain(new Uint8Array(readFileSync(abs)), platform.config, {
        filename: basename(abs),
        language: opts.language,
      })
      auditTranscription({ provider: r.provider, policy: "standard", bytes, sha256: digest, ms: Date.now() - started, ok: true })
      return { text: r.text, provider: r.provider, meta: { on_device: false } }
    } catch (e) {
      cloudError = e instanceof Error ? e.message : String(e)
      const status = e instanceof PlatformTranscribeError ? e.status : 0
      auditTranscription({ provider: "iris-platform", policy: "standard", bytes, sha256: digest, ms: Date.now() - started, ok: false, error: status ? `HTTP ${status}` : cloudError.slice(0, 120) })
      // A refusal the platform made on purpose (a PHI board, a bad scope) is not routed around by
      // falling back — on-device whisper never leaves the machine, so it is allowed, but only
      // because it is local, and only when it is already installed.
    }
  }

  if (localWhisperReady()) {
    const text = await transcribeLocal(audioPath, { language: opts.language })
    return { text, provider: "whisper-local", meta: { on_device: true, cloud_error: cloudError || null } }
  }
  throw new Error(cloudError || "No transcription engine is available.")
}
