import { createSignal, onCleanup } from "solid-js"
import { silenceWarning, startRecording, type Recording } from "@/cli/lib/mic"
import { transcribeAudio } from "@/cli/lib/transcription"
import { unlinkSync } from "fs"

/**
 * Dictation for the prompt — hold the mic open, show that it is open, drop the text in.
 *
 * WHY A HOOK AND NOT A COPY OF `iris listen`. Capture lives in cli/lib/mic.ts and is shared
 * verbatim; only the drawing differs. What is genuinely different here is the RATE: mic.ts
 * emits a level roughly 86 times a second, and a Solid signal set that often re-renders the
 * whole TUI 86 times a second for a bar that is 28 characters wide. So levels are accumulated
 * as a peak and flushed on a timer — the signal changes ~10x/sec, and the peak means a spike
 * between flushes is still drawn rather than averaged away.
 *
 * TRANSCRIPTION IS `transcribeAudio`, not `runLocalWhisper`. The CLI path prints, writes files
 * and syncs the knowledge base, all of which are wrong inside a TUI that owns the screen. This
 * one returns text and nothing else.
 */

/** Signal updates per second while recording. The source is ~8x faster than this. */
const FLUSH_HZ = 10

export interface DictationOptions {
  /** Called with the transcript once it is ready. */
  onText: (text: string) => void
  /** Called with anything the user needs to know — no device, no ffmpeg, silence, a failure. */
  onNotice: (message: string, kind: "info" | "warn" | "error") => void
  /**
   * Ask the host to repaint.
   *
   * OpenTUI does not repaint because a Solid signal changed — it repaints on input events and
   * on explicit request, which is why the existing status spinner is a dedicated renderable
   * with its own interval rather than a signal on a timer.
   *
   * MEASURED, and the first measurement was wrong in an instructive way. A probe that searched
   * the pty byte stream for a contiguous `mm:ss` reported the clock frozen at 00:00 — but a
   * diffing renderer rewrites only the digit that changed, so a ticking clock never re-emits
   * the whole string. The clock was fine. What a proper control run (this callback removed,
   * rebuilt, re-measured) actually showed is the real defect: the LEVEL BAR repainted about
   * three times a second on incidental renders, against the ten times a second it is sampled
   * at. Three is visibly behind your voice, which undermines the one thing the meter is for.
   *
   * So this stays — for that reason, not the one it was first written for.
   */
  onFrame?: () => void
}

export function createDictation(opts: DictationOptions) {
  const [active, setActive] = createSignal(false)
  const [transcribing, setTranscribing] = createSignal(false)
  const [level, setLevel] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)

  let rec: Recording | undefined
  let flush: ReturnType<typeof setInterval> | undefined
  let pending = 0
  let startedAt = 0

  function clearTimers() {
    if (flush) clearInterval(flush)
    flush = undefined
  }

  async function start() {
    if (active() || transcribing()) return
    try {
      rec = await startRecording({
        onLevel: (u) => {
          // Peak, not last: a clipping spike that lands between two flushes still shows.
          if (u > pending) pending = u
        },
      })
    } catch (e) {
      opts.onNotice(e instanceof Error ? e.message : String(e), "error")
      return
    }

    startedAt = Date.now()
    setLevel(0)
    setElapsed(0)
    setActive(true)

    flush = setInterval(
      () => {
        setLevel(pending)
        pending = Math.max(0, pending - 0.08) // decay so the bar falls rather than sticking
        setElapsed(Date.now() - startedAt)
        opts.onFrame?.()
      },
      Math.round(1000 / FLUSH_HZ),
    )
  }

  async function stop() {
    if (!active() || !rec) return
    const current = rec
    clearTimers()
    setActive(false)
    setLevel(0)
    opts.onFrame?.()

    const { elapsedMs, stderr } = await current.stop()
    rec = undefined

    if (elapsedMs < 400) {
      // Too short to contain speech, and whisper will hallucinate something plausible on it —
      // "(upbeat music)" is a real observed output on near-silence. Saying nothing is better
      // than inventing a sentence the user then has to notice and delete.
      try {
        unlinkSync(current.path)
      } catch {
        /* noop */
      }
      opts.onNotice("Too short — hold the key a moment longer.", "info")
      return
    }

    const quiet = silenceWarning(current.peakSeen(), current.device.name)
    if (quiet) {
      try {
        unlinkSync(current.path)
      } catch {
        /* noop */
      }
      opts.onNotice(quiet.split("\n")[0], "warn")
      return
    }

    setTranscribing(true)
    opts.onFrame?.()
    try {
      const result = await transcribeAudio(current.path)
      const text = (result.text ?? "").trim()
      if (!text) {
        opts.onNotice("Nothing was transcribed from that recording.", "warn")
        return
      }
      opts.onText(text)
    } catch (e) {
      // The recording is NOT deleted on a transcription failure — a failed transcribe must
      // never cost somebody the thing they said.
      const detail = e instanceof Error ? e.message : String(e)
      opts.onNotice(`Transcription failed: ${detail}. Recording kept at ${current.path}`, "error")
      return
    } finally {
      setTranscribing(false)
      opts.onFrame?.()
    }

    // Transcript is the artifact; the 16 kHz wav was an intermediate.
    try {
      unlinkSync(current.path)
    } catch {
      /* noop */
    }
    if (stderr.trim() && process.env.IRIS_DICTATE_DEBUG) opts.onNotice(stderr.trim().slice(-160), "info")
  }

  async function toggle() {
    if (active()) await stop()
    else await start()
  }

  onCleanup(() => {
    clearTimers()
    // Leaving ffmpeg holding the microphone after the TUI exits is the one failure here with
    // consequences outside this process — the mic indicator stays lit and the device stays busy.
    if (rec) void rec.stop().catch(() => {})
  })

  return { active, transcribing, level, elapsed, toggle, start, stop }
}

/** mm:ss for the dictation clock. */
export function formatDictationClock(elapsedMs: number): string {
  const secs = Math.floor(elapsedMs / 1000)
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`
}

/**
 * A 12-cell level bar. Narrow on purpose: it shares the footer with the agent and model names,
 * and a meter that pushes those off a narrow terminal has cost more than it gave.
 */
export function dictationBar(unit: number): string {
  const width = 12
  const filled = Math.max(0, Math.min(width, Math.round(unit * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}
