import { spawn, spawnSync } from "child_process"
import { chmodSync, mkdirSync } from "fs"
import { homedir, platform } from "os"
import { join } from "path"

/**
 * Microphone capture, shared by `iris listen` (CLI) and the TUI dictate keybind.
 *
 * ONE ffmpeg invocation, in one file. The two callers differ entirely in how they DRAW —
 * raw ANSI on a pipe versus a Solid component inside OpenTUI — and not at all in how they
 * record. Two copies of the argv would drift, and the way they would drift is silent: a
 * sample rate or a device flag that is right in one surface and wrong in the other produces
 * a recording that transcribes badly rather than one that fails.
 */

export interface AudioDevice {
  index: number
  name: string
}

/** Where captures land. Never the CWD — see #152293, that littered git repos. */
export const CAPTURE_DIR = join(homedir(), ".iris", "recordings")

/**
 * The dB window the meter maps onto its bar.
 *
 * Measured on a MacBook Pro internal mic: room tone sits around -60 dBFS, ordinary speech
 * lands between -45 and -35. Anchoring the floor at -60 rather than at ffmpeg's true -inf
 * keeps the bar still in a quiet room, which is what makes movement mean something — if room
 * tone filled a third of the bar, a muted input and a quiet room would look identical.
 */
export const DB_FLOOR = -60
export const DB_CEIL = -10

export function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf-8" })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * Audio input devices, as avfoundation numbers them.
 *
 * The indices are assigned in enumeration order, so adding an interface renumbers everything
 * below it. Callers must select by NAME — see resolveDevice.
 */
export function listAudioDevices(): AudioDevice[] {
  if (platform() !== "darwin") return []
  const r = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf-8",
  })
  // ffmpeg exits non-zero here by design: listing devices IS "error opening input".
  const section = `${r.stderr ?? ""}`.split("AVFoundation audio devices:")[1]
  if (!section) return []

  const devices: AudioDevice[] = []
  for (const line of section.split("\n")) {
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (m) devices.push({ index: Number(m[1]), name: m[2] })
  }
  return devices
}

/**
 * Pick the input to record from.
 *
 * Prefers a real microphone over a loopback device. BlackHole and its relatives routinely
 * enumerate FIRST and carry system audio rather than a voice, so `devices[0]` records perfect
 * silence on a machine that is working correctly — and every other stage reports success.
 *
 * A named device that is absent returns null rather than falling back: quietly recording a
 * different input than the one asked for is the failure this whole module is built around.
 */
export function resolveDevice(devices: AudioDevice[], requested?: string): AudioDevice | null {
  if (requested) {
    const needle = requested.toLowerCase()
    return devices.find((d) => d.name.toLowerCase().includes(needle)) ?? null
  }
  const virtual = /blackhole|loopback|soundflower|aggregate|multi-output/i
  const mic = devices.find((d) => /microphone|mic\b|input/i.test(d.name) && !virtual.test(d.name))
  return mic ?? devices.find((d) => !virtual.test(d.name)) ?? devices[0] ?? null
}

/** dBFS → 0..1 across the window above. */
export function levelToUnit(db: number): number {
  if (!Number.isFinite(db)) return 0
  const clamped = Math.max(DB_FLOOR, Math.min(DB_CEIL, db))
  return (clamped - DB_FLOOR) / (DB_CEIL - DB_FLOOR)
}

export interface Recording {
  /** Where the wav is being written. */
  path: string
  /** The device actually being recorded, after resolution. */
  device: AudioDevice
  /** Loudest level seen so far, 0..1 — the evidence for "did this capture anything". */
  peakSeen(): number
  /** Finish, flush the WAV header, and resolve when ffmpeg has exited. */
  stop(): Promise<{ ok: boolean; elapsedMs: number; stderr: string }>
  /**
   * Resolve when ffmpeg exits ON ITS OWN — a `seconds` limit reached, or the device gone —
   * without asking it to stop. Waiting on stop() instead ends the recording on the spot.
   */
  done(): Promise<void>
}

export interface StartOptions {
  device?: string
  seconds?: number
  /** Called for every level ffmpeg emits — roughly 86/sec. Throttle in the caller. */
  onLevel?: (unit: number) => void
  /**
   * Raw 16 kHz mono PCM16 (s16le), as it is captured — the live-dictation preview's feed.
   * Setting this adds a SECOND ffmpeg output on fd 3; the wav output is byte-for-byte the
   * argv it was without it (see captureArgs). A callback that throws is swallowed: a preview
   * must never be the reason a recording fails.
   */
  onPcm?: (chunk: Uint8Array) => void
}

/** fd the PCM tap is written to. 1 carries the level metadata, 2 errors, 0 the `q` to stop. */
const PCM_FD = 3

/**
 * The ffmpeg argv for a capture, from the input args onward.
 *
 * Pure so the claim "the tap does not change what lands in the file" is a test, not a promise:
 * with `tapPcm` the result is the untapped argv with a second output APPENDED after the wav
 * path. ffmpeg's output options bind to the next output, so nothing before the wav path moves.
 * The second output repeats `-ar/-ac/-t` because output options do not carry across outputs,
 * and it has no `-af`: the level filter stays on the wav output, where it always was.
 */
export function captureArgs(
  input: string[],
  path: string,
  opts: { seconds?: number; tapPcm?: boolean } = {},
): string[] {
  const fixed = typeof opts.seconds === "number" && opts.seconds > 0
  const limit = fixed ? ["-t", String(opts.seconds)] : []
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...input,
    // 16 kHz mono is what whisper wants, so the conversion happens once, here.
    "-ar",
    "16000",
    "-ac",
    "1",
    ...limit,
    "-af",
    "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-y",
    path,
    ...(opts.tapPcm
      ? ["-ar", "16000", "-ac", "1", ...limit, "-f", "s16le", "-acodec", "pcm_s16le", `pipe:${PCM_FD}`]
      : []),
  ]
}

