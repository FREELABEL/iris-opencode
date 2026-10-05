import { spawn, spawnSync, type ChildProcess } from "child_process"
import { existsSync, readFileSync } from "fs"
import { dirname, join } from "path"
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
/** 16 kHz × 16-bit mono. */
const BYTES_PER_SECOND = 32000
/** The level meter's window: ~50 ms of audio. */
const LEVEL_WINDOW_BYTES = 1600

/** Platforms with a sidecar capture backend. */
const SUPPORTED = new Set<string>(["darwin", "linux", "win32"])

/** One way to open the microphone. Several are tried in order where a platform has more than one. */
export interface CaptureInput {
  /** ffmpeg input format: avfoundation, alsa, pulse, dshow. */
  backend: string
  args: string[]
  /** What a person would call it — the device name, for errors. */
  label: string
}

interface Active {
  proc: ChildProcess
  ffmpeg: string
  input: CaptureInput
  /** Inputs not yet tried. One that dies before producing a byte hands over to the next. */
  fallbacks: CaptureInput[]
  /** The recording so far, straight from ffmpeg's stdout. 300 s caps it at ~9.6 MB. */
  chunks: Buffer[]
  bytes: number
  startedAt: number
  /** ffmpeg's own words. Without these, every capture failure is just "no audio". */
  stderr: string[]
}

let active: Active | undefined

export function isRecording(): boolean {
  return Boolean(active)
}

/**
 * Where ffmpeg is. IRIS_FFMPEG wins (a person, or a test, can point at one); then a copy shipped
 * next to this executable (none is bundled today — see the report in the commit that added this);
 * then the usual search, which knows Homebrew and winget locations a GUI-launched app cannot see.
 */
