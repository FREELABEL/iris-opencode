import { createSignal, onCleanup } from "solid-js"
import { captureIsLive } from "./dictation-probe"

/**
 * Push-to-talk dictation.
 *
 * ## Two capture paths, chosen by MEASUREMENT rather than by platform
 *
 * The webview can record on some hosts and not others, and the difference is not something you
 * can read off `navigator.platform`:
 *
 *   - Windows/Linux run a Chromium webview (WebView2 / WebKitGTK) and getUserMedia behaves.
 *   - macOS runs WKWebView, where Tauri implements no WKUIDelegate media-capture callback, so
 *     WebKit never grants the request. Critically it does NOT throw — it resolves with a track
 *     that emits nothing. Measured in the shipped app: a 10-second recording, peak 0.0000,
 *     with the app's microphone permission granted and the entitlement present.
 *
 * A permission that fails by returning silence cannot be feature-detected, only measured. So we
 * record a short probe and look at the actual samples. If the webview really captures we use
 * it; if it hands back silence we fall back to the sidecar, which is an ordinary OS process
 * holding the same microphone grant.
 *
 * Choosing this way rather than `if (platform === "macos")` means the day Tauri wires up the
 * WebKit delegate, macOS silently upgrades to the cheaper path with no code change. And on
 * Windows it removes the ffmpeg dependency entirely — the sidecar path needs ffmpeg to record,
 * the webview path needs nothing.
 *
 * The probe result is cached for the session: the first dictation pays ~400ms, the rest do not.
 */

const PROBE_MS = 400
/** ~-40 dBFS: quieter than speech, louder than a noise floor. */
const SILENCE_FLOOR = 0.01
const TARGET_RATE = 16000

/** Waits before each automatic retry of a held recording; after the last, retries are manual. */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000, 180_000]

export type DictationPhase = "idle" | "recording" | "transcribing"
/** A recording the server saved because every engine failed — retryable without re-recording. */
export type HeldRecording = { id: string; seconds: number }
type CaptureMode = "webview" | "sidecar"

/** Remembered across dictations; null until the first probe has run. */
let cachedMode: CaptureMode | null = null

/**
 * Can the sidecar record on this host at all? Only where the webview is WKWebView (macOS) — or
 * Linux, where the sidecar has an ALSA branch. On Windows the sidecar has no capture backend by
 * design (capture.ts inputArgs), so falling back to it can only produce an error, and the one it
 * produced was "Recording needs ffmpeg": advice about a tool the Windows path never uses, which
 * hid the real fault (the window's own microphone request). On Windows the webview is the ONLY
 * recorder — if it cannot open the mic, say why, and never mention ffmpeg.
 */
function sidecarCanRecord(): boolean {
  if (typeof navigator === "undefined") return true
  return !/Windows/i.test(navigator.userAgent)
}

/** Turn a getUserMedia rejection into something a person can act on. */
function micOpenError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ""
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "IRIS was denied the microphone. Open Windows Settings > Privacy & security > Microphone, turn on \"Let desktop apps access your microphone\", then try again."
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Plug one in or pick an input device in Windows sound settings, then try again."
    case "NotReadableError":
    case "AbortError":
      return "The microphone is in use by another app or the driver refused it. Close other apps using the mic and try again."
    default: {
      const detail = err instanceof Error ? err.message : String(err ?? "")
      return `Could not open the microphone${detail ? `: ${detail}` : "."}`
    }
  }
}

export interface DictationOptions {
  /** Base URL of the local server, read as a GETTER at request time — not a snapshot. */
  url: () => string
  onTranscript: (text: string) => void
  onError?: (message: string) => void
}

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

