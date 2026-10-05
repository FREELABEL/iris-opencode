import { createSignal, onCleanup } from "solid-js"
import { captureIsLive } from "./dictation-probe"
import { emptyLevels, levelFromRms, pushLevel, rms } from "./dictate-visual"

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
/**
 * Longest dictation, in seconds — the same cap the sidecar gives ffmpeg (capture.ts MAX_SECONDS).
 * The webview recorder had none, and the platform refuses uploads over 25 MB (~13 min of 16 kHz
 * mono): a long take uploaded fine, failed there, and was held and retried until pruned.
 */
export const MAX_SECONDS = 300
/**
 * A shortcut held at least this long is push-to-talk: letting go stops. Anything shorter is a
 * tap, which toggles — the recording keeps going until the next press.
 */
const HOLD_MS = 350
/** ~-40 dBFS: quieter than speech, louder than a noise floor. */
const SILENCE_FLOOR = 0.01
const TARGET_RATE = 16000

/** How often the sidecar's level is read while it records — fast enough for the waveform to move. */
const LEVEL_POLL_MS = 60

/** Waits before each automatic retry of a held recording; after the last, retries are manual. */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000, 180_000]

export type DictationPhase = "idle" | "recording" | "transcribing"
/** A recording the server saved because every engine failed — retryable without re-recording. */
export type HeldRecording = { id: string; seconds: number }
type CaptureMode = "webview" | "sidecar"

/** Remembered across dictations; null until the first probe has run. */
let cachedMode: CaptureMode | null = null

/**
 * GET /transcribe/health — what the local server can do right now. `reason` strings are written
 * for a person on THIS platform. The composer is built against exactly this shape.
 */
export type DictationReadiness = {
  recorder: { sidecar: boolean; reason?: string }
  cloud: { configured: boolean; reason?: string }
  local: { whisper: boolean }
  /** The engines a dictation would try, in order. */
  engines: string[]
}

function isReadiness(body: unknown): body is DictationReadiness {
  const b = body as Partial<DictationReadiness> | null
  return (
    typeof b?.recorder?.sidecar === "boolean" &&
    typeof b?.cloud?.configured === "boolean" &&
    typeof b?.local?.whisper === "boolean" &&
    Array.isArray(b?.engines)
  )
}

/**
 * Credentials for the local server, by base URL — the same Authorization header the app's SDK
 * sends (Basic, from the server connection's password). Set once by the app; unset means none,
 * which is today's sidecar (spawned without OPENCODE_SERVER_PASSWORD).
 */
let authFor: ((url: string) => Record<string, string> | undefined) | undefined

export function setDictationAuth(resolve: ((url: string) => Record<string, string> | undefined) | undefined) {
  authFor = resolve
}

/**
 * The preferred microphone, by device NAME ("" or undefined = system default). Set once by the app
 * from its settings. A name, not an id, because the two recorders do not share an id space: the
 * window resolves it against enumerateDevices() labels, the sidecar against ffmpeg's device list.
 * Read at start time, so a change in Settings applies to the next dictation without a remount.
 */
let deviceFor: (() => string | undefined) | undefined

export function setDictationDevice(resolve: (() => string | undefined) | undefined) {
  deviceFor = resolve
}

/** Microphone names the sidecar can record from. Empty when the server cannot list them. */
export async function listDictationDevices(base: string): Promise<string[]> {
  const url = base.replace(/\/$/, "")
  const res = await fetch(`${url}/dictate/devices`, { headers: { ...authFor?.(url) } }).catch(() => undefined)
  const body = await res?.json().catch(() => undefined)
  if (!Array.isArray(body?.devices)) return []
  return body.devices
    .map((device: { name?: unknown }) => (typeof device?.name === "string" ? device.name.trim() : ""))
    .filter((name: string) => name.length > 0)
}

function isWindows() {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
}

/**
 * May the sidecar take over from the webview on this host? Everywhere but Windows, yes — macOS's
 * WKWebView needs it, Linux has ALSA/PulseAudio. On Windows only when the server SAYS it can record
 * (ffmpeg present, a DirectShow microphone found). Without that, falling back produced "Recording
 * needs ffmpeg" — advice that hid the real fault (the window's own microphone permission). So
 * where the sidecar cannot record, the webview is the ONLY recorder: say why, never mention ffmpeg.
 */
