import { spawn, spawnSync, type ChildProcess } from "child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolveBin, TranscribeError } from "./local"

/**
 * Microphone capture in the SIDECAR, not the webview.
 *
 * The webview cannot do this. Tauri's macOS shell implements no WKUIDelegate media-capture
 * callback, so WebKit never grants the page's getUserMedia request — it resolves with a track
 * that emits nothing. Measured in the shipped app: a 10-second recording with peak amplitude
 * 0.0000, while the app's own TCC microphone grant was present and allowed.
 *
 * This process has that grant and is an ordinary macOS process, so it can record directly.
 * Same approach the CLI already uses for `iris listen`.
 *
 * ONE recording at a time, deliberately. This is a single-user local daemon; a map of
 * concurrent sessions would add a lifecycle to leak and nothing to gain.
 */

const MAX_SECONDS = 300

interface Active {
  proc: ChildProcess
  dir: string
  path: string
  startedAt: number
  /** ffmpeg's own words. Without these, every capture failure is just "no file". */
  stderr: string[]
}

let active: Active | undefined

function inputArgs(device?: string): string[] {
  switch (process.platform) {
    case "darwin":
      // ":default" follows the system input device; ":<index>" pins one.
      return ["-f", "avfoundation", "-i", `:${device ?? "default"}`]
    case "linux":
      return ["-f", "alsa", "-i", device ?? "default"]
    default:
      throw new TranscribeError(`Microphone capture is not supported on ${process.platform} yet.`)
  }
}

export function isRecording(): boolean {
  return Boolean(active)
}

/** Begin capture. Writes 16 kHz mono PCM — already exactly what whisper wants. */
export function startCapture(device?: string): { startedAt: number } {
  if (active) throw new TranscribeError("Already recording.")

  const ffmpeg = resolveBin("ffmpeg")
  if (!ffmpeg) {
    throw new TranscribeError(
      "Recording needs ffmpeg, which was not found (looked on PATH and in /opt/homebrew/bin, /usr/local/bin, /opt/local/bin). Install it with: brew install ffmpeg",
    )
  }

  const dir = mkdtempSync(join(tmpdir(), "iris-dictate-"))
  const path = join(dir, "capture.pcm")
  const proc = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      ...inputArgs(device),
      // pan, NOT `-ac 1`. The default input here is a 17-channel aggregate ("Stream Mic
      // Collection"), and -ac 1 fails on it outright:
      //   "Rematrix is needed between 17 channels and mono but there is not enough
      //    information to do it" -> "Nothing was written into output file"
      // pan takes channel 0 and needs no layout information, so it works on both a plain
      // mono mic and a multi-channel aggregate. Measured: peak 0.0486 on the aggregate.
      "-af",
      "pan=mono|c0=c0",
      "-ar",
      "16000",
      // RAW PCM, not WAV. A WAV needs its header finalised with the final size, so ffmpeg
      // buffers and writes nothing until it exits cleanly — a SIGINT'd recording produced a
      // 0-byte file every time, which read as "the microphone is broken". Raw s16le has no
      // header to finalise: every byte written is already usable, even if the process is
      // killed outright. The RIFF header is added below, where the length is known.
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      // Without this ffmpeg buffers the output and the file stays 0 bytes for the whole
      // recording — measured. Combined with a SIGINT stop that means every capture came back
      // empty, indistinguishable from a dead microphone. Flush as we go, so whatever has been
      // spoken is on disk before the stop even arrives.
      "-flush_packets",
      "1",
      // A hard cap so a forgotten recording cannot fill the disk.
      "-t",
      String(MAX_SECONDS),
      path,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  )

  const stderr: string[] = []
  proc.stderr?.on("data", (b: Buffer) => {
    stderr.push(b.toString())
    if (stderr.length > 80) stderr.shift()
  })

  active = { proc, dir, path, startedAt: Date.now(), stderr }
  return { startedAt: active.startedAt }
}

