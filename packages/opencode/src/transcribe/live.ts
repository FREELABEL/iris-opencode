import { readRemoteConfig, resolveBoard } from "./remote"

/**
 * Live dictation: a streaming session from this sidecar to the IRIS STT relay
 * (fl-iris-api services/stt-relay), which holds the xAI key and proxies xAI streaming STT.
 *
 * Live text is a PREVIEW. The recording is still held on disk and transcribed by the batch engine
 * chain when it stops; that result is what gets inserted. So every failure here degrades to
 * "unavailable" and nothing else — it never fails a dictation.
 *
 * xAI's partials are cumulative within a segment: each one restates the segment so far, and an
 * is_final partial locks it. When the speaker pauses, a speech_final event restates the WHOLE turn —
 * every final since the last pause, joined (measured 2026-10-15, #189543). That event is passed on as
 * a final with `turn: true`; the composer replaces the turn's segments with it
 * (session-ui transcript-merge.ts). Nothing is dropped here by comparing text: a repeated sentence
 * can be real speech.
 */

/** fl-iris-api services/stt-relay, deployed as the iris-stt-relay Railway service (2026-10-05). */
const DEFAULT_RELAY_URL = "https://iris-stt-relay-production.up.railway.app"

export type LiveEvent =
  | { type: "partial"; text: string }
  /** turn: speech_final — restates every final since the last turn, and replaces them. */
  | { type: "final"; text: string; turn?: boolean }
  | { type: "unavailable"; reason: string }

export interface LiveSession {
  /** 16 kHz mono PCM16. Dropped silently once the session is no longer streaming. */
  send(pcm: Uint8Array): void
  /** Lock the current utterance (hold-to-talk release). */
  finalize(): void
  /** End of audio: the relay answers with the last finals and closes. */
  done(): void
  close(): void
}

export interface LiveConfig {
  relayUrl: string
  token: string
  bloqId: string
}

/** Relay URL, IRIS user token and board, or the reason live dictation cannot start. */
export function readLiveConfig(): { config: LiveConfig } | { reason: string } {
  // Production relay by default; IRIS_STT_RELAY_URL overrides it, and "off" turns live preview off.
  const relayUrl = process.env["IRIS_STT_RELAY_URL"]?.trim() || DEFAULT_RELAY_URL
  if (relayUrl === "off") return { reason: "Live transcription is turned off on this machine." }
  // The same signed-in person token and board the batch path uses (remote.ts isPersonToken): the
  // relay validates it with fl-api whoami and checks the board's cloud policy with it.
  const remote = readRemoteConfig()
  if (!remote?.token) return { reason: "Live transcription needs you to be signed in to IRIS." }
  return { config: { relayUrl: relayUrl.replace(/\/$/, ""), token: remote.token, bloqId: remote.bloqId ?? "" } }
}

/**
 * readLiveConfig, with the board filled in: the relay checks the board's cloud policy before it
 * streams, so it needs one up front. With none configured, the platform names the person's own.
 */
export async function resolveLiveConfig(): Promise<{ config: LiveConfig } | { reason: string }> {
  const live = readLiveConfig()
  if (!("config" in live) || live.config.bloqId) return live
  const remote = readRemoteConfig()
  const bloqId = remote ? await resolveBoard(remote) : undefined
  if (!bloqId)
    return { reason: "You don't have a board yet for live transcription. Create one in IRIS, then try again." }
  return { config: { ...live.config, bloqId } }
}

export function openLiveSession(
  cfg: LiveConfig,
  opts: { language?: string; onEvent: (event: LiveEvent) => void; onClose?: () => void },
): LiveSession {
  const url = new URL(`${cfg.relayUrl}/v1/stt/stream`)
  url.searchParams.set("bloq_id", cfg.bloqId)
  url.searchParams.set("language", opts.language || "en")
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol === "http:") url.protocol = "ws:"

  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.token}` } } as unknown as string[])
  ws.binaryType = "arraybuffer"
  const pending: (Uint8Array | string)[] = []
  let ended = false

  const emit = (event: LiveEvent) => {
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
    const event = parseRelayEvent(message.data)
    if (!event) return
    emit(event)
  }
  // A refused upgrade (401/403/429/503) surfaces as an error then a close with no open.
  ws.onerror = () => emit({ type: "unavailable", reason: "The live transcription service could not be reached." })
  ws.onclose = (event) => {
    if (event.code !== 1000) emit({ type: "unavailable", reason: event.reason || "Live transcription stopped." })
    ended = true
    opts.onClose?.()
  }

  const out = (frame: Uint8Array | string) => {
    if (ended) return
    if (ws.readyState === WebSocket.OPEN) return ws.send(frame)
    if (ws.readyState === WebSocket.CONNECTING) pending.push(frame)
  }

  return {
    send: (pcm) => out(pcm),
    finalize: () => out(JSON.stringify({ type: "finalize" })),
    done: () => out(JSON.stringify({ type: "audio.done" })),
    close: () => {
      ended = true
      ws.close()
    },
  }
}

/** Relay frame -> LiveEvent, or undefined for frames the UI does not need. */
export function parseRelayEvent(text: string): LiveEvent | undefined {
  const value = (() => {
    try {
      return JSON.parse(text) as {
        type?: unknown
        text?: unknown
        is_final?: unknown
        speech_final?: unknown
        message?: unknown
      }
    } catch {
      return undefined
    }
  })()
  if (!value) return undefined
  if (value.type === "relay.error")
    return { type: "unavailable", reason: typeof value.message === "string" ? value.message : "Live transcription stopped." }
  if (value.type !== "transcript.partial" || typeof value.text !== "string") return undefined
  if (value.is_final !== true) return { type: "partial", text: value.text }
  return value.speech_final === true ? { type: "final", text: value.text, turn: true } : { type: "final", text: value.text }
}