function sidecarCanRecord(ready: DictationReadiness | undefined): boolean {
  if (!isWindows()) return true
  return ready?.recorder.sidecar === true
}

/** Retry-After (seconds or HTTP-date) in ms, or 0. */
function retryAfterMs(res: Response) {
  const value = res.headers.get("retry-after")?.trim()
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now())
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
  /**
   * Live preview while recording (GET /dictate/live -> IRIS STT relay -> xAI streaming STT).
   * onPartial REPLACES the in-progress utterance; onFinal appends a locked one. The batch
   * transcript delivered to onTranscript after stop is still the text that gets inserted.
   */
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  /** Live preview is off for this take (not configured, refused, dropped). Batch is unaffected. */
  onLiveUnavailable?: (reason: string) => void
  /**
   * Retry held recordings in the background (default true). A surface with no Retry/Discard
   * controls must pass false: otherwise text can land in the prompt minutes later with nothing
   * on screen saying a recording was waiting. Held recordings stay saved for a surface that shows them.
   */
  autoRetry?: boolean
}

/** Live preview state for the current take. */
export type DictationLive = "off" | "connecting" | "streaming" | "unavailable"

/** Background recordings run past the inline cap, up to this (the relay's own session cap). */
const BACKGROUND_MAX_SECONDS = 60 * 60
/** 100 ms of 16 kHz audio: the frame size xAI's streaming STT recommends. */
const LIVE_FRAME_SAMPLES = 1600

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
  /**
   * Bumped by every start() and every stop(). start() awaits — the probe, the sidecar request —
   * and a stop or unmount can land inside any of those waits. A start() that wakes to a newer
   * attempt must not go on to open a microphone the button no longer shows.
   */
  let attempt = 0
  /** True while the first-session probe decides between webview and sidecar. */
  let probing = false
  /** start() is between its first await and its last — no recorder may be running yet. */
  let starting = false
  /** When the shortcut that started this recording went down; cleared by its release. */
  let pressedAt: number | undefined
  /** The shortcut is down right now — the UI says "release to stop" instead of "press to stop". */
  const [holding, setHolding] = createSignal(false)
  /** Recent loudness, oldest first, for the waveform. Always LEVEL_HISTORY long. */
  const [levels, setLevels] = createSignal<number[]>(emptyLevels())
  let levelPoll: ReturnType<typeof setInterval> | undefined

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

  // Live preview for the current take. See DictationOptions.onPartial.
  const [live, setLive] = createSignal<DictationLive>("off")
  let liveSocket: WebSocket | undefined
  let livePending: Int16Array[] = []
  let livePendingSamples = 0
  let liveCloseTimer: ReturnType<typeof setTimeout> | undefined
  /** How long this take may run: MAX_SECONDS inline, BACKGROUND_MAX_SECONDS in background mode. */
  let maxSeconds = MAX_SECONDS
  /** Every request to the local server goes through here, so each one carries the credentials. */
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base()}${path}`, { ...init, headers: { ...authFor?.(base()), ...(init.headers as Record<string, string>) } })

  // What the server can do. Fetched once on mount for the composer; the Windows fallback below
  // waits on it, since the first press can land before it arrives.
  const [readiness, setReadiness] = createSignal<DictationReadiness>()
  const readinessLoaded = call("/transcribe/health")
    .then((res) => (res.ok ? res.json() : undefined))
    .then((body: unknown) => {
      if (isReadiness(body) && !disposed) setReadiness(body)
      return readiness()
    })
    .catch(() => undefined)

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
    stopLevelPoll()
    setLevels(emptyLevels())
  }

  /** The sidecar records in another process; its level comes over HTTP. An older one has no route. */
  function startLevelPoll() {
    stopLevelPoll()
    levelPoll = setInterval(() => {
      void call("/dictate/level")
        .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
        .then((body) => {
          if (!levelPoll || typeof body?.level !== "number") return
          setLevels((h) => pushLevel(h, levelFromRms(body.level)))
        })
        .catch(() => stopLevelPoll())
    }, LEVEL_POLL_MS)
  }

  function stopLevelPoll() {
    if (levelPoll) clearInterval(levelPoll)
    levelPoll = undefined
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
    stream = await preferredDeviceStream(stream)
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
        // Two bars per buffer: 4096 samples is ~85ms at 48kHz, too coarse for one bar to move well.
        const half = frame.length >> 1
        setLevels((h) => pushLevel(pushLevel(h, levelFromRms(rms(frame, 0, half))), levelFromRms(rms(frame, half))))
        // Live preview, only once this window is confirmed as the recorder (never the probe).
        if (!probing && mode === "webview" && phase() === "recording") sendLiveAudio(frame, capturedRate)
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
      const device = deviceFor?.()?.trim()
      const params = new URLSearchParams()
      if (device) params.set("device", device)
      if (maxSeconds !== MAX_SECONDS) params.set("max_seconds", String(maxSeconds))
      const query = params.toString()
      const res = await call(query ? `/dictate/start?${query}` : "/dictate/start", { method: "POST" })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        opts.onError?.(body?.error || "Could not start recording.")
        return false
      }
      // The sidecar records; the server tees its capture to the relay. This socket only listens.
      openLive("sidecar")
      return true
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      opts.onError?.(
        /fetch/i.test(detail) ? `Could not reach ${base()} — is that server running?` : detail,
      )
      return false
    }
  }

  /** start() was overtaken by a stop or an unmount while it waited. */
  function superseded(id: number) {
    return id !== attempt || disposed
  }

  async function start(startOpts: { mode?: "inline" | "background" } = {}) {
    // A second start while the first is still awaiting would open a second recorder.
    if (phase() !== "idle" || starting) return
    maxSeconds = startOpts.mode === "background" ? BACKGROUND_MAX_SECONDS : MAX_SECONDS
    resetLive()
    starting = true
    try {
      // Fail BEFORE the person speaks: with no cloud engine configured (not signed in, no board)
      // and no on-device whisper, every take would fail after the fact. Say why now. Unknown
      // readiness (an older server) never blocks.
      const pending = attempt
      const ready = readiness() ?? (await readinessLoaded)
      // A hold-to-talk release (or stop) while this was awaited bumps `attempt`: abandon the take
      // rather than open a microphone nobody is holding.
      if (attempt !== pending || disposed) return
      if (ready && !ready.cloud.configured && !ready.local.whisper) {
        opts.onError?.(ready.cloud.reason || "Dictation is not set up on this machine.")
        return
      }
      await openRecorder()
    } finally {
      starting = false
    }
  }

  async function openRecorder() {
    const id = ++attempt

    // Known-good path from a previous dictation in this session.
    if (cachedMode === "sidecar") {
      if (!(await startSidecar())) return
      if (superseded(id)) return cancelSidecar()
      mode = "sidecar"
      begin()
      return
    }

    const opened = await openWebviewCapture()
    if (superseded(id)) return teardownWebview()
    const ready = !opened && isWindows() ? (readiness() ?? (await readinessLoaded)) : undefined
    if (superseded(id)) return teardownWebview()
    if (!opened && !sidecarCanRecord(ready)) {
      // Windows: nothing to fall back to. Report the window's own failure, and do NOT cache —
      // the user may grant the permission and press the button again.
      opts.onError?.(micOpenError(openError))
      return
    }
    if (!opened) {
      cachedMode = "sidecar"
      if (!(await startSidecar())) return
      if (superseded(id)) return cancelSidecar()
      mode = "sidecar"
      begin()
      return
    }

    // Windows' WebView2 is Chromium: a microphone it opens records. No probe — a slow first buffer
    // or a quiet room must not be able to route Windows away from a working recorder. The sidecar
    // there is only for an open that FAILED (above).
    if (cachedMode === "webview" || isWindows()) {
      mode = "webview"
      begin()
      return
    }

    // First dictation of the session: find out whether this webview actually captures.
    // It opened without throwing, which on WKWebView proves nothing at all.
    mode = "webview"
    begin()
    probing = true
    await new Promise((r) => setTimeout(r, PROBE_MS))
    probing = false
    // Stopped or unmounted during the probe: stop() already released the microphone. Going on
    // would start the sidecar behind an idle button — a hot mic with nothing on screen.
    if (superseded(id)) return
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
    // Set before the await: a stop that lands while the sidecar is starting goes to the sidecar,
    // not to the webview recorder just torn down. The cancel below covers either arrival order.
    mode = "sidecar"
    if (!(await startSidecar())) {
      stopTicker()
      setPhase("idle")
      return
    }
    if (superseded(id)) return cancelSidecar()
    startLevelPoll()
  }

  /**
   * Open the live preview socket. A browser WebSocket cannot send an Authorization header, so on
   * a password-protected server the same Basic credential goes as `auth_token` — the query form
   * the server's authorization middleware already accepts (app entry.tsx uses it at startup).
   * The voice routes only answer loopback callers, so the credential never leaves this machine.
   */
  function openLive(source: "window" | "sidecar") {
    if (liveSocket || live() === "unavailable" || typeof WebSocket === "undefined") return
    const url = new URL(`${base()}/dictate/live`)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("source", source)
    const basic = Object.entries(authFor?.(base()) ?? {})
      .find(([name]) => name.toLowerCase() === "authorization")?.[1]
      ?.match(/^Basic\s+(.+)$/i)?.[1]
    if (basic) url.searchParams.set("auth_token", basic)
    setLive("connecting")
    const ws = new WebSocket(url)
    liveSocket = ws
    ws.onopen = () => {
      if (liveSocket !== ws) return
      setLive("streaming")
      for (const chunk of livePending) ws.send(tagFrame(0x00, chunk))
      livePending = []
      livePendingSamples = 0
    }
    ws.onmessage = (message) => {
      if (liveSocket !== ws || typeof message.data !== "string") return
      const event = parseLiveEvent(message.data)
      if (event?.type === "partial") opts.onPartial?.(event.text)
      if (event?.type === "final") opts.onFinal?.(event.text)
      if (event?.type === "unavailable") liveUnavailable(event.reason)
    }
    ws.onerror = () => liveUnavailable("The live preview could not connect.")
    ws.onclose = () => {
      if (liveSocket === ws) liveSocket = undefined
      if (live() === "connecting") liveUnavailable("The live preview could not connect.")
    }
  }

  /** Window recorder frame (at the AudioContext rate) -> 100 ms PCM16 frames on the live socket. */
  function sendLiveAudio(frame: Float32Array, rate: number) {
    if (live() === "unavailable") return
    openLive("window")
    const pcm = toPcm16(downsample(frame, rate, TARGET_RATE))
    livePending.push(pcm)
    livePendingSamples += pcm.length
    if (live() !== "streaming" || livePendingSamples < LIVE_FRAME_SAMPLES) return
    const merged = new Int16Array(livePendingSamples)
    let offset = 0
    for (const chunk of livePending) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    livePending = []
    livePendingSamples = 0
    liveSocket?.send(tagFrame(0x00, merged))
  }

  /** Recording stopped: flush, say "audio.done", and keep listening briefly for the last finals. */
  function endLive() {
    const ws = liveSocket
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      if (livePendingSamples > 0) {
        const merged = new Int16Array(livePendingSamples)
        let offset = 0
        for (const chunk of livePending) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        ws.send(tagFrame(0x00, merged))
      }
      ws.send(tagFrame(0x02))
    }
    livePending = []
    livePendingSamples = 0
    liveCloseTimer = setTimeout(() => closeLive(), 5000)
  }

  function closeLive() {
    if (liveCloseTimer) clearTimeout(liveCloseTimer)
    liveCloseTimer = undefined
    const ws = liveSocket
    liveSocket = undefined
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
  }

  function resetLive() {
    closeLive()
    livePending = []
    livePendingSamples = 0
    setLive("off")
  }

  function liveUnavailable(reason: string) {
    if (live() === "unavailable") return
    setLive("unavailable")
    closeLive()
    opts.onLiveUnavailable?.(reason)
  }

  function cancelSidecar() {
    void call("/dictate/cancel", { method: "POST" }).catch(() => {})
  }

  function begin() {
    setSeconds(0)
    setPhase("recording")
    ticker = setInterval(() => {
      const next = seconds() + 1
      setSeconds(next)
      if (next >= maxSeconds) void stop()
    }, 1000)
    if (mode === "sidecar") startLevelPoll()
  }

  async function stop() {
    if (phase() !== "recording") return
    attempt++
    stopTicker()
    if (probing) {
      // Under 400ms in, before a recorder was even chosen: there is nothing worth transcribing,
      // and judging the mic on a cut-short probe would cache the wrong path for the session.
      probing = false
      captured = []
      peak = 0
      teardownWebview()
      setPhase("idle")
      return
    }
    setPhase("transcribing")
    endLive()
    try {
      if (mode === "sidecar") await stopSidecar()
      else await stopWebview()
    } finally {
      setPhase("idle")
    }
  }

  async function stopSidecar() {
    try {
      const res = await call("/dictate/stop", { method: "POST" })
      const body = await res.json().catch(() => null)
      deliver(res.ok, body, retryAfterMs(res))
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
      const res = await call("/transcribe?filename=dictation.wav", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: blob,
      })
      const body = await res.json().catch(() => null)
      deliver(res.ok, body, retryAfterMs(res))
    } catch (e) {
      reachError(e)
    }
  }

  /** `wait` is the server's Retry-After: the automatic retry comes no sooner. */
  function deliver(ok: boolean, body: any, wait = 0) {
    // A 413 (over the platform's size limit) carries no `held`: nothing is kept, nothing retried,
    // and the server's message — which names the limit — is shown as is, below.
    if (!ok && typeof body?.held?.id === "string") {
      setHeld((list) => [...list, { id: body.held.id, seconds: Number(body.held.seconds) || 0 }])
      scheduleRetry(wait)
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

  function scheduleRetry(atLeast = 0) {
    clearRetryTimers()
    if (opts.autoRetry === false) return
    const step = RETRY_BACKOFF_MS[retryStep]
    if (step === undefined || disposed) return
    const wait = Math.max(step, atLeast)
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
        const res = await call(`/transcribe/retry?id=${encodeURIComponent(item.id)}`, { method: "POST" })
        const body = await res.json().catch(() => null)
        if (res.status === 404) {
          setHeld((list) => list.filter((h) => h.id !== item.id))
          continue
        }
        // Over the size limit: the server has let it go, and no retry would take it.
        if (res.status === 413) {
          setHeld((list) => list.filter((h) => h.id !== item.id))
          opts.onError?.(body?.error || "That recording is too long to transcribe.")
          continue
        }
        if (!res.ok || typeof body?.text !== "string") {
          opts.onError?.(`${body?.error || "Transcription failed."} Your recording is still saved.`)
          scheduleRetry(retryAfterMs(res))
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
        call(`/transcribe/discard?id=${encodeURIComponent(id)}`, { method: "POST" }).catch(() => {}),
      ),
    )
  }

  // Recover recordings a previous run could not transcribe. An older server answers this route
  // with the SPA's HTML, so anything but a list is ignored.
  void call("/transcribe/held")
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

  /** Shortcut went down. While recording it stops; while idle it starts and arms push-to-talk. */
  function press() {
    if (phase() === "recording") {
      pressedAt = undefined
      void stop()
      return
    }
    if (phase() !== "idle" || starting) return
    pressedAt = Date.now()
    setHolding(true)
    void start()
  }

  /** Shortcut came up. Held long enough, that ends the recording; a tap leaves it running. */
  function release() {
    if (pressedAt === undefined) return
    const held = Date.now() - pressedAt
    pressedAt = undefined
    setHolding(false)
    if (held < HOLD_MS) return
    if (phase() === "recording") void stop()
    // Let go before any recorder came up: abandon the start rather than record unheld.
    else if (starting) attempt++
  }

  /**
   * Throw the take away: release the microphone and upload nothing. Discarding a background take
   * must not send audio nobody wants to a transcription service.
   */
  function cancel() {
    if (phase() !== "recording") return
    attempt++
    probing = false
    pressedAt = undefined
    setHolding(false)
    stopTicker()
    if (mode === "sidecar") cancelSidecar()
    captured = []
    peak = 0
    teardownWebview()
    setPhase("idle")
  }

  /**
   * Lift a running take to the background cap ("Keep recording"). The window recorder honours it
   * at once; a sidecar take keeps the limit ffmpeg was launched with (-t), so it still ends at
   * the inline cap and its transcript goes to review.
   */
  function extend() {
    if (phase() !== "recording") return
    maxSeconds = BACKGROUND_MAX_SECONDS
  }

  function toggle() {
    if (phase() === "recording") void stop()
    else if (phase() === "idle") void start()
    // "transcribing" is inert: a second click would race the in-flight request.
  }

  onCleanup(() => {
    disposed = true
    closeLive()
    clearRetryTimers()
    stopTicker()
    teardownWebview()
    // Leaving the sidecar recording after the prompt unmounts is a hot microphone nobody can
    // see or stop. Fire-and-forget: unmount must not wait on the network.
    if (phase() === "recording" && mode === "sidecar") {
      void call("/dictate/cancel", { method: "POST" }).catch(() => {})
    }
  })

  return {
    phase,
    seconds,
    levels,
    holding,
    toggle,
    press,
    release,
    cancel,
    extend,
    held,
    retrying,
    nextRetryIn,
    retryHeld: () => retryHeld(false),
    discardHeld,
    readiness,
    live,
    /** Start a long recording that runs past the inline cap (the background panel calls this). */
    startBackground: () => start({ mode: "background" }),
  }
}

/** What a keyboard shortcut needs from a mounted dictation control. */
export type DictationControls = Pick<ReturnType<typeof createDictation>, "toggle" | "press" | "release" | "phase">

/**
 * Swap a default-device stream for the preferred microphone, when one is set and present.
 *
 * The default device is opened FIRST on purpose: enumerateDevices() only reveals labels after the
 * page holds a microphone grant, and the preference is stored by label. If the preferred mic is
 * missing (unplugged) or will not open, the default stream is kept rather than failing the take.
 */
async function preferredDeviceStream(current: MediaStream): Promise<MediaStream> {
  const wanted = deviceFor?.()?.trim()
  if (!wanted || !navigator.mediaDevices?.enumerateDevices) return current
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  const match = devices.find((d) => d.kind === "audioinput" && d.label.trim() === wanted && d.deviceId !== "default")
  if (!match || current.getAudioTracks()[0]?.getSettings().deviceId === match.deviceId) return current
  const pinned = await navigator.mediaDevices
    .getUserMedia({ audio: { deviceId: { exact: match.deviceId } } })
    .catch(() => undefined)
  if (!pinned) return current
  current.getTracks().forEach((t) => t.stop())
  return pinned
}

/** A client frame for /dictate/live: 1-byte tag + payload (0x00 audio, 0x01 finalize, 0x02 done). */
function tagFrame(tag: number, pcm?: Int16Array) {
  const body = pcm ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : new Uint8Array(0)
  const frame = new Uint8Array(1 + body.byteLength)
  frame[0] = tag
  frame.set(body, 1)
  return frame
}

/** Float samples in [-1, 1] -> little-endian PCM16, the format the relay forwards to xAI. */
export function toPcm16(samples: Float32Array) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]!))
    out[i] = c < 0 ? c * 0x8000 : c * 0x7fff
  }
  return out
}

/** Server frame on /dictate/live, or undefined for anything else. */
export function parseLiveEvent(
  text: string,
): { type: "partial" | "final"; text: string } | { type: "unavailable"; reason: string } | undefined {
  const value = (() => {
    try {
      return JSON.parse(text) as { type?: unknown; text?: unknown; reason?: unknown }
    } catch {
      return undefined
    }
  })()
  if ((value?.type === "partial" || value?.type === "final") && typeof value.text === "string")
    return { type: value.type, text: value.text }
  if (value?.type === "unavailable")
    return { type: "unavailable", reason: typeof value.reason === "string" ? value.reason : "Live preview stopped." }
  return undefined
}
