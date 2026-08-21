import { spawn, spawnSync } from "child_process"
import { existsSync, mkdirSync, unlinkSync } from "fs"
import { homedir, platform } from "os"
import { join } from "path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { bold, dim, highlight, success } from "./iris-api"
import { runLocalWhisper } from "./transcribe"

/**
 * iris listen — talk to the machine, watch it hear you.
 *
 * WHY THIS EXISTS. `iris transcribe` has always been able to turn audio into text, and
 * `playbook draft` / `sop draft` turn that text into a procedure. The missing step was the
 * most basic one: getting the audio in the first place. You had to already have a file, which
 * meant opening Voice Memos, finding where it saved, and passing a path — three steps in
 * another application before the one command you wanted.
 *
 * WHY THE METER, SPECIFICALLY. A recorder with no feedback is a recorder you do not trust.
 * The failure it prevents is not cosmetic: a muted input, the wrong device selected, or a lid
 * closed over the mic all look EXACTLY like a working recorder until the transcript comes back
 * empty — by which point the thing you were saying is gone. A bar that moves when you speak
 * turns a silent, unrecoverable failure into an obvious one, before it costs you anything.
 * That is the same argument as everything else in this codebase: make the third state visible.
 *
 * WHAT IT DOES NOT DO. It does not transcribe. It records, and hands the file to
 * `runLocalWhisper` — the same function `iris transcribe` uses, so the device default, the
 * brand glossary, treatments, the save location and the knowledge-base sync all stay in ONE
 * place. A second copy of that decision tree is a second thing to forget to update.
 *
 *   iris listen                         record, press Enter to stop, transcribe on-device
 *   iris listen --seconds 30            fixed length, no keypress — for scripts and cron
 *   iris listen --treatment meeting     hand the transcript to a treatment
 *   iris listen --list-devices          what this machine can hear
 */

/** Where the raw capture lands. Kept out of the CWD — see #152293, it littered git repos. */
const CAPTURE_DIR = join(homedir(), ".iris", "recordings")

/**
 * The dB window the meter maps onto its bar.
 *
 * Measured on a MacBook Pro internal mic: room silence sits around -60 dBFS and ordinary
 * speech lands between -45 and -35. Anchoring the floor at -60 rather than at ffmpeg's true
 * -inf keeps the bar dead-still in a quiet room instead of shimmering on noise, which is what
 * makes movement mean something.
 */
const DB_FLOOR = -60
const DB_CEIL = -10

/** Redraws per second. The source emits ~86/s, which is both unreadable and a waste of a TTY. */
const FPS = 12

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf-8" })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * Audio input devices, as avfoundation numbers them.
 *
 * BY NAME, NEVER BY INDEX, at the call site. The indices are assigned in enumeration order,
 * so plugging in an interface or enabling BlackHole renumbers everything below it — a
 * hardcoded `:1` silently starts recording a different device, and a recorder that captures
 * the wrong input is indistinguishable from one that works until the transcript is wrong.
 */
export function listAudioDevices(): Array<{ index: number; name: string }> {
  if (platform() !== "darwin") return []
  const r = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf-8",
  })
  // ffmpeg exits non-zero here by design: listing devices IS an "error opening input".
  const out = `${r.stderr ?? ""}`
  const audioSection = out.split("AVFoundation audio devices:")[1]
  if (!audioSection) return []

  const devices: Array<{ index: number; name: string }> = []
  for (const line of audioSection.split("\n")) {
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (!m) continue
    devices.push({ index: Number(m[1]), name: m[2] })
  }
  return devices
}

/**
 * Pick the input to record from.
 *
 * Prefers a real microphone over a loopback device. BlackHole and similar virtual devices
 * routinely enumerate FIRST, and they carry system audio, not your voice — so defaulting to
 * index 0 records silence on a machine that is working perfectly.
 */
export function resolveDevice(devices: Array<{ index: number; name: string }>, requested?: string) {
  if (requested) {
    const needle = requested.toLowerCase()
    const hit = devices.find((d) => d.name.toLowerCase().includes(needle))
    return hit ?? null
  }
  const mic = devices.find((d) => /microphone|mic\b|input/i.test(d.name) && !/blackhole|loopback|soundflower|aggregate/i.test(d.name))
  return mic ?? devices.find((d) => !/blackhole|loopback|soundflower/i.test(d.name)) ?? devices[0] ?? null
}