export function ffmpegPath(): string | null {
  const override = process.env["IRIS_FFMPEG"]?.trim()
  if (override && existsSync(override)) return override
  const beside = join(dirname(process.execPath), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
  if (existsSync(beside)) return beside
  return resolveBin("ffmpeg")
}

/**
 * The inputs to try on this platform, in order. Throws a TranscribeError worded for THIS
 * platform when there is nothing to record from.
 */
export function inputCandidates(platform: string, ffmpeg: string, device?: string): CaptureInput[] {
  switch (platform) {
    case "darwin":
      // ":default" follows the system input device; ":<index>" pins one.
      return [{ backend: "avfoundation", args: ["-f", "avfoundation", "-i", `:${device ?? "default"}`], label: device ?? "default" }]
    case "linux":
      // ALSA first: it is there on every desktop, and PipeWire/PulseAudio hosts route ALSA's
      // "default" through their own plugin. Pulse second for builds or hosts where ALSA cannot
      // open (no alsa-plugins, a container, an ffmpeg built without it).
      return [
        { backend: "alsa", args: ["-f", "alsa", "-i", device ?? "default"], label: device ?? "default" },
        { backend: "pulse", args: ["-f", "pulse", "-i", "default"], label: "default" },
      ]
    case "win32": {
      // DirectShow, the one Windows capture input mainline ffmpeg has (there is no wasapi INPUT
      // device in ffmpeg; wasapi exists only in forks). It has no "default" alias, so the device
      // is named. The first one listed is the system's preferred input on every machine checked,
      // but that is DirectShow's ordering, not a promise — a named device always wins.
      const devices = listDshowAudioDevices(ffmpeg)
      const chosen = device
        ? devices.find((d) => d.name === device || d.alternative === device)
        : devices[0]
      if (!chosen) throw new TranscribeError(noMicrophoneMessage("win32", device))
      return [
        {
          backend: "dshow",
          // 50 ms buffers instead of DirectShow's default 500: the level meter would otherwise lag
          // half a second behind the voice, and the stop would cut the last half second.
          // The ALTERNATIVE name is stable and unique — two identical headsets share a friendly
          // name — and is plain ASCII, so no code page can mangle it on the way to ffmpeg.
          args: ["-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${chosen.alternative ?? chosen.name}`],
          label: chosen.name,
        },
      ]
    }
    default:
      throw new TranscribeError(unsupportedMessage(platform))
  }
}

/**
 * Can the sidecar record on this host, and if not, why — in words for THIS platform. Answers
 * GET /transcribe/health. Never names a package manager the platform does not have.
 */
export function recorderReadiness(
  platform: string = process.platform,
  ffmpeg: string | null = ffmpegPath(),
): { sidecar: boolean; reason?: string } {
  if (!SUPPORTED.has(platform)) return { sidecar: false, reason: unsupportedMessage(platform) }
  if (!ffmpeg) return { sidecar: false, reason: missingFfmpegMessage(platform) }
  if (platform === "win32") {
    try {
      inputCandidates(platform, ffmpeg)
    } catch (e) {
      return { sidecar: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  if (platform === "linux") {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-devices"], { encoding: "utf8", timeout: 5000 })
    const inputs = parseFfmpegDevices(r.stdout ?? "")
    // An empty list means the listing itself failed; let the recording try and report its own error.
    if (inputs.length && !inputs.includes("alsa") && !inputs.includes("pulse"))
      return {
        sidecar: false,
        reason:
          "This copy of ffmpeg cannot record audio: it was built without ALSA or PulseAudio input. Install your distribution's package (sudo apt install ffmpeg), then restart IRIS.",
      }
  }
  return { sidecar: true }
}

/** Begin capture. Streams 16 kHz mono PCM — already exactly what whisper wants. */
export function startCapture(device?: string): { startedAt: number } {
  if (active) throw new TranscribeError("Already recording.")

  // PLATFORM FIRST, ffmpeg SECOND. A Windows user was once told to install ffmpeg on a build that
  // could not record on Windows at all, installed it, and got the identical error — an error that
  // survives its own remedy. Ask whether this platform has a backend before naming a missing tool.
  if (!SUPPORTED.has(process.platform)) throw new TranscribeError(unsupportedMessage(process.platform))
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new TranscribeError(missingFfmpegMessage(process.platform))
  const [first, ...fallbacks] = inputCandidates(process.platform, ffmpeg, device)

  active = { proc: undefined as unknown as ChildProcess, ffmpeg, input: first!, fallbacks, chunks: [], bytes: 0, startedAt: Date.now(), stderr: [] }
  spawnInput(active, first!)
  return { startedAt: active.startedAt }
}

function spawnInput(session: Active, input: CaptureInput) {
  const proc = spawn(
    session.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      ...input.args,
      // pan, NOT `-ac 1`. The default macOS input here is a 17-channel aggregate ("Stream Mic
      // Collection"), and -ac 1 fails on it outright:
      //   "Rematrix is needed between 17 channels and mono but there is not enough
      //    information to do it" -> "Nothing was written into output file"
      // pan takes channel 0 and needs no layout information, so it works on both a plain
      // mono mic and a multi-channel aggregate (and on DirectShow's usual stereo 44.1 kHz).
      "-af",
      "pan=mono|c0=c0",
      "-ar",
      "16000",
      // RAW PCM, not WAV: a WAV header needs the final size, so ffmpeg writes nothing usable until
      // a clean exit, and an interrupted recording came back as 0 bytes. Raw s16le has no header —
      // every byte is usable even if the process is killed. The RIFF header is added at stop.
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      // Without this ffmpeg buffers its output and nothing arrives until the end — measured. The
      // level meter reads this stream live, and a stop must not wait on a buffer.
      "-flush_packets",
      "1",
      // A hard cap so a forgotten recording cannot run forever.
      "-t",
      String(MAX_SECONDS),
      // STDOUT, not a file: the same bytes feed the level meter (GET /dictate/level) and the
      // recording, with no second process and nothing of someone's voice left on disk.
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  session.proc = proc
  session.input = input

  proc.stdout?.on("data", (b: Buffer) => {
    session.chunks.push(b)
    session.bytes += b.length
  })
  proc.stderr?.on("data", (b: Buffer) => {
    session.stderr.push(b.toString())
    if (session.stderr.length > 80) session.stderr.shift()
  })
  // An input that dies before producing a single byte could not open the device (ALSA absent, a
  // pulse-only host): hand over to the next one while the person is still talking. Not once
  // audio has flowed — that is a recording ending, and the stop reports it.
  const next = () => {
    if (active !== session || session.proc !== proc || session.bytes > 0) return
    const fallback = session.fallbacks.shift()
    if (fallback) spawnInput(session, fallback)
  }
  proc.on("close", next)
  proc.on("error", next)
}

/**
 * Loudness of roughly the last 50 ms of the active recording: RMS, 0..1. `{0, 0}` when idle.
 * Read from the stream already being collected — the meter costs a few hundred multiplies.
 */
export function currentLevel(): { level: number; seconds: number } {
  const current = active
  if (!current) return { level: 0, seconds: 0 }
  return {
    level: tailRms(current.chunks, current.bytes, LEVEL_WINDOW_BYTES),
    seconds: Math.round((Date.now() - current.startedAt) / 100) / 10,
  }
}

/**
 * RMS of the last `want` bytes of s16le spread over chunks. Pipe reads do not respect sample
 * boundaries, so alignment is taken from the absolute byte position, not from the chunk.
 */
function tailRms(chunks: Buffer[], total: number, want: number) {
  const parts: Buffer[] = []
  let n = 0
  for (let i = chunks.length - 1; i >= 0 && n < want; i--) {
    parts.unshift(chunks[i]!)
    n += chunks[i]!.length
  }
  const buf = Buffer.concat(parts)
  const base = total - buf.length
  const from = Math.max(0, buf.length - want)
  const start = (base + from) % 2 ? from + 1 : from
  const end = (base + buf.length) % 2 ? buf.length - 1 : buf.length
  const samples = Math.floor((end - start) / 2)
  if (samples <= 0) return 0
  let sum = 0
  for (let i = start; i + 1 < end; i += 2) {
    const v = buf.readInt16LE(i) / 0x8000
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / samples))
}

/**
 * Stop capture and return the recorded WAV.
 *
 * SIGINT first so ffmpeg flushes what it holds; the stream means nothing already read can be lost
 * even if it has to be killed. (On Windows, Node's SIGINT is TerminateProcess — still safe for
 * the same reason.)
 */
export async function stopCapture(): Promise<{ audio: Uint8Array; ms: number; input: string }> {
  const current = active
  if (!current) throw new TranscribeError("Not recording.")
  active = undefined

  const proc = current.proc
  if (proc.exitCode === null && proc.signalCode === null) {
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      proc.on("close", done)
      proc.on("error", done)
      proc.kill("SIGINT")
      // If ffmpeg ignores SIGINT we still return rather than hanging the request. Short, because
      // -flush_packets means everything spoken has ALREADY arrived; this waits for an exit.
      setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {
          /* already gone */
        }
        done()
      }, 700)
    })
  }

  if (current.bytes === 0) {
    // Report what ffmpeg actually said. "No audio" on its own sent me hunting the microphone
    // when the real message was a channel-layout error on a 17-channel aggregate device.
    const said = current.stderr
      .join("")
      .split(/\r?\n/)
      .filter((l) => /error|invalid|failed|denied|not permitted|cannot|could not|Nothing was written/i.test(l))
      .slice(-3)
      .join(" | ")
      .trim()
    throw new TranscribeError(
      said
        ? `The recorder captured nothing. ffmpeg said: ${said}`
        : `The recorder captured no audio. Check the input device in ${soundSettingsHint(process.platform)}.`,
    )
  }
  return {
    audio: wrapPcmAsWav(new Uint8Array(Buffer.concat(current.chunks))),
    ms: Date.now() - current.startedAt,
    input: current.input.backend,
  }
}

/** Where THIS platform keeps its input-device setting — for errors that end in "check the mic". */
export function soundSettingsHint(platform: string = process.platform) {
  if (platform === "darwin") return "System Settings › Sound › Input"
  if (platform === "win32") return "Windows Settings > System > Sound > Input"
  return "your system's sound settings (Settings > Sound > Input)"
}

function unsupportedMessage(platform: string) {
  return `IRIS cannot record from the microphone outside the app window on ${platform}.`
}

/** Name a remedy that exists on THIS operating system — "brew install" on Windows cannot work. */
function missingFfmpegMessage(platform: string) {
  if (platform === "win32")
    return "The backup recorder needs ffmpeg, which is not installed. Install it with: winget install Gyan.FFmpeg — then restart IRIS."
  if (platform === "darwin")
    return "Recording needs ffmpeg, which is not installed. Install it with: brew install ffmpeg — then restart IRIS."
  return "Recording needs ffmpeg, which is not installed. Install it with: sudo apt install ffmpeg (or your distribution's package manager) — then restart IRIS."
}

function noMicrophoneMessage(platform: string, device?: string) {
  if (device) return `The microphone "${device}" was not found. Check that it is plugged in, or pick another in ${soundSettingsHint(platform)}.`
  return `No microphone was found. Plug one in, or turn one on in ${soundSettingsHint(platform)}, then try again.`
}

/**
 * Microphones this host can record from, by NAME — what the Settings picker shows and stores.
 * Names, not ids: the window recorder sees browser deviceIds and this recorder sees ffmpeg devices,
 * so a name is the only key both sides can resolve (see resolveCaptureDevice).
 */
export function listInputDevices(platform: string = process.platform, ffmpeg = ffmpegPath()): string[] {
  if (platform === "linux") return alsaCaptureDevices().map((d) => d.name)
  if (!ffmpeg) return []
  if (platform === "win32") return listDshowAudioDevices(ffmpeg).map((d) => d.name)
  if (platform !== "darwin") return []
  const r = spawnSync(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf8",
    timeout: 5000,
  })
  return parseAvfoundationAudioDevices(r.stderr ?? "")
}

