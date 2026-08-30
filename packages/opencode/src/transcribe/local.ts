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

/**
 * Locate a binary WITHOUT trusting PATH.
 *
 * A Finder-launched macOS app inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin — measured on the
 * running sidecar. Homebrew installs to /opt/homebrew/bin, which is not on it. So `which`
 * returns nothing even when the tool is installed, and the honest-looking advice
 * "brew install ffmpeg" tells the user to install something they already have.
 */
const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin", // Apple Silicon Homebrew
  "/usr/local/bin", // Intel Homebrew, and most manual installs
  "/opt/local/bin", // MacPorts
  `${homedir()}/.local/bin`,
  "/usr/bin",
  "/bin",
]

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const found = r.stdout?.trim()
  if (found && r.status === 0) return found
  for (const dir of EXTRA_BIN_DIRS) {
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Is this already 16 kHz mono 16-bit PCM — i.e. exactly what whisper wants?
 *
 * The desktop capture path produces precisely that, so converting it would spend an ffmpeg
 * dependency to turn a file into itself. Parsed from the header rather than trusted from the
 * filename, because the extension is a caller's claim.
 */
function isWhisperReadyWav(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return false
  return (
    view.getUint16(20, true) === 1 && // PCM, uncompressed
    view.getUint16(22, true) === 1 && // mono
    view.getUint32(24, true) === 16000 && // 16 kHz
    view.getUint16(34, true) === 16 // 16-bit
  )
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
  // Only DECODING needs ffmpeg. The desktop sends 16 kHz mono PCM already, so that path has
  // no ffmpeg dependency at all — which matters, because a packaged app cannot see Homebrew.
  const ready = isWhisperReadyWav(audio)
  const ffmpeg = ready ? null : which("ffmpeg")
  const whisper = which("whisper-cli") || which("whisper-cpp")
  if (!ready && !ffmpeg) {
    throw new TranscribeError(
      "Cannot decode that audio format: ffmpeg was not found (looked on PATH and in /opt/homebrew/bin, /usr/local/bin, /opt/local/bin). Install it with: brew install ffmpeg",
    )
  }
  if (!whisper) {
    throw new TranscribeError(
      "Local transcription needs whisper-cpp, which was not found (looked on PATH and in /opt/homebrew/bin, /usr/local/bin, /opt/local/bin). Install it with: brew install whisper-cpp",
    )
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

    let wav = src
    if (!ready) {
      wav = join(work, "audio.wav")
      const conv = spawnSync(ffmpeg!, ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], {
        stdio: "ignore",
        timeout: TIMEOUT_MS,
      })
      if (conv.status !== 0 || !existsSync(wav)) throw new TranscribeError("Could not decode that audio")
    }

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
