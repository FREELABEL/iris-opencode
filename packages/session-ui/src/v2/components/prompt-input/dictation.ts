import { createSignal, onCleanup } from "solid-js"

/**
 * Push-to-talk dictation. The UI drives it; the SIDECAR does the recording.
 *
 * ## Why the webview does not record
 *
 * It cannot. Tauri's macOS shell implements no WKUIDelegate media-capture callback, so WebKit
 * never grants the page's getUserMedia request — it resolves with a track that emits nothing.
 * Measured in the shipped app: a 10-second recording with peak amplitude 0.0000, while the
 * app's own microphone permission was granted and the entitlement was present.
 *
 * Three attempts were made in the wrong layer before that was understood — two containers for
 * MediaRecorder, then raw Web Audio. All of them were fixing JavaScript for a permission the
 * native shell never answered.
 *
 * The sidecar is an ordinary macOS process holding the same microphone grant, so it simply
 * records. This module is now a remote control: start, stop, insert.
 */

export type DictationPhase = "idle" | "recording" | "transcribing"

export interface DictationOptions {
  /**
   * Base URL of the local server, read as a GETTER at request time — not a snapshot.
   * The selected server can change while the prompt is mounted, and a captured string keeps
   * talking to whichever server was chosen when it first rendered.
   */
  url: () => string
  onTranscript: (text: string) => void
  onError?: (message: string) => void
}

export function createDictation(opts: DictationOptions) {
  const [phase, setPhase] = createSignal<DictationPhase>("idle")
  // A moving number is the difference between "recording" and "hung".
  const [seconds, setSeconds] = createSignal(0)
  let ticker: ReturnType<typeof setInterval> | undefined

  function stopTicker() {
    if (ticker) clearInterval(ticker)
    ticker = undefined
  }

  const base = () => opts.url().replace(/\/$/, "")

  async function post(path: string): Promise<{ ok: boolean; body: any; status: number }> {
    const res = await fetch(`${base()}${path}`, { method: "POST" })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, body, status: res.status }
  }

  async function start() {
    if (phase() !== "idle") return
    try {
      const { ok, body } = await post("/dictate/start")
      if (!ok) {
        // The server's message already names the cause (no ffmpeg, already recording).
        return opts.onError?.(body?.error || "Could not start recording.")
      }
      setSeconds(0)
      setPhase("recording")
      ticker = setInterval(() => setSeconds((n) => n + 1), 1000)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      opts.onError?.(
        /fetch/i.test(detail) ? `Could not reach ${base()} — is that server running?` : detail,
      )
    }
  }

  async function stop() {
    if (phase() !== "recording") return
    stopTicker()
    setPhase("transcribing")
    try {
      const { ok, body } = await post("/dictate/stop")
      setPhase("idle")
      if (!ok) {
        // 422 is the silence guard, which reports the measured peak; 500 carries ffmpeg's own
        // words. Both name something actionable, so they are shown verbatim.
        return opts.onError?.(body?.error || `Transcription failed (HTTP ${body?.status ?? "?"})`)
      }
      // A 200 is not proof this route exists: an older server answers 200 (with the SPA's
      // HTML) to unknown POSTs. Report THAT rather than blaming the microphone.
      if (!body || typeof body.text !== "string") {
        return opts.onError?.(
          `${base()} answered without a transcript — it may be an older server without /dictate.`,
        )
      }
      const text = body.text.trim()
      if (!text) return opts.onError?.("That transcribed to nothing — try speaking a little louder.")
      opts.onError?.(undefined as unknown as string)
      opts.onTranscript(text)
    } catch (e) {
      setPhase("idle")
      const detail = e instanceof Error ? e.message : String(e)
      opts.onError?.(
        /fetch/i.test(detail) ? `Could not reach ${base()} — is that server running?` : detail,
      )
    }
  }

  function toggle() {
    if (phase() === "recording") void stop()
    else if (phase() === "idle") void start()
    // "transcribing" is inert: a second click would race the in-flight request.
  }

  onCleanup(() => {
    stopTicker()
    // Leaving the sidecar recording after the prompt unmounts is a hot microphone nobody can
    // see or stop. Fire-and-forget: unmount must not wait on the network.
    if (phase() === "recording") void fetch(`${base()}/dictate/cancel`, { method: "POST" }).catch(() => {})
  })

  return { phase, seconds, toggle }
}
