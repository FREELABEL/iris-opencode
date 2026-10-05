import type { LiveConfig } from "./live"

/**
 * Spoken replies: a text-to-speech session from this sidecar to the IRIS voice relay
 * (fl-iris-api services/stt-relay, route /v1/tts/stream), which holds the xAI key and proxies xAI
 * streaming TTS. Same relay, token and board as live dictation (readLiveConfig), so the same
 * sign-in and per-board privacy policy apply: a reply can be as sensitive as dictated audio.
 *
 * One session carries many replies: send text (in pieces as the assistant streams it), then
 * done() to finish a reply; clear() stops the current one (barge-in). Audio comes back as 24 kHz
 * mono PCM16 chunks, decoded here from the relay's base64 so the window receives raw bytes.
 */

export type SpeakEvent = { type: "done" } | { type: "cleared" } | { type: "unavailable"; reason: string }

export interface SpeakSession {
  text(delta: string): void
  done(): void
  clear(): void
  close(): void
}

export const SPEAK_SAMPLE_RATE = 24000

export function openSpeakSession(
  cfg: LiveConfig,
  opts: {
    voice?: string
    language?: string
    onAudio: (pcm: Uint8Array) => void
    onEvent: (event: SpeakEvent) => void
    onClose?: () => void
  },
): SpeakSession {
  const url = new URL(`${cfg.relayUrl}/v1/tts/stream`)
  url.searchParams.set("bloq_id", cfg.bloqId)
  url.searchParams.set("language", opts.language || "en")
  if (opts.voice) url.searchParams.set("voice", opts.voice)
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol === "http:") url.protocol = "ws:"

  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.token}` } } as unknown as string[])
  const pending: string[] = []
  let ended = false

  const emit = (event: SpeakEvent) => {
    if (ended) return
    if (event.type === "unavailable") ended = true
    opts.onEvent(event)
  }

  ws.onopen = () => {
    for (const frame of pending) ws.send(frame)
    pending.length = 0
  }
  ws.onmessage = (message) => {
    if (typeof message.data !== "string") return
    const value = parseJson(message.data)
    if (value?.type === "audio.delta" && typeof value.delta === "string") return opts.onAudio(base64Bytes(value.delta))
    if (value?.type === "audio.done") return emit({ type: "done" })
    if (value?.type === "audio.clear") return emit({ type: "cleared" })
    if (value?.type === "relay.error" || value?.type === "error")
      return emit({ type: "unavailable", reason: typeof value.message === "string" ? value.message : "Spoken replies stopped." })
  }
  // A refused upgrade (401/403/429/503) surfaces as an error then a close with no open.
  ws.onerror = () => emit({ type: "unavailable", reason: "The spoken-replies service could not be reached." })
  ws.onclose = (event) => {
    if (event.code !== 1000) emit({ type: "unavailable", reason: event.reason || "Spoken replies stopped." })
    ended = true
    opts.onClose?.()
  }

  const out = (frame: object) => {
    if (ended) return
    const text = JSON.stringify(frame)
    if (ws.readyState === WebSocket.OPEN) return ws.send(text)
    if (ws.readyState === WebSocket.CONNECTING) pending.push(text)
  }

  return {
    text: (delta) => {
      if (delta) out({ type: "text.delta", delta })
    },
    done: () => out({ type: "text.done" }),
    clear: () => out({ type: "text.clear" }),
    close: () => {
      ended = true
      ws.close()
    },
  }
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as { type?: unknown; delta?: unknown; message?: unknown }
  } catch {
    return undefined
  }
}

function base64Bytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