/** 16-bit PCM WAV, written by hand so no codec has to be supported by anything. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const str = (o: number, v: string) => {
    for (let i = 0; i < v.length; i++) view.setUint8(o + i, v.charCodeAt(i))
  }
  str(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  str(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true)
  }
  return new Blob([buffer], { type: "audio/wav" })
}

export function createDictation(opts: DictationOptions) {
  const [phase, setPhase] = createSignal<DictationPhase>("idle")
  // A moving number is the difference between "recording" and "hung".
  const [seconds, setSeconds] = createSignal(0)
  let ticker: ReturnType<typeof setInterval> | undefined
  let mode: CaptureMode = "sidecar"

  // webview capture state
  let stream: MediaStream | undefined
  let audioCtx: AudioContext | undefined
  let processor: ScriptProcessorNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let captured: Float32Array[] = []
  let peak = 0
  let capturedRate = TARGET_RATE
  /** Why the last openWebviewCapture() failed — surfaced where the sidecar cannot take over. */
  let openError: unknown

  const base = () => opts.url().replace(/\/$/, "")

  // Held recordings: the server keeps audio on disk when every engine fails. They are retried
  // automatically on RETRY_BACKOFF_MS, and on demand. Recordings left from a previous run are
  // recovered on mount but NOT auto-retried — inserting old words into whatever prompt happens to
  // be open, unasked, would be a surprise; the person retries them by hand.
  const [held, setHeld] = createSignal<HeldRecording[]>([])
  const [retrying, setRetrying] = createSignal(false)
  const [nextRetryIn, setNextRetryIn] = createSignal<number>()
  let retryStep = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let countdown: ReturnType<typeof setInterval> | undefined
  let disposed = false

  function stopTicker() {
    if (ticker) clearInterval(ticker)
    ticker = undefined
  }

  function teardownWebview() {
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
    // Stopping the tracks is what turns the OS recording indicator off.
    stream?.getTracks().forEach((t) => t.stop())
    stream = undefined
  }

  /** Open the webview microphone. Returns false if it cannot even be opened. */
  async function openWebviewCapture(): Promise<boolean> {
    openError = undefined
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      openError = new Error("this window has no microphone API")
      return false
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      openError = e
      return false
    }
    if (stream.getAudioTracks().length === 0) {
      teardownWebview()
      openError = new DOMException("no audio track", "NotFoundError")
      return false
    }
    try {
      const Ctor: typeof AudioContext =
        (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor()
      if (audioCtx.state === "suspended") await audioCtx.resume()
      capturedRate = audioCtx.sampleRate
      source = audioCtx.createMediaStreamSource(stream)
      // ScriptProcessor over AudioWorklet deliberately: a worklet needs a separately-loaded
      // module, and this has to work inside a packaged webview with no extra asset plumbing.
      processor = audioCtx.createScriptProcessor(4096, 1, 1)
      captured = []
      peak = 0
      processor.onaudioprocess = (event) => {
        const frame = event.inputBuffer.getChannelData(0)
        captured.push(new Float32Array(frame))
        for (let i = 0; i < frame.length; i++) {
          const v = Math.abs(frame[i]!)
          if (v > peak) peak = v
        }
      }
      // The graph only pulls a processor that reaches the destination, but routing the mic to
      // the speakers would echo it. A zero-gain node keeps it pulled and silent.
      const mute = audioCtx.createGain()
      mute.gain.value = 0
      source.connect(processor)
      processor.connect(mute)
      mute.connect(audioCtx.destination)
      if (audioCtx.state === "suspended") await audioCtx.resume()
      return true
    } catch (e) {
      openError = e
      teardownWebview()
      return false
    }
  }

  async function startSidecar(): Promise<boolean> {
    try {
      const res = await fetch(`${base()}/dictate/start`, { method: "POST" })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        opts.onError?.(body?.error || "Could not start recording.")
        return false
      }
      return true
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      opts.onError?.(
        /fetch/i.test(detail) ? `Could not reach ${base()} — is that server running?` : detail,
      )
      return false
    }
  }

  async function start() {
    if (phase() !== "idle") return

    // Known-good path from a previous dictation in this session.
    if (cachedMode === "sidecar") {
      if (!(await startSidecar())) return
      mode = "sidecar"
      begin()
      return
    }

    const opened = await openWebviewCapture()
    if (!opened && !sidecarCanRecord()) {
      // Windows: nothing to fall back to. Report the window's own failure, and do NOT cache —
      // the user may grant the permission and press the button again.
      opts.onError?.(micOpenError(openError))
      return
    }
    if (!opened) {
      cachedMode = "sidecar"
      if (!(await startSidecar())) return
      mode = "sidecar"
      begin()
      return
    }

    // Where the sidecar cannot record, the webview is the only recorder: no probe, no fallback.
    // A slow first buffer or a quiet room must not be able to route Windows to a dead end.
    if (cachedMode === "webview" || !sidecarCanRecord()) {
      mode = "webview"
      begin()
      return
    }

    // First dictation of the session: find out whether this webview actually captures.
    // It opened without throwing, which on WKWebView proves nothing at all.
    begin()
    mode = "webview"
    await new Promise((r) => setTimeout(r, PROBE_MS))
    if (captureIsLive(peak, captured.length)) {
      cachedMode = "webview"
      return
    }

    // Opened, ran, produced nothing: the host denied the microphone by handing back silence.
    // Discard the probe and record in the sidecar instead. The ~400ms lost here is paid once
    // per session, and only on hosts where the webview cannot record at all.
    teardownWebview()
    captured = []
    cachedMode = "sidecar"
    if (!(await startSidecar())) {
      stopTicker()
      setPhase("idle")
      return
    }
    mode = "sidecar"
  }

  function begin() {
    setSeconds(0)
    setPhase("recording")
    ticker = setInterval(() => setSeconds((n) => n + 1), 1000)
  }

  async function stop() {
    if (phase() !== "recording") return
    stopTicker()
    setPhase("transcribing")
    try {
      if (mode === "sidecar") await stopSidecar()
      else await stopWebview()
    } finally {
      setPhase("idle")
    }
  }

  async function stopSidecar() {
    try {
      const res = await fetch(`${base()}/dictate/stop`, { method: "POST" })
      const body = await res.json().catch(() => null)
      deliver(res.ok, body)
    } catch (e) {
      reachError(e)
    }
  }

  async function stopWebview() {
    const frames = captured
    const rate = capturedRate
    const level = peak
    captured = []
    peak = 0
    teardownWebview()

    const total = frames.reduce((n, f) => n + f.length, 0)
    if (total === 0) {
      return opts.onError?.("No audio reached the recorder. Check the input device.")
    }
    // Speech models answer silence with a confident "You". Refuse rather than upload silence.
    if (level < SILENCE_FLOOR) {
      return opts.onError?.(
        `The microphone recorded silence (peak ${level.toFixed(4)}). Check the input device in your sound settings.`,
      )
    }

    const merged = new Float32Array(total)
    let offset = 0
    for (const f of frames) {
      merged.set(f, offset)
      offset += f.length
    }
    const blob = encodeWav(downsample(merged, rate, TARGET_RATE), TARGET_RATE)

    try {
      const res = await fetch(`${base()}/transcribe?filename=dictation.wav`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: blob,
      })
      const body = await res.json().catch(() => null)
      deliver(res.ok, body)
    } catch (e) {
      reachError(e)
    }
  }

  function deliver(ok: boolean, body: any) {
    if (!ok && typeof body?.held?.id === "string") {
      setHeld((list) => [...list, { id: body.held.id, seconds: Number(body.held.seconds) || 0 }])
      scheduleRetry()
      return opts.onError?.(`${body.error || "Transcription failed."} Your recording is saved.`)
    }
    if (!ok) {
      // The server's message already names the real cause (no board configured, a dead provider, a
      // silence refusal that reports the measured peak), so it is shown verbatim.
      return opts.onError?.(body?.error || "Transcription failed.")
    }
    // A 200 is not proof this route exists: an older server answers 200 (with the SPA's HTML)
    // to unknown POSTs. Report THAT rather than blaming the microphone.
    if (!body || typeof body.text !== "string") {
      return opts.onError?.(
        `${base()} answered without a transcript — it may be an older server without dictation.`,
      )
    }
    const text = body.text.trim()
    if (!text) return opts.onError?.("That transcribed to nothing — try speaking a little louder.")
    opts.onTranscript(text)
  }

  function reachError(e: unknown) {
    const detail = e instanceof Error ? e.message : String(e)
    opts.onError?.(
      /fetch/i.test(detail) ? `Could not reach ${base()} — is that server running?` : detail,
    )
  }

  function clearRetryTimers() {
    if (retryTimer) clearTimeout(retryTimer)
    if (countdown) clearInterval(countdown)
    retryTimer = undefined
    countdown = undefined
    setNextRetryIn(undefined)
  }

  function scheduleRetry() {
    clearRetryTimers()
    const wait = RETRY_BACKOFF_MS[retryStep]
    if (wait === undefined || disposed) return
    retryStep++
    const due = Date.now() + wait
    setNextRetryIn(Math.ceil(wait / 1000))
    countdown = setInterval(() => setNextRetryIn(Math.max(0, Math.ceil((due - Date.now()) / 1000))), 1000)
    retryTimer = setTimeout(() => void retryHeld(true), wait)
  }

  /**
   * Retry every held recording, oldest first, inserting each transcript as it lands. Stops at the
   * first failure: if one recording cannot be transcribed right now, the next will not be either.
   */
  async function retryHeld(automatic = false) {
    if (retrying()) return
    clearRetryTimers()
    if (!automatic) retryStep = 0
    setRetrying(true)
    try {
      for (const item of held()) {
        const res = await fetch(`${base()}/transcribe/retry?id=${encodeURIComponent(item.id)}`, { method: "POST" })
        const body = await res.json().catch(() => null)
        if (res.status === 404) {
          setHeld((list) => list.filter((h) => h.id !== item.id))
          continue
        }
        if (!res.ok || typeof body?.text !== "string") {
          opts.onError?.(`${body?.error || "Transcription failed."} Your recording is still saved.`)
          scheduleRetry()
          return
        }
        setHeld((list) => list.filter((h) => h.id !== item.id))
        if (body.text.trim()) opts.onTranscript(body.text.trim())
      }
      retryStep = 0
    } catch (e) {
      reachError(e)
      scheduleRetry()
    } finally {
      setRetrying(false)
    }
  }

  async function discardHeld() {
    clearRetryTimers()
    retryStep = 0
    const ids = held().map((h) => h.id)
    setHeld([])
    await Promise.all(
      ids.map((id) =>
        fetch(`${base()}/transcribe/discard?id=${encodeURIComponent(id)}`, { method: "POST" }).catch(() => {}),
      ),
    )
  }

  // Recover recordings a previous run could not transcribe. An older server answers this route
  // with the SPA's HTML, so anything but a list is ignored.
  void fetch(`${base()}/transcribe/held`)
    .then((res) => res.json())
    .then((body) => {
      if (disposed || !Array.isArray(body?.held)) return
      const recovered = body.held
        .filter((h: { id?: unknown }) => typeof h?.id === "string")
        .map((h: { id: string; seconds?: number }) => ({ id: h.id, seconds: Number(h.seconds) || 0 }))
      if (recovered.length)
        setHeld((list) => [...recovered.filter((r: HeldRecording) => !list.some((h) => h.id === r.id)), ...list])
    })
    .catch(() => {})

  function toggle() {
    if (phase() === "recording") void stop()
    else if (phase() === "idle") void start()
    // "transcribing" is inert: a second click would race the in-flight request.
  }

  onCleanup(() => {
    disposed = true
    clearRetryTimers()
    stopTicker()
    teardownWebview()
    // Leaving the sidecar recording after the prompt unmounts is a hot microphone nobody can
    // see or stop. Fire-and-forget: unmount must not wait on the network.
    if (phase() === "recording" && mode === "sidecar") {
      void fetch(`${base()}/dictate/cancel`, { method: "POST" }).catch(() => {})
    }
  })

  return { phase, seconds, toggle, held, retrying, nextRetryIn, retryHeld: () => retryHeld(false), discardHeld }
}
