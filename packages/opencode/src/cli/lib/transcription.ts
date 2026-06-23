import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join, basename, extname, resolve } from "path"
import { irisFetch, FL_API } from "../cmd/iris-api"

// ============================================================================
// Transcription lib — the single client-side seam (Layer 2).
//
// transcribeLocal()  = on-device whisper.cpp (the HIPAA-safe default).
// transcribeAudio()  = provider router: whisper-local runs here; any cloud
//                      provider POSTs to the unified /api/v1/transcribe endpoint.
// Every consumer (the `transcribe` command, `ideas capture`, …) calls
// transcribeAudio() so providers are swappable behind one normalized return.
// ============================================================================

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
 * On-device transcription via whisper.cpp. Returns the transcript text.
 * Throws on missing deps / conversion / transcription failure. Writes only to
 * a tmp dir and cleans up (callers decide where, if anywhere, to persist).
 */
export async function transcribeLocal(audioPath: string, opts: { language?: string } = {}): Promise<string> {
  const abs = resolve(audioPath)
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)

  const ffmpeg = which("ffmpeg")
  const whisper = which("whisper-cli") || which("whisper-cpp")
  if (!ffmpeg) throw new Error("ffmpeg not found. Install: brew install ffmpeg")
  if (!whisper) throw new Error("Local transcription requires whisper-cpp. Install: brew install whisper-cpp")

  // Ensure model
  const modelDir = join(homedir(), ".whisper")
  const modelPath = join(modelDir, "ggml-base.en.bin")
  if (!existsSync(modelPath)) {
    mkdirSync(modelDir, { recursive: true })
    const dl = spawnSync("curl", ["-L", "-o", modelPath, WHISPER_MODEL_URL], { stdio: "ignore" })
    if (dl.status !== 0) throw new Error("Whisper model download failed")
  }

  // Convert → 16kHz mono WAV
  const wavPath = join(tmpdir(), `iris-transcribe-${Date.now()}-${basename(abs, extname(abs))}.wav`)
  const conv = spawnSync(ffmpeg, ["-y", "-i", abs, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { stdio: "ignore" })
  if (conv.status !== 0 || !existsSync(wavPath)) throw new Error("ffmpeg conversion failed")

  // Run whisper.cpp
  const outBase = join(tmpdir(), `iris-transcript-${Date.now()}-${basename(abs, extname(abs))}`)
  const args = ["-m", modelPath, "-otxt", "-of", outBase]
  if (opts.language) args.push("-l", opts.language)
  args.push(wavPath)
  const res = spawnSync(whisper, args, { encoding: "utf8" })
  spawnSync("rm", ["-f", wavPath])
  if (res.status !== 0) throw new Error(res.stderr?.slice(-500) || "whisper-cli failed")

  const txtPath = `${outBase}.txt`
  const text = existsSync(txtPath) ? readFileSync(txtPath, "utf8") : ""
  spawnSync("rm", ["-f", txtPath])
  return text.trim()
}

/**
 * Provider-agnostic transcription. Selection: opts.provider → env
 * IRIS_TRANSCRIPTION_PROVIDER → default "whisper-local".
 */
export async function transcribeAudio(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
  const provider = opts.provider || process.env.IRIS_TRANSCRIPTION_PROVIDER || "whisper-local"

  if (provider === "whisper-local") {
    const text = await transcribeLocal(audioPath, { language: opts.language })
    return { text, provider, meta: { on_device: true } }
  }

  // Cloud provider → unified backend endpoint (multipart upload).
  const abs = resolve(audioPath)
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const form = new FormData()
  form.append("audio_file", new Blob([new Uint8Array(readFileSync(abs))]), basename(abs))
  form.append("provider", provider)
  if (opts.language) form.append("language", opts.language)

  const res = await irisFetch("/api/v1/transcribe", { method: "POST", body: form }, FL_API)
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Transcription failed (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as any
  const d = data?.data ?? {}
  return {
    text: d.text ?? "",
    provider: d.provider ?? provider,
    meta: { duration: d.duration ?? null, language: d.language_code ?? null, speakers: d.speakers ?? [] },
  }
}
