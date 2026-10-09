import { voiceSocketToken } from "./dictation"

/**
 * Spoken replies, window side. Text goes to the local server's /voice/speak socket, which relays it
 * to the IRIS voice relay (xAI streaming TTS); 24 kHz mono PCM16 comes back as binary frames and is
 * scheduled back to back on one AudioContext so chunks play without gaps.
 *
 * One socket carries many replies and is closed after a minute of silence. stop() is barge-in: it
 * silences what is playing and drops the socket, so audio still in flight for the old reply can
 * never play over the next one. The next speak() reconnects.
 */

export const SPEECH_SAMPLE_RATE = 24000
const IDLE_CLOSE_MS = 60_000

export type SpeechState = "idle" | "speaking" | "unavailable"

export type SpeechOptions = {
  base: () => string
  voice?: () => string | undefined
  onState?: (state: SpeechState, reason?: string) => void
}

export function createSpeechPlayer(opts: SpeechOptions) {
  let ws: WebSocket | undefined
  let ctx: AudioContext | undefined
  let playhead = 0
  let sources = new Set<AudioBufferSourceNode>()
  let idle: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let state: SpeechState = "idle"

  const set = (next: SpeechState, reason?: string) => {
    if (state === next && !reason) return
    state = next
    opts.onState?.(next, reason)
  }

  function socket() {
    if (ws && ws.readyState <= WebSocket.OPEN) return ws
    const url = new URL(`${opts.base().replace(/\/$/, "")}/voice/speak`)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const voice = opts.voice?.()
    if (voice) url.searchParams.set("voice", voice)
    const token = voiceSocketToken(opts.base())
    if (token) url.searchParams.set("auth_token", token)
    const next = new WebSocket(url)
    next.binaryType = "arraybuffer"
    next.onmessage = (message) => {
      if (ws !== next) return
      if (typeof message.data !== "string") return play(new Uint8Array(message.data as ArrayBuffer))
      const event = parseEvent(message.data)
      if (event?.type === "done") {
        finished = true
        settle()
      }
      if (event?.type === "unavailable") fail(event.reason)
    }
    next.onerror = () => {
      if (ws === next) fail("Spoken replies could not connect.")
    }
    next.onclose = () => {
      if (ws === next) ws = undefined
    }
    ws = next
    return next
  }

  function send(frame: object) {
    const s = socket()
    const text = JSON.stringify(frame)
    if (s.readyState === WebSocket.OPEN) return s.send(text)
    s.addEventListener("open", () => s.send(text), { once: true })
  }

  function audio() {
    if (ctx) return ctx
    ctx = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE })
    return ctx
  }

  function play(bytes: Uint8Array) {
    const samples = fromPcm16(bytes)
    if (!samples.length) return
    const ac = audio()
    if (ac.state === "suspended") void ac.resume()
    const buffer = ac.createBuffer(1, samples.length, SPEECH_SAMPLE_RATE)
    buffer.getChannelData(0).set(samples)
    const source = ac.createBufferSource()
    source.buffer = buffer
    source.connect(ac.destination)
    playhead = Math.max(playhead, ac.currentTime)
    source.start(playhead)
    playhead += buffer.duration
    sources.add(source)
    source.onended = () => {
      sources.delete(source)
      settle()
    }
    set("speaking")
  }

  /** Back to idle once the reply is complete AND its last chunk has finished playing. */
  function settle() {
    if (!finished || sources.size > 0) return
    set("idle")
    armIdle()
  }

  function armIdle() {
    clearTimeout(idle)
    idle = setTimeout(() => {
      ws?.close(1000)
      ws = undefined
    }, IDLE_CLOSE_MS)
  }

  function silence() {
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {}
    }
    sources = new Set()
    playhead = 0
  }

  function fail(reason: string) {
    silence()
    ws?.close()
    ws = undefined
    set("unavailable", reason)
  }

  return {
    /** Speak more of the current reply. Call with each newly complete piece of text. */
    speak(text: string) {
      if (!text.trim()) return
      clearTimeout(idle)
      finished = false
      if (state === "unavailable") set("idle")
      send({ type: "text.delta", delta: text.endsWith(" ") ? text : `${text} ` })
    },
    /** The reply is complete: flush what the engine is holding. */
    finish() {
      if (!ws) return
      send({ type: "text.done" })
    },
    /** Barge-in: stop speaking now and forget the rest of this reply. */
    stop() {
      clearTimeout(idle)
      finished = true
      silence()
      ws?.close(1000)
      ws = undefined
      if (state === "speaking") set("idle")
    },
    state: () => state,
    dispose() {
      this.stop()
      void ctx?.close()
      ctx = undefined
    },
  }
}

export type SpeechPlayer = ReturnType<typeof createSpeechPlayer>

/** Little-endian PCM16 -> Float32 in [-1, 1). An odd trailing byte is dropped. */
export function fromPcm16(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

function parseEvent(text: string): { type: "done" } | { type: "cleared" } | { type: "unavailable"; reason: string } | undefined {
  try {
    const value = JSON.parse(text) as { type?: unknown; reason?: unknown }
    if (value.type === "done" || value.type === "cleared") return { type: value.type }
    if (value.type === "unavailable")
      return { type: "unavailable", reason: typeof value.reason === "string" ? value.reason : "Spoken replies stopped." }
  } catch {}
  return undefined
}