/**
 * The device argument inputCandidates() wants for a microphone NAME, or undefined when that mic
 * is not present (the caller then records from the default rather than failing the take).
 * avfoundation and dshow take the name itself; ALSA wants a hardware id.
 */
export function resolveCaptureDevice(
  name: string | undefined,
  platform: string = process.platform,
  ffmpeg = ffmpegPath(),
): string | undefined {
  const wanted = name?.trim()
  if (!wanted) return undefined
  if (platform === "linux") return alsaCaptureDevices().find((d) => d.name === wanted)?.id
  return listInputDevices(platform, ffmpeg).includes(wanted) ? wanted : undefined
}

/** `ffmpeg -f avfoundation -list_devices true -i ""` stderr: the entries under the audio header. */
export function parseAvfoundationAudioDevices(stderr: string): string[] {
  const out: string[] = []
  let inAudio = false
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true
      continue
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudio = false
      continue
    }
    const m = inAudio ? line.match(/\]\s*\[(\d+)\]\s+(.+?)\s*$/) : undefined
    if (m) out.push(m[2]!.trim())
  }
  return out
}

/**
 * ALSA capture PCMs from /proc/asound/pcm, e.g. "00-02: ALC3234 Alt Analog : ALC3234 Alt Analog :
 * capture 1" -> { id: "plughw:0,2", name: "ALC3234 Alt Analog" }. plughw (not hw) so ALSA converts to
 * the 16 kHz mono the recorder asks for. Reading /proc needs no extra tool (arecord is often absent).
 */