/**
 * Begin recording. Resolves as soon as ffmpeg is spawned; the caller drives the UI.
 *
 * Levels arrive on ffmpeg's STDOUT via `ametadata=print:file=-`, which is why the wav must
 * go to a file rather than to stdout — they would interleave into the same pipe and corrupt
 * both.
 */
export async function startRecording(opts: StartOptions = {}): Promise<Recording> {
  if (platform() !== "darwin") throw new Error("Microphone capture currently supports macOS only (avfoundation).")
  if (!which("ffmpeg")) throw new Error("ffmpeg is required to capture audio. Install it with: brew install ffmpeg")

  const devices = listAudioDevices()
  const device = resolveDevice(devices, opts.device)
  if (!device) {
    throw new Error(
      opts.device
        ? `No input device matching "${opts.device}". Run: iris listen --list-devices`
        : "No audio input device found. Run: iris listen --list-devices",
    )
  }

  mkdirSync(CAPTURE_DIR, { recursive: true, mode: 0o700 })
  // chmod unconditionally: mkdirSync's `mode` applies ONLY to directories it actually
  // CREATES, so once ~/.iris/recordings exists at 0755 the mode above is a silent no-op.
  // (~/.iris/logs was found at 0744 for exactly this reason.) These recordings are not
  // transient — listen.ts deliberately KEEPS the wav when transcription fails, so a
  // world-readable directory here means retained voice sitting around for other local
  // accounts to read.
  try {
    chmodSync(CAPTURE_DIR, 0o700)
  } catch {
    /* not ours to chmod — better to record than to fail on a permissions nicety */
  }
  const path = join(CAPTURE_DIR, `listen-${Date.now()}.wav`)
  return spawnCapture(["-f", "avfoundation", "-i", `:${device.index}`], path, device, opts)
}

/**
 * Run the capture ffmpeg against any input. startRecording passes avfoundation; tests pass a
 * lavfi tone, which is how the PCM tap is exercised on a machine with no microphone.
 */
export function spawnCapture(
  input: string[],
  path: string,
  device: AudioDevice,
  opts: StartOptions = {},
  bin = "ffmpeg",
): Recording {
  const tap = typeof opts.onPcm === "function"
  const ff = spawn(bin, captureArgs(input, path, { seconds: opts.seconds, tapPcm: tap }), {
    stdio: tap ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  })

  if (tap) {
    // ALWAYS drained, whatever the preview is doing. An undrained pipe fills, ffmpeg blocks on
    // the write, and the wav output stalls with it — the preview would have cost the recording.
    // Never destroyed early for the same reason: a closed reader is an EPIPE that ends ffmpeg.
    const pcm = ff.stdio[PCM_FD] as NodeJS.ReadableStream | null
    pcm?.on("data", (chunk: Buffer) => {
      try {
        opts.onPcm?.(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      } catch {
        /* the preview's problem, never the recording's */
      }
    })
    pcm?.on("error", () => {})
  }

  const started = Date.now()
  let peak = 0
  let stderr = ""
  let carry = ""

  ff.stdout.setEncoding("utf-8")
  ff.stdout.on("data", (chunk: string) => {
    carry += chunk
    const lines = carry.split("\n")
    carry = lines.pop() ?? ""
    for (const line of lines) {
      const m = line.match(/RMS_level=(-?[\d.]+|-?inf)/)
      if (!m) continue
      const unit = levelToUnit(m[1] === "-inf" ? -Infinity : Number(m[1]))
      if (unit > peak) peak = unit
      opts.onLevel?.(unit)
    }
  })

  ff.stderr.setEncoding("utf-8")
  ff.stderr.on("data", (c: string) => {
    stderr = `${stderr}${c}`.slice(-800)
  })

  const exited = new Promise<number>((res) => {
    ff.on("close", (c) => res(c ?? 0))
    ff.on("error", () => res(1))
  })

  return {
    path,
    device,
    peakSeen: () => peak,
    done: () => exited.then(() => undefined),
    async stop() {
      // `q` is ffmpeg's graceful shutdown: it finalises the WAV header. A SIGKILL leaves a
      // file whose length says zero, which whisper reads as an empty recording — the exact
      // silent failure this module exists to prevent.
      try {
        ff.stdin.write("q")
      } catch {
        /* already gone */
      }
      const killer = setTimeout(() => {
        try {
          ff.kill("SIGTERM")
        } catch {
          /* noop */
        }
      }, 1500)
      const code = await exited
      clearTimeout(killer)
      return { ok: code === 0 || code === 255, elapsedMs: Date.now() - started, stderr }
    },
  }
}

/**
 * Silence is a FAILURE MODE, not a quiet recording.
 *
 * The threshold sits just above measured room tone so a soft-spoken take does NOT warn. A
 * warning on every quiet recording is one people stop reading, and then the genuinely dead
 * input sails past — which is the case that costs somebody their words.
 */
export function silenceWarning(peakSeen: number, device: string): string | null {
  if (peakSeen > 0.06) return null
  return (
    `Nothing above the noise floor on "${device}" for the whole recording.\n` +
    `  That usually means the input is muted, or another device is selected.\n` +
    `  Check: System Settings → Sound → Input, or run: iris listen --list-devices`
  )
}
