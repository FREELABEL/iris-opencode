import { spawn, spawnSync } from "child_process"
import { existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { which } from "./transcription"

// ============================================================================
// Voice lib — the local, free, on-device half of voice chat.
//
//   captureMic()  = push-to-talk mic capture via ffmpeg → 16kHz mono WAV.
//                   Pairs with transcribeLocal() (whisper.cpp) for STT.
//   speak()       = local text-to-speech. macOS `say` (zero-dep default) or
//                   Piper (cross-platform neural) — no cloud, no per-minute cost.
//   listMics()    = enumerate input devices so `--mic <id>` is discoverable.
//
// Everything here runs on-device: HIPAA-safe, offline-capable, $0 per turn.
// Cloud voices (ElevenLabs/VAPI) stay in `iris voice` for phone/agent config.
// ============================================================================

export interface Mic {
  index: string
  name: string
}

/** Enumerate audio input devices (macOS avfoundation). Empty on other platforms. */
export function listMics(): Mic[] {
  if (process.platform !== "darwin") return []
  const r = spawnSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" })
  const out = r.stderr || ""
  const mics: Mic[] = []
  let inAudio = false
  for (const line of out.split("\n")) {
    if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue }
    if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue }
    if (!inAudio) continue
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (m) mics.push({ index: m[1], name: m[2].trim() })
  }
  return mics
}

/** Platform-specific ffmpeg input args. `mic` is a device index (macOS) or ALSA name (linux). */
function micInputArgs(mic?: string): string[] {
  switch (process.platform) {
    case "darwin":
      // `:default` follows the system input device; `:<index>` pins a specific mic.
      return ["-f", "avfoundation", "-i", `:${mic ?? "default"}`]
    case "linux":
      return ["-f", "alsa", "-i", mic ?? "default"]
    default:
      throw new Error(`Voice capture not supported on ${process.platform} yet — use --text or macOS/Linux.`)
  }
}

export interface CaptureOptions {
  mic?: string
  /** Silence threshold in dB (quieter than this counts as silence). Default -30. */
  silenceDb?: number
  /** Trailing-silence seconds that end a turn. Default 1.4. */
  silenceDur?: number
  /** Hard cap so a turn can never run forever. Default 30s. */
  maxSeconds?: number
  /** Called once real speech is detected (to update the UI from "listening" → "recording"). */
  onSpeech?: () => void
  /** Resolve this to stop the recording — the primary, deterministic control (ENTER). */
  stopSignal?: Promise<void>
  /**
   * Opt-in silence auto-stop. Off by default: silencedetect thresholds are too
   * room/mic-dependent to be reliable (they misfired badly in the field), so the
   * default control is the explicit stopSignal (ENTER). Enable only to experiment.
   */
  autoStop?: boolean
}

/**
 * Mic capture → 16kHz mono WAV. Records until `stopSignal` resolves (ENTER — the
 * deterministic default) or the `maxSeconds` safety cap, whichever comes first.
 * SIGINT lets ffmpeg write the WAV trailer cleanly (a hard kill truncates it).
 * `autoStop` optionally layers ffmpeg `silencedetect` on top, but it's off by
 * default because the thresholds proved unreliable across environments.
 */
export async function captureMic(opts: CaptureOptions = {}): Promise<string> {
  const ffmpeg = which("ffmpeg")
  if (!ffmpeg) throw new Error("ffmpeg not found. Install: brew install ffmpeg")

  const noise = opts.silenceDb ?? -30
  const dur = opts.silenceDur ?? 1.4
  const maxSeconds = opts.maxSeconds ?? 60
  const wav = join(tmpdir(), `iris-voice-${Date.now()}.wav`)
  const args = [
    "-hide_banner", "-nostdin", "-y",
    ...micInputArgs(opts.mic),
    ...(opts.autoStop ? ["-af", `silencedetect=noise=${noise}dB:d=${dur}`] : []),
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    "-t", String(maxSeconds),
    wav,
  ]
  const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] })

  let spoke = false
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    proc.kill("SIGINT")
  }

  if (opts.autoStop) {
    proc.stderr?.on("data", (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        if (line.includes("silence_end")) { if (!spoke) opts.onSpeech?.(); spoke = true; continue }
        const m = line.match(/silence_start:\s*([\d.]+)/)
        if (m && (spoke || parseFloat(m[1]) > 1.5)) { if (!spoke) opts.onSpeech?.(); stop() }
      }
    })
  }

  // Primary control: a resolved stopSignal (ENTER) ends the turn immediately.
  opts.stopSignal?.then(() => stop()).catch(() => {})

  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve())
    proc.on("error", () => resolve())
  })
  return wav
}

/** Strip markdown so TTS doesn't read asterisks/backticks/link syntax aloud. */
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[_>]/g, "")
    .trim()
}

/**
 * Speak text locally. tts: "say" (macOS), "piper" (neural, needs IRIS_PIPER_MODEL),
 * or "none". Falls back to `say` on macOS if the requested backend is unavailable.
 * Never throws — a failed TTS must not kill the conversation loop.
 */
export async function speak(text: string, opts: { tts?: string; voice?: string } = {}): Promise<void> {
  const clean = stripForSpeech(text)
  if (!clean) return
  let tts = opts.tts || (process.platform === "darwin" ? "say" : "piper")
  if (tts === "none") return

  const run = (bin: string, args: string[], input?: Buffer): Promise<void> =>
    new Promise((resolve) => {
      const p = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "ignore", "ignore"] })
      p.on("close", () => resolve())
      p.on("error", () => resolve())
      if (input) { p.stdin?.write(input); p.stdin?.end() }
    })

  if (tts === "piper") {
    const piper = which("piper")
    const model = process.env.IRIS_PIPER_MODEL
    const player = which("afplay") || which("ffplay")
    if (piper && model && existsSync(model) && player) {
      const wav = join(tmpdir(), `iris-tts-${Date.now()}.wav`)
      await run(piper, ["-m", model, "-f", wav], Buffer.from(clean))
      if (existsSync(wav)) {
        await run(player, player.endsWith("ffplay") ? ["-nodisp", "-autoexit", "-loglevel", "quiet", wav] : [wav])
        spawnSync("rm", ["-f", wav])
        return
      }
    }
    // Piper not ready → fall back to say on macOS, else silent.
    tts = process.platform === "darwin" ? "say" : "none"
    if (tts === "none") return
  }

  if (tts === "say") {
    const say = which("say")
    if (!say) return
    await run(say, opts.voice ? ["-v", opts.voice, clean] : [clean])
  }
}