export function parseAlsaPcm(text: string): Array<{ id: string; name: string }> {
  return text
    .split("\n")
    .map((line) => line.match(/^(\d+)-(\d+):\s*([^:]+?)\s*:.*\bcapture\b/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ id: `plughw:${Number(m[1])},${Number(m[2])}`, name: m[3]!.trim() }))
}

function alsaCaptureDevices() {
  try {
    return parseAlsaPcm(readFileSync("/proc/asound/pcm", "utf8"))
  } catch {
    return []
  }
}

function listDshowAudioDevices(ffmpeg: string) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
    encoding: "utf8",
    timeout: 5000,
  })
  return parseDshowAudioDevices(r.stderr ?? "")
}

/**
 * Audio devices from `ffmpeg -list_devices true -f dshow -i dummy` (printed on stderr). Two
 * formats exist in the wild:
 *   ffmpeg 5+:  [dshow @ 0x..] "Microphone Array (Realtek(R) Audio)" (audio)
 *   ffmpeg 4:   [dshow @ 0x..] DirectShow audio devices        <- section header
 *               [dshow @ 0x..]  "Microphone Array (Realtek(R) Audio)"
 * each followed by an `Alternative name "@device_cm_{...}"` line.
 */
export function parseDshowAudioDevices(stderr: string): Array<{ name: string; alternative?: string }> {
  const out: Array<{ name: string; alternative?: string }> = []
  let section: "audio" | "video" | undefined
  let last: { name: string; alternative?: string } | undefined
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]*\]\s?/, "")
    if (/DirectShow audio devices/i.test(line)) {
      section = "audio"
      continue
    }
    if (/DirectShow video devices/i.test(line)) {
      section = "video"
      continue
    }
    const alt = line.match(/^\s*Alternative name\s+"(.+)"\s*$/)
    if (alt) {
      if (last) last.alternative = alt[1]
      continue
    }
    const device = line.match(/^\s*"(.+)"\s*(?:\(([^)]*)\))?\s*$/)
    if (!device) continue
    const kind = device[2]
    const audio = kind !== undefined ? /\baudio\b/i.test(kind) : section === "audio"
    last = audio ? { name: device[1]! } : undefined
    if (last) out.push(last)
  }
  return out
}

/** Input (demuxing) device names from `ffmpeg -devices`: the rows flagged "D". */
export function parseFfmpegDevices(stdout: string): string[] {
  // Rows are " DE alsa  ALSA audio output": a space, the D and E flag columns, a space, the name.
  return stdout.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^ D[E ] (\S+)/)
    return m ? m[1]!.split(",") : []
  })
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
