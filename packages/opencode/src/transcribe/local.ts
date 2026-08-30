import { spawnSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

/**
 * On-device transcription for desktop dictation.
 *
 * Deliberately self-contained: no HTTP client, no provider registry, no cloud branch. There
 * is nothing here that can send audio anywhere, which is the property that makes it safe to
 * expose on a local route. If you add a network call to this file you have changed what the
 * microphone means.
 *
 * Ported from main's transcription seam (epic #182784) rather than shared, because this
 * branch has no `cli/lib` and none of the provider stack the original sat on.
 */

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

/** Hard ceiling so a wedged ffmpeg/whisper cannot hang the server forever. */
const TIMEOUT_MS = Number(process.env.IRIS_TRANSCRIPTION_TIMEOUT_MS ?? 10 * 60 * 1000)

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout?.trim()
  return p && r.status === 0 ? p : null
}

export class TranscribeError extends Error {}

/**
 * A 0700 scratch directory. On macOS os.tmpdir() is already per-user 0700, but on Linux it
 * is /tmp (1777) where a 0644 WAV of someone's voice is readable by every account on the box.
 */
function secureTempDir(): string {
  return mkdtempSync(join(tmpdir(), "iris-dictate-"))
}

export interface TranscribeResult {
  text: string
  provider: "whisper-local"
  ms: number
}

/**
 * Transcribe an audio buffer on this machine. The bytes are written to a 0700 directory that
 * is removed in a `finally` — the recording must not outlive the request that produced it.
 */
export async function transcribeLocal(
  audio: Uint8Array,
  opts: { filename?: string; language?: string } = {},
): Promise<TranscribeResult> {
  const ffmpeg = which("ffmpeg")
  const whisper = which("whisper-cli") || which("whisper-cpp")
  if (!ffmpeg) throw new TranscribeError("ffmpeg not found. Install it with: brew install ffmpeg")
  if (!whisper) {
    throw new TranscribeError("Local transcription needs whisper-cpp. Install it with: brew install whisper-cpp")
  }

  const modelDir = join(homedir(), ".whisper")
  const modelPath = join(modelDir, "ggml-base.en.bin")
  if (!existsSync(modelPath)) {
    mkdirSync(modelDir, { recursive: true })
    const dl = spawnSync("curl", ["-L", "-o", modelPath, MODEL_URL], { stdio: "ignore" })
    if (dl.status !== 0) throw new TranscribeError("Whisper model download failed")
  }

  const started = Date.now()
  const work = secureTempDir()
  try {
    // Extension matters: ffmpeg sniffs the container, but giving it the right hint avoids
    // a class of "Invalid data found" failures on webm from MediaRecorder.
    const src = join(work, opts.filename?.replace(/[^\w.-]/g, "_") || "input.webm")
    writeFileSync(src, audio)

    const wav = join(work, "audio.wav")
    const conv = spawnSync(ffmpeg, ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], {
      stdio: "ignore",
      timeout: TIMEOUT_MS,
    })
    if (conv.status !== 0 || !existsSync(wav)) throw new TranscribeError("Could not decode that audio")

    const outBase = join(work, "out")
    const args = ["-m", modelPath, "-otxt", "-of", outBase]
    if (opts.language) args.push("-l", opts.language)
    args.push(wav)
    const res = spawnSync(whisper, args, { encoding: "utf8", timeout: TIMEOUT_MS })
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new TranscribeError(`Transcription exceeded ${Math.round(TIMEOUT_MS / 1000)}s and was stopped`)
    }
    if (res.status !== 0) throw new TranscribeError(res.stderr?.slice(-300) || "whisper failed")

    const txt = `${outBase}.txt`
    const text = existsSync(txt) ? readFileSync(txt, "utf8").trim() : ""
    return { text, provider: "whisper-local", ms: Date.now() - started }
  } finally {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      /* best effort — cleanup must not mask a real error */
    }
  }
}
