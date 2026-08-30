import { createSignal, onCleanup } from "solid-js"

/**
 * Push-to-talk dictation against the LOCAL server this app already runs.
 *
 * The desktop spawns the CLI as a sidecar and talks to it over HTTP, so dictation needs no
 * new process and no cloud account: the webview captures audio, posts it to the sidecar's
 * /transcribe, and whisper.cpp transcribes it on this machine. The audio reaches 127.0.0.1
 * and nowhere else, and that route has no network client behind it (epic #182784).
 *
 * ## Why this does not use MediaRecorder
 *
 * It did, twice, and both shipped broken.
 *
 *   1. Default container -> WKWebView produced ZERO bytes (it has no webm at all).
 *   2. Explicitly audio/mp4, which `isTypeSupported` reports as supported -> STILL zero bytes.
 *
 * So the container was never the problem: MediaRecorder in this webview reports support it
 * does not deliver. Negotiating with it a third time would be guessing.
 *
 * Web Audio has no such negotiation. We take raw PCM off the graph, downsample it, and write
 * the WAV header ourselves — nothing to detect, nothing to support. It also happens to be
 * what whisper wants (16 kHz mono PCM), so the server transcodes nothing.
 */

/** whisper's native rate. Sending anything else just makes ffmpeg resample it. */
const TARGET_RATE = 16000

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

/** Average-and-pick downsample. Speech at 16 kHz does not need a windowed filter. */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]!
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

/** 16-bit PCM WAV. Written by hand so no codec has to be supported by anything. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  str(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  str(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Blob([buffer], { type: "audio/wav" })
}

export function createDictation(opts: DictationOptions) {
  const [phase, setPhase] = createSignal<DictationPhase>("idle")
  // A moving number is the difference between "recording" and "hung".
  const [seconds, setSeconds] = createSignal(0)

  let stream: MediaStream | undefined
  let audioCtx: AudioContext | undefined
  let processor: ScriptProcessorNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let captured: Float32Array[] = []
  let capturedRate = TARGET_RATE
  let timeout: ReturnType<typeof setTimeout> | undefined
  let ticker: ReturnType<typeof setInterval> | undefined

  function teardown() {
    if (timeout) clearTimeout(timeout)
    if (ticker) clearInterval(ticker)
    timeout = undefined
    ticker = undefined
    try {
      processor?.disconnect()
      source?.disconnect()
    } catch {
      /* already torn down */
    }
    processor = undefined
    source = undefined
    void audioCtx?.close().catch(() => {})
    audioCtx = undefined
    // Stopping the tracks is what turns the OS recording indicator off. Leaving them live is
    // the kind of thing nobody notices until it is a support ticket about the orange dot.
    stream?.getTracks().forEach((t) => t.stop())
    stream = undefined
  }

  function fail(message: string) {
    teardown()
    captured = []
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

    if (stream.getAudioTracks().length === 0) return fail("That input device produced no audio track.")

    try {
      const Ctor: typeof AudioContext =
        (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor()
      // Autoplay policy can hand back a suspended context; a suspended graph never pulls the
      // processor and every recording comes out empty.
      if (audioCtx.state === "suspended") await audioCtx.resume()

      capturedRate = audioCtx.sampleRate
      source = audioCtx.createMediaStreamSource(stream)
      // ScriptProcessor is deprecated in favour of AudioWorklet, and used deliberately: a
      // worklet needs a separately-loaded module, and this has to work inside a packaged
      // webview with no extra asset plumbing. It is supported everywhere we ship.
      processor = audioCtx.createScriptProcessor(4096, 1, 1)
      captured = []
      processor.onaudioprocess = (event) => {
        captured.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      // The graph only pulls a processor that reaches the destination — but routing the mic
      // to the speakers would echo it. A zero-gain node keeps it pulled and silent.
      const mute = audioCtx.createGain()
      mute.gain.value = 0
      source.connect(processor)
      processor.connect(mute)
      mute.connect(audioCtx.destination)
    } catch (e) {
      return fail(`Could not open the audio pipeline (${e instanceof Error ? e.message : String(e)}).`)
    }

    setSeconds(0)
    setPhase("recording")
    ticker = setInterval(() => setSeconds((n) => n + 1), 1000)
    timeout = setTimeout(() => stop(), (opts.maxSeconds ?? 300) * 1000)
  }

  function stop() {
    if (phase() !== "recording") return
    setPhase("transcribing")
    void transcribe()
  }

  async function transcribe() {
    const rate = capturedRate
    const frames = captured
    captured = []
    teardown()

    const total = frames.reduce((n, f) => n + f.length, 0)
    if (total === 0) {
      setPhase("idle")
      return opts.onError?.("No audio reached the recorder. Check the input device in System Settings › Sound.")
    }

    const merged = new Float32Array(total)
    let offset = 0
    for (const f of frames) {
      merged.set(f, offset)
      offset += f.length
    }
    const blob = encodeWav(downsample(merged, rate, TARGET_RATE), TARGET_RATE)

    const base = opts.url().replace(/\/$/, "")
    try {
      const res = await fetch(`${base}/transcribe?filename=dictation.wav`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
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
      if (!text) return opts.onError?.("That transcribed to nothing — try speaking a little louder.")
      opts.onTranscript(text)
    } catch (e) {
      setPhase("idle")
      // "Failed to fetch" names nothing actionable. The base URL is the whole diagnosis when
      // the app is pointed at a server that has no /transcribe (or none at all).
      const detail = e instanceof Error ? e.message : String(e)
      opts.onError?.(/fetch/i.test(detail) ? `Could not reach ${base} — is that server running?` : detail)
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
