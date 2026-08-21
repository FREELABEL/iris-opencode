import { existsSync, unlinkSync } from "fs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { bold, dim, highlight, success } from "./iris-api"
import { runLocalWhisper } from "./transcribe"
import { listAudioDevices, silenceWarning, startRecording } from "../lib/mic"

/**
 * iris listen — talk to the machine, watch it hear you.
 *
 * WHY THIS EXISTS. `iris transcribe` has always turned audio into text, and `playbook draft` /
 * `sop draft` turn that text into a procedure. The missing step was the first one: getting the
 * audio. You had to already have a file — open Voice Memos, find where it saved, pass the path.
 * Three steps in another application before the one command you wanted.
 *
 * WHY THE METER, SPECIFICALLY. A recorder with no feedback is a recorder you cannot trust, and
 * the failure it prevents is silent: a muted input, the wrong device selected, a lid closed over
 * the mic — all of them look EXACTLY like a working recorder until the transcript comes back
 * empty, by which point the thing you were saying is gone. A bar that moves when you speak turns
 * an unrecoverable failure into an obvious one, before it costs anything.
 *
 * Capture lives in cli/lib/mic.ts, shared with the TUI's dictate keybind. Transcription is
 * `runLocalWhisper`, the same function `iris transcribe` calls, so the on-device default, the
 * brand glossary, treatments, the save location and the knowledge-base sync stay in ONE place.
 *
 *   iris listen                         record, press Enter to stop, transcribe on-device
 *   iris listen --seconds 30            fixed length, no keypress — for scripts and cron
 *   iris listen --treatment meeting     hand the transcript to a treatment
 *   iris listen --list-devices          what this machine can hear
 */

/** Redraws per second. The source emits ~86/s, which is unreadable and a waste of a TTY. */
const FPS = 12
const BAR_WIDTH = 28

export function renderMeter(unit: number, peak: number, elapsedMs: number): string {
  const filled = Math.round(unit * BAR_WIDTH)
  const peakCol = Math.min(BAR_WIDTH - 1, Math.round(peak * BAR_WIDTH))

  let bar = ""
  for (let i = 0; i < BAR_WIDTH; i++) {
    if (i === peakCol && peakCol >= filled)
      bar += "│" // peak-hold tick
    else if (i < filled) bar += "█"
    else bar += "░"
  }

  const secs = Math.floor(elapsedMs / 1000)
  const mm = String(Math.floor(secs / 60)).padStart(2, "0")
  const ss = String(secs % 60).padStart(2, "0")
  const pct = String(Math.round(unit * 100)).padStart(3, " ")

  const color = unit > 0.92 ? "\x1b[31m" : unit > 0.08 ? "\x1b[32m" : "\x1b[90m"
  return `  \x1b[31m●\x1b[0m REC ${mm}:${ss}  ${color}${bar}\x1b[0m ${pct}%`
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
      .option("treatment", {
        type: "string",
        describe: "What this recording IS: clean, notes, meeting, standup, captions, idea",
      })
      .option("output", { type: "string", describe: "Write the transcript here (file or dir)" })
      .option("json", { type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  Listen")

    if (args["list-devices"]) {
      const devices = listAudioDevices()
      if (devices.length === 0) prompts.log.warn("No audio input devices found.")
      for (const d of devices) console.log(`  ${dim(`[${d.index}]`)} ${bold(d.name)}`)
      prompts.outro("Done")
      return
    }

    const fixed = typeof args.seconds === "number" && args.seconds > 0
    const interactive = Boolean(process.stdin.isTTY) && !fixed
    const canDraw = Boolean(process.stdout.isTTY)

    let unit = 0
    let peak = 0

    let rec
    try {
      rec = await startRecording({
        device: args.device as string | undefined,
        seconds: fixed ? (args.seconds as number) : undefined,
        onLevel: (u) => {
          unit = u
          if (u > peak) peak = u
        },
      })
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    const started = Date.now()
    let drew = false

    if (canDraw) {
      console.log(`  ${dim("device")}  ${bold(rec.device.name)}`)
      console.log(
        `  ${dim(fixed ? `recording ${args.seconds}s…` : interactive ? "press Enter to stop" : "recording… Ctrl-C to stop")}`,
      )
      console.log("")
    }

    const timer = setInterval(
      () => {
        if (!canDraw) return
        process.stdout.write(`\r\x1b[2K${renderMeter(unit, peak, Date.now() - started)}`)
        drew = true
        peak = Math.max(0, peak - 0.04) // decay, so the tick trails the voice rather than sticking
      },
      Math.round(1000 / FPS),
    )

    let stopped = false
    const finish = () => {
      if (stopped) return
      stopped = true
      void rec.stop()
    }
    const onSigint = () => finish()
    process.on("SIGINT", onSigint)
    if (interactive) {
      process.stdin.setEncoding("utf-8")
      process.stdin.resume()
      process.stdin.once("data", () => finish())
    }

    const { elapsedMs, stderr } = await rec.stop()

    clearInterval(timer)
    process.off("SIGINT", onSigint)
    if (interactive) {
      try {
        process.stdin.pause()
      } catch {
        /* noop */
      }
    }
    if (canDraw && drew) process.stdout.write("\r\x1b[2K")

    if (!existsSync(rec.path)) {
      prompts.log.error(
        `Capture produced no file.${stderr.trim() ? `\n  ffmpeg: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}` +
          `\n  If macOS has not asked for microphone access, grant it to your terminal in` +
          `\n  System Settings → Privacy & Security → Microphone.`,
      )
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    console.log(`  ${success("✓")} Recorded ${bold(`${(elapsedMs / 1000).toFixed(1)}s`)} ${dim(`→ ${rec.path}`)}`)

    const warn = silenceWarning(rec.peakSeen(), rec.device.name)
    if (warn) prompts.log.warn(warn)

    const ok = await runLocalWhisper(
      rec.path,
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
      try {
        unlinkSync(rec.path)
      } catch {
        /* noop */
      }
    } else if (!ok) {
      console.log(`  ${dim("recording kept at")} ${highlight(rec.path)}`)
    }

    if (!ok) process.exitCode = 1
    prompts.outro("Done")
  },
})