/**
 * Stop capture and return the recorded WAV.
 *
 * SIGINT, not SIGKILL: ffmpeg needs to write the RIFF trailer or the file is unreadable.
 * A killed recording looks exactly like a broken microphone, which is the confusion this
 * whole feature has already produced once.
 */
export async function stopCapture(): Promise<{ audio: Uint8Array; ms: number }> {
  const current = active
  if (!current) throw new TranscribeError("Not recording.")
  active = undefined

  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    current.proc.on("close", done)
    current.proc.on("error", done)
    current.proc.kill("SIGINT")
    // If ffmpeg ignores SIGINT we still return rather than hanging the request. Short,
    // because -flush_packets means everything spoken is ALREADY on disk — we are waiting for
    // a clean exit, not for data. Three seconds here was most of the felt latency.
    setTimeout(() => {
      try {
        current.proc.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      done()
    }, 700)
  })

  try {
    if (!existsSync(current.path) || statSync(current.path).size === 0) {
      // Report what ffmpeg actually said. "No file" on its own sent me hunting the microphone
      // when the real message was a channel-layout error on a 17-channel aggregate device.
      const said = current.stderr
        .join("")
        .split("\n")
        .filter((l) => /error|invalid|failed|denied|not permitted|Nothing was written/i.test(l))
        .slice(-3)
        .join(" | ")
        .trim()
      throw new TranscribeError(
        said
          ? `The recorder wrote nothing. ffmpeg said: ${said}`
          : "The recorder produced no file. Check the input device in System Settings › Sound.",
      )
    }
    return { audio: wrapPcmAsWav(new Uint8Array(readFileSync(current.path))), ms: Date.now() - current.startedAt }
  } finally {
    // The recording dies with the request that collected it.
    try {
      rmSync(current.dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/** Abandon a recording without transcribing it. */
export function cancelCapture(): void {
  const current = active
  if (!current) return
  active = undefined
  try {
    current.proc.kill("SIGKILL")
  } catch {
    /* already gone */
  }
  try {
    rmSync(current.dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Loudest sample in a 16-bit PCM WAV, 0..1.
 *
 * whisper answers "You" to silence, confidently, every time — so a silent capture must be
 * refused rather than transcribed. Measured here rather than in the client because the client
 * no longer sees the audio.
 */
export function peakAmplitude(wav: Uint8Array): number {
  if (wav.length < 45) return 0
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let peak = 0
  for (let i = 44; i + 1 < wav.length; i += 2) {
    const v = Math.abs(view.getInt16(i, true)) / 0x8000
    if (v > peak) peak = v
  }
  return peak
}

/**
 * Audio input devices, so a silent capture can be answered with "pick a different one"
 * rather than a shrug. Channel 0 of an aggregate device is not always the live microphone.
 */
export function listInputDevices(): Array<{ index: string; name: string }> {
  if (process.platform !== "darwin") return []
  const ffmpeg = resolveBin("ffmpeg")
  if (!ffmpeg) return []
  const r = spawnSync(ffmpeg, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" })
  const out: Array<{ index: string; name: string }> = []
  let inAudio = false
  for (const line of (r.stderr || "").split("\n")) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true
      continue
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudio = false
      continue
    }
    if (!inAudio) continue
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (m) out.push({ index: m[1]!, name: m[2]!.trim() })
  }
  return out
}

/** Wrap raw 16 kHz mono s16le PCM in a RIFF header, so whisper gets a normal WAV. */
export function wrapPcmAsWav(pcm: Uint8Array, rate = 16000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const view = new DataView(out.buffer)
  const str = (o: number, v: string) => {
    for (let i = 0; i < v.length; i++) view.setUint8(o + i, v.charCodeAt(i))
  }
  str(0, "RIFF")
  view.setUint32(4, 36 + pcm.length, true)
  str(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, "data")
  view.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}
