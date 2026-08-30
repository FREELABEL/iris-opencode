import { createSignal, onCleanup } from "solid-js"

/**
 * Push-to-talk dictation against the LOCAL server this app already runs.
 *
 * The desktop app spawns the CLI as a sidecar and talks to it over HTTP, so dictation needs
 * no new process and no cloud account: the webview records, posts the audio to the sidecar's
 * /transcribe, and whisper.cpp transcribes it on this machine. The audio reaches 127.0.0.1
 * and nowhere else, and that route has no network client behind it (epic #182784).
 *
 * The blob is sent as the RAW body with the filename in the query string — not multipart.
 * Both ends are ours, and it keeps a multipart parser off a path that carries one file.
 */

export type DictationPhase = "idle" | "recording" | "transcribing"

export interface DictationOptions {
  /**
   * Base URL of the local server, read as a GETTER at request time — not a snapshot.
   * The selected server can change while the prompt is mounted, and a captured string keeps
   * posting to whichever server was chosen when it first rendered.
   */
  url: () => string
  onTranscript: (text: string) => void
  onError?: (message: string) => void
  /** Safety ceiling so a forgotten recording cannot run forever. */
  maxSeconds?: number
}

export function createDictation(opts: DictationOptions) {
  const [phase, setPhase] = createSignal<DictationPhase>("idle")
  // A moving number is the difference between "recording" and "hung".
  const [seconds, setSeconds] = createSignal(0)
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let chunks: Blob[] = []
  let timeout: ReturnType<typeof setTimeout> | undefined
  let ticker: ReturnType<typeof setInterval> | undefined

  function teardown() {
    if (timeout) clearTimeout(timeout)
    if (ticker) clearInterval(ticker)
    timeout = undefined
    ticker = undefined
    // Stopping the tracks is what turns the OS recording indicator off. Leaving them live is
    // the kind of thing nobody notices until it is a support ticket about the orange dot.
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
      // On macOS this is also how a missing audio-input entitlement or usage string looks,
      // so name both rather than only blaming the user's settings.
      return fail("Microphone access was refused. Allow it in System Settings › Privacy & Security › Microphone.")
    }

    chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => void transcribe()
    recorder.start()
    setSeconds(0)
    setPhase("recording")
    ticker = setInterval(() => setSeconds((n) => n + 1), 1000)
    timeout = setTimeout(() => stop(), (opts.maxSeconds ?? 300) * 1000)
  }

  function stop() {
    if (phase() !== "recording" || !recorder) return
    setPhase("transcribing")
    recorder.stop()
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

    const base = opts.url().replace(/\/$/, "")
    try {
      const res = await fetch(`${base}/transcribe?filename=dictation.webm`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: blob,
      })
      const body = await res.json().catch(() => null as any)

      if (!res.ok) {
        setPhase("idle")
        return opts.onError?.(body?.error || `Transcription failed (HTTP ${res.status})`)
      }
      // A 200 is not proof this route exists: an older server answers 200 (with the SPA's
      // HTML) to unknown POSTs. Report THAT rather than blaming the microphone.
      if (!body || typeof body.text !== "string") {
        setPhase("idle")
        return opts.onError?.(`${base} answered without a transcript — it may be an older server without /transcribe.`)
      }

      const text = body.text.trim()
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
    // "transcribing" is inert: a second click would race the in-flight request.
  }

  onCleanup(teardown)
  return { phase, seconds, toggle }
}
