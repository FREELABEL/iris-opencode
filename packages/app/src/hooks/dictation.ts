import { createSignal, onCleanup } from "solid-js"

/**
 * Push-to-talk dictation against the LOCAL opencode server.
 *
 * Audio is recorded in the webview and POSTed to the server's own /transcribe route, which
 * runs whisper.cpp on this machine. Two consequences worth stating plainly:
 *
 *  1. The audio never leaves the box. It travels to 127.0.0.1 and nowhere else, and the
 *     route has no cloud branch to reach — so no provider setting can make it upload.
 *  2. It works when nothing else does. Every cloud transcription provider was dead as of
 *     2026-08-29 (#182830); this path does not use them.
 *
 * The recording is held in memory and dropped as soon as the transcript comes back. Nothing
 * is written to disk on this side; the server writes to a 0700 dir it removes in a finally.
 */

export type DictationPhase = "idle" | "recording" | "transcribing"

export interface DictationOptions {
  /** Base URL of the local opencode server (sdk.url). */
  url: string
  /** Called with the finished transcript. Only fires for a non-empty result. */
  onTranscript: (text: string) => void
  /** Called with a human-readable reason. Never throws at the caller. */
  onError?: (message: string) => void
  /** Safety ceiling so a forgotten recording cannot run forever. */
  maxSeconds?: number
}

export function createDictation(opts: DictationOptions) {
  const [phase, setPhase] = createSignal<DictationPhase>("idle")
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let chunks: Blob[] = []
  let timeout: ReturnType<typeof setTimeout> | undefined

  function teardown() {
    if (timeout) clearTimeout(timeout)
    timeout = undefined
    // Releasing the tracks is what turns off the OS recording indicator. Leaving them live
    // is the kind of thing nobody notices until it is a support ticket about the orange dot.
    stream?.getTracks().forEach((t) => t.stop())
    stream = undefined
    recorder = undefined
  }

  function fail(message: string) {
    teardown()
    chunks = []
    setPhase("idle")
    opts.onError?.(message)
  }

  async function start() {
    if (phase() !== "idle") return
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return fail("This build cannot open a microphone.")
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      // On macOS this is also what a missing NSMicrophoneUsageDescription / audio-input
      // entitlement looks like, so name both causes rather than only blaming the user.
      return fail("Microphone access was refused. Allow it in System Settings › Privacy & Security › Microphone.")
    }

    chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => void transcribe()
    recorder.start()
    setPhase("recording")

    timeout = setTimeout(() => stop(), (opts.maxSeconds ?? 300) * 1000)
  }

  function stop() {
    if (phase() !== "recording" || !recorder) return
    setPhase("transcribing")
    recorder.stop() // fires onstop -> transcribe()
  }

  async function transcribe() {
    const type = recorder?.mimeType || "audio/webm"
    const blob = new Blob(chunks, { type })
    chunks = []
    teardown()

    if (blob.size === 0) {
      setPhase("idle")
      return opts.onError?.("Nothing was recorded.")
    }

    try {
      const form = new FormData()
      form.append("audio", blob, "dictation.webm")
      const res = await fetch(`${opts.url.replace(/\/$/, "")}/transcribe`, { method: "POST", body: form })
      const body = await res.json().catch(() => ({}) as any)

      if (!res.ok) {
        // The server's message already names the real cause — whisper-cpp missing, a
        // loopback refusal — so it is shown verbatim rather than flattened into "failed".
        setPhase("idle")
        return opts.onError?.(body?.error || `Transcription failed (HTTP ${res.status})`)
      }

      const text = String(body?.text ?? "").trim()
      setPhase("idle")
      if (!text) return opts.onError?.("That transcribed to nothing — check the input device and try again.")
      opts.onTranscript(text)
    } catch (e) {
      setPhase("idle")
      opts.onError?.(e instanceof Error ? e.message : "Transcription failed.")
    }
  }

  function toggle() {
    if (phase() === "recording") stop()
    else if (phase() === "idle") void start()
    // "transcribing" is deliberately inert: a second click there would race the in-flight
    // request and there is nothing useful to cancel.
  }

  onCleanup(teardown)

  return { phase, start, stop, toggle }
}