/** dBFS → 0..1 across the window above. */
export function levelToUnit(db: number): number {
  if (!Number.isFinite(db)) return 0
  const clamped = Math.max(DB_FLOOR, Math.min(DB_CEIL, db))
  return (clamped - DB_FLOOR) / (DB_CEIL - DB_FLOOR)
}

const BAR_WIDTH = 28

export function renderMeter(unit: number, peak: number, elapsedMs: number): string {
  const filled = Math.round(unit * BAR_WIDTH)
  const peakCol = Math.min(BAR_WIDTH - 1, Math.round(peak * BAR_WIDTH))

  let bar = ""
  for (let i = 0; i < BAR_WIDTH; i++) {
    if (i === peakCol && peakCol >= filled) bar += "│"      // peak-hold tick
    else if (i < filled) bar += "█"
    else bar += "░"
  }

  const secs = Math.floor(elapsedMs / 1000)
  const mm = String(Math.floor(secs / 60)).padStart(2, "0")
  const ss = String(secs % 60).padStart(2, "0")
  const pct = String(Math.round(unit * 100)).padStart(3, " ")

  // Colour is the fastest read: is it moving, and is it too hot.
  const color = unit > 0.92 ? "\x1b[31m" : unit > 0.08 ? "\x1b[32m" : "\x1b[90m"
  return `  \x1b[31m●\x1b[0m REC ${mm}:${ss}  ${color}${bar}\x1b[0m ${pct}%`
}

/** Silence is a FAILURE MODE, not a quiet recording — say so rather than transcribing nothing. */
export function silenceWarning(peakSeen: number, device: string): string | null {
  if (peakSeen > 0.06) return null
  return (
    `Nothing above the noise floor on "${device}" for the whole recording.\n` +
    `  That usually means the input is muted, or another device is selected.\n` +
    `  Check: System Settings → Sound → Input, or run: iris listen --list-devices`
  )
}

