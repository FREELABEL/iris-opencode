import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync } from "fs"
import { homedir } from "os"
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
export async function transcribeLocal(
  audioPath: string,
  opts: { language?: string; prompt?: string } = {},
): Promise<string> {
  const abs = resolve(audioPath)
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)

  const ff = resolveFfmpeg()
  // whisper-cli is what Homebrew's whisper-cpp formula actually installs; whisper-cpp is the
  // older name. Both accepted — this one was already right.
  const whisper = which("whisper-cli") || which("whisper-cpp")
  if (!ff.bin) throw new Error(ff.diagnosis || "ffmpeg unavailable")
  if (!whisper) throw new Error("Local transcription requires whisper-cpp. Install: brew install whisper-cpp")
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
    const args = ["-m", modelPath, "-otxt", "-of", outBase]
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
 * Provider-agnostic transcription. Selection: opts.provider → env
 * IRIS_TRANSCRIPTION_PROVIDER → default "whisper-local".
 */
export async function transcribeAudio(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
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