export const PlatformListenCommand = cmd({
  command: "listen",
  aliases: ["dictate"],
  describe: "record from the microphone with a live level meter, then transcribe it",
  builder: (yargs) =>
    yargs
      .option("seconds", { type: "number", describe: "Record for a fixed length instead of waiting for Enter" })
      .option("device", { type: "string", describe: "Input device, matched by name (default: your microphone)" })
      .option("list-devices", { type: "boolean", default: false, describe: "Show what this machine can hear" })
      .option("keep", { type: "boolean", default: false, describe: "Keep the .wav after transcribing" })
      .option("language", { type: "string", describe: "ISO 639-1 language hint for Whisper (e.g. 'en')" })
      .option("remote", { type: "boolean", default: false, describe: "Transcribe on the server instead of on-device" })
      .option("brand", { type: "number", describe: "Brand id whose vocabulary to bias toward" })
      .option("treatment", { type: "string", describe: "What this recording IS: clean, notes, meeting, standup, captions, idea" })
      .option("output", { type: "string", describe: "Write the transcript here (file or dir)" })
      .option("json", { type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  Listen")

    if (platform() !== "darwin") {
      prompts.log.error("iris listen currently supports macOS only (avfoundation capture).")
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    if (!which("ffmpeg")) {
      prompts.log.error("ffmpeg is required to capture audio.\n  Install it with: brew install ffmpeg")
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const devices = listAudioDevices()
    if (args["list-devices"]) {
      if (devices.length === 0) prompts.log.warn("No audio input devices found.")
      for (const d of devices) console.log(`  ${dim(`[${d.index}]`)} ${bold(d.name)}`)
      prompts.outro("Done")
      return
    }

    const device = resolveDevice(devices, args.device as string | undefined)
    if (!device) {
      prompts.log.error(
        args.device
          ? `No input device matching "${args.device}". Run: iris listen --list-devices`
          : "No audio input device found. Run: iris listen --list-devices",
      )
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    mkdirSync(CAPTURE_DIR, { recursive: true })
    const wav = join(CAPTURE_DIR, `listen-${Date.now()}.wav`)

    const fixed = typeof args.seconds === "number" && args.seconds > 0
    const interactive = process.stdin.isTTY && !fixed

    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "avfoundation",
      "-i", `:${device.index}`,
      // 16 kHz mono is what whisper wants anyway, so the conversion happens once, here.
      "-ar", "16000",
      "-ac", "1",
      ...(fixed ? ["-t", String(args.seconds)] : []),
      // Levels go to STDOUT (`file=-`), which is why the wav cannot also go to stdout.
      "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-y", wav,
    ])

    const started = Date.now()
    let unit = 0
    let peak = 0
    let peakSeen = 0
    let stopping = false
    let drewMeter = false

    ff.stdout.setEncoding("utf-8")
    let carry = ""
    ff.stdout.on("data", (chunk: string) => {
      carry += chunk
      const lines = carry.split("\n")
      carry = lines.pop() ?? ""
      for (const line of lines) {
        const m = line.match(/RMS_level=(-?[\d.]+|-?inf)/)
        if (!m) continue
        const db = m[1] === "-inf" ? -Infinity : Number(m[1])
        const u = levelToUnit(db)
        unit = u
        if (u > peak) peak = u
        if (u > peakSeen) peakSeen = u
      }
    })

    let stderrTail = ""
    ff.stderr.setEncoding("utf-8")
    ff.stderr.on("data", (c: string) => { stderrTail = `${stderrTail}${c}`.slice(-800) })

    // ── the meter ────────────────────────────────────────────────────────────
    const canDraw = process.stdout.isTTY
    if (canDraw) {
      console.log(`  ${dim("device")}  ${bold(device.name)}`)
      console.log(
        `  ${dim(fixed ? `recording ${args.seconds}s…` : interactive ? "press Enter to stop" : "recording… Ctrl-C to stop")}`,
      )
      console.log("")
    }

    const timer = setInterval(() => {
      if (!canDraw || stopping) return
      process.stdout.write(`\r\x1b[2K${renderMeter(unit, peak, Date.now() - started)}`)
      drewMeter = true
      peak = Math.max(0, peak - 0.04)   // decay, so the tick trails the voice rather than sticking
    }, Math.round(1000 / FPS))

    // ── stopping ─────────────────────────────────────────────────────────────
    const stop = () => {
      if (stopping) return
      stopping = true
      // `q` is ffmpeg's graceful shutdown: it finalises the WAV header. SIGKILL leaves a file
      // whose length says zero, which whisper reads as an empty recording — the exact silent
      // failure this command exists to prevent.
      try { ff.stdin.write("q") } catch { /* already gone */ }
      setTimeout(() => { try { ff.kill("SIGTERM") } catch { /* already gone */ } }, 1500)
    }

    const onSigint = () => stop()
    process.on("SIGINT", onSigint)

    if (interactive) {
      process.stdin.setEncoding("utf-8")
      process.stdin.resume()
      process.stdin.once("data", () => stop())
    }

    const code: number = await new Promise((res) => {
      ff.on("close", (c) => res(c ?? 0))
      ff.on("error", () => res(1))
    })

    clearInterval(timer)
    process.off("SIGINT", onSigint)
    if (interactive) { try { process.stdin.pause() } catch { /* noop */ } }
    if (canDraw && drewMeter) process.stdout.write("\r\x1b[2K")

    const elapsed = ((Date.now() - started) / 1000).toFixed(1)

    if (!existsSync(wav)) {
      prompts.log.error(
        `Capture produced no file.${stderrTail.trim() ? `\n  ffmpeg: ${stderrTail.trim().split("\n").slice(-2).join(" ")}` : ""}` +
        `\n  If macOS has not asked for microphone access, grant it to your terminal in` +
        `\n  System Settings → Privacy & Security → Microphone.`,
      )
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    // A graceful `q` makes ffmpeg exit non-zero on some builds; the file is what matters.
    if (code !== 0 && !stopping && stderrTail.trim()) {
      prompts.log.warn(`ffmpeg exited ${code}: ${stderrTail.trim().split("\n").slice(-1)[0]}`)
    }

    console.log(`  ${success("✓")} Recorded ${bold(`${elapsed}s`)} ${dim(`→ ${wav}`)}`)

    const warn = silenceWarning(peakSeen, device.name)
    if (warn) prompts.log.warn(warn)

    // ── hand off to the ONE transcription path ───────────────────────────────
    const ok = await runLocalWhisper(
      wav,
      args.language as string | undefined,
      Boolean(args.json),
      undefined,
      args.output as string | undefined,
      args.brand as number | undefined,
      Boolean(args.remote),
      args.treatment as string | undefined,
    )

    if (!args.keep && ok) {
      // The transcript is the artifact; the wav is a 16 kHz intermediate. Kept on failure so a
      // transcription that fell over never costs you the recording.
      try { unlinkSync(wav) } catch { /* noop */ }
    } else if (!ok) {
      console.log(`  ${dim("recording kept at")} ${highlight(wav)}`)
    }

    if (!ok) process.exitCode = 1
    prompts.outro("Done")
  },
})
