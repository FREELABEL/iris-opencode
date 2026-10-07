import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { resolveSttPolicy, type SttPolicy } from "./stt-policy"

/**
 * Live dictation — "see your words as you speak" — for `iris listen` and the TUI dictate key.
 *
 * A port of the Desktop sidecar's transcribe/live.ts (branch iris/1.18.23). It streams the
 * 16 kHz mono PCM16 that cli/lib/mic.ts taps off the capture to the IRIS STT relay
 * (fl-iris-api services/stt-relay, xAI streaming STT behind it) and turns what comes back into
 * one line of preview text.
 *
 * Live text is a PREVIEW. The wav is still written and transcribed by the batch path when the
 * recording stops, and THAT is what gets printed or inserted. So every failure here degrades to
 * "unavailable" and nothing else — it never fails a dictation, and it never touches the file.
 *
 * It sends audio OFF THE MACHINE, so it sits under the same ceiling as every other egress:
 * cli/lib/stt-policy. Under `sovereign` (the default) no socket is opened at all.
 *
 * xAI's partials are cumulative within an utterance: each restates the utterance so far, and an
 * is_final partial locks it before the next utterance starts. xAI has been seen sending the same
 * final twice in a row, so a repeated final is dropped.
 */

/** fl-iris-api services/stt-relay, deployed as the iris-stt-relay Railway service (2026-10-05). */
export const DEFAULT_RELAY_URL = "https://iris-stt-relay-production.up.railway.app"

export type LiveEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "unavailable"; reason: string }

export interface LiveSession {
  /** 16 kHz mono PCM16. Dropped silently once the session is no longer streaming. */
  send(pcm: Uint8Array): void
  /** Lock the current utterance. */
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

export interface LiveConfigDeps {
  env?: Record<string, string | undefined>
  policy?: SttPolicy
  /** The CLI's signed-in token. Defaults to iris-api's resolveToken (auth store → env → sdk .env → config). */
  token?: () => Promise<string>
  configPath?: string
  /** The person's default board when none is configured. Defaults to asking the platform. */
  board?: (token: string) => Promise<string | undefined>
}

/**
 * Credentials the platform accepts as a person: a Passport JWT, a 64-character SDK token, or a
 * prefixed iris_/fl_ API token. The relay validates the token with fl-api whoami, which refuses
 * a node_api_key — so one is never sent, the same rule the Desktop's remote.ts applies.
 */
export function isPersonToken(token: string): boolean {
  if (/^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return true
  if (/^[A-Za-z0-9]{64}$/.test(token)) return true
  return /^(iris_|fl_)[A-Za-z0-9_-]{8,}$/.test(token)
}

function off(value: string | undefined): boolean {
  return ["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase())
}

/**
 * Relay URL, IRIS token and board — or the reason live dictation cannot start.
 *
 * The order is deliberate: the switches and the POLICY are checked before any credential is
 * read, so a sovereign machine never even resolves a token for this path.
 */
export async function resolveLiveConfig(
  deps: LiveConfigDeps = {},
): Promise<{ config: LiveConfig } | { reason: string }> {
  const env = deps.env ?? process.env
  // IRIS_STT_RELAY_URL=off is the Desktop's switch; IRIS_LIVE_DICTATION=0 is the obvious name.
  const relayUrl = env["IRIS_STT_RELAY_URL"]?.trim() || DEFAULT_RELAY_URL
  if (relayUrl === "off" || off(env["IRIS_LIVE_DICTATION"]))
    return { reason: "Live transcription is turned off on this machine." }

  const policy = deps.policy ?? resolveSttPolicy()
  if (policy !== "standard")
    return {
      reason: "Live transcription is off: transcription policy is 'sovereign', so audio stays on this machine.",
    }

  let bloqId = env["IRIS_TRANSCRIBE_BLOQ_ID"]?.trim() || ""
  if (!bloqId) {
    try {
      const path = deps.configPath ?? join(homedir(), ".iris", "config.json")
      if (existsSync(path)) {
        const cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        bloqId = String(cfg["default_bloq_id"] ?? "").trim()
      }
    } catch {
      /* an unreadable config is the same as no config */
    }
  }

  let token = ""
  try {
    token = (await (deps.token ?? (async () => (await import("../cmd/iris-api")).resolveToken()))()).trim()
  } catch {
    token = ""
  }
  if (!token || !isPersonToken(token))
    return { reason: "Live transcription needs you signed in to IRIS — run: iris auth login" }
  // The relay checks the board's cloud (PHI) policy with this board, so there is no unscoped path.
  // No board configured is normal, as on Desktop: the platform names the person's own board.
  if (!bloqId) bloqId = (await (deps.board ?? (async (t: string) => defaultBoard(t, env, deps.configPath)))(token)) ?? ""
  if (!bloqId) return { reason: "Live transcription could not find a board to file this under." }

  return { config: { relayUrl: relayUrl.replace(/\/$/, ""), token, bloqId } }
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

  let ended = false
  const emit = (event: LiveEvent) => {
    if (ended) return
    if (event.type === "unavailable") ended = true
    opts.onEvent(event)
  }

  let ws: WebSocket
  try {
    // Bun's WebSocket takes headers; the browser's does not — this runs in the CLI only.
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.token}` } } as unknown as string[])
  } catch {
    queueMicrotask(() => emit({ type: "unavailable", reason: "The live transcription service could not be reached." }))
    ended = true
    return { send() {}, finalize() {}, done() {}, close() {} }
  }
  ws.binaryType = "arraybuffer"
  const pending: (Uint8Array | string)[] = []
  let lastFinal = ""

  ws.onopen = () => {
    for (const frame of pending) ws.send(frame)
    pending.length = 0
  }
  ws.onmessage = (message) => {
    if (typeof message.data !== "string") return
    const event = parseRelayEvent(message.data)
    if (!event) return
    if (event.type === "final") {
      if (event.text === lastFinal) return
      lastFinal = event.text
    }
    emit(event)
  }
  // A refused upgrade (401/403/429/503) surfaces as an error then a close with no open.
  ws.onerror = () => emit({ type: "unavailable", reason: "The live transcription service could not be reached." })
  ws.onclose = (event) => {
    if (event.code !== 1000) emit({ type: "unavailable", reason: event.reason || "Live transcription stopped." })
    ended = true
    pending.length = 0
    opts.onClose?.()
  }

  const out = (frame: Uint8Array | string) => {
    if (ended) return
    try {
      if (ws.readyState === WebSocket.OPEN) return ws.send(frame)
      // Bounded: a relay that never answers must not hold a whole recording in memory.
      if (ws.readyState === WebSocket.CONNECTING && pending.length < 400) pending.push(frame)
    } catch {
      /* a send on a dying socket — onclose reports it */
    }
  }

  return {
    send: (pcm) => out(pcm),
    finalize: () => out(JSON.stringify({ type: "finalize" })),
    done: () => out(JSON.stringify({ type: "audio.done" })),
    close: () => {
      ended = true
      pending.length = 0
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    },
  }
}

/** Relay frame -> LiveEvent, or undefined for frames the UI does not need. */
export function parseRelayEvent(text: string): LiveEvent | undefined {
  const value = (() => {
    try {
      return JSON.parse(text) as { type?: unknown; text?: unknown; is_final?: unknown; message?: unknown }
    } catch {
      return undefined
    }
  })()
  if (!value || typeof value !== "object") return undefined
  if (value.type === "relay.error")
    return {
      type: "unavailable",
      reason: typeof value.message === "string" ? value.message : "Live transcription stopped.",
    }
  if (value.type !== "transcript.partial" || typeof value.text !== "string") return undefined
  return value.is_final === true ? { type: "final", text: value.text } : { type: "partial", text: value.text }
}

// ---------------------------------------------------------------------------
// The preview both surfaces use
// ---------------------------------------------------------------------------

export interface LivePreview {
  /** Feed captured PCM. Safe to call before the session exists and after it has died. */
  push(pcm: Uint8Array): void
  /** End of audio. The socket is closed shortly after; the preview's text stays readable. */
  stop(): void
  /** Locked utterances plus the current partial — what to draw. */
  text(): string
  /** "connecting" until configured, then "live", or "unavailable" with a reason. */
  state(): "connecting" | "live" | "unavailable"
  reason(): string | undefined
}

export interface LivePreviewOptions {
  language?: string
  /** Called whenever text() changes. */
  onText?: (text: string) => void
  /**
   * Called once, if live dictation cannot run ("setup": off, policy, not signed in) or the
   * stream fails ("stream"). The recording carries on regardless.
   */
  onUnavailable?: (reason: string, phase: "setup" | "stream") => void
  /** Injection points for tests. */
  resolve?: () => Promise<{ config: LiveConfig } | { reason: string }>
  open?: typeof openLiveSession
}

/** PCM buffered while the token resolves: 5 s of 16 kHz mono PCM16. */
const MAX_EARLY_BYTES = 5 * 16000 * 2

/**
 * Start a live preview. Returns immediately; configuration and the socket happen in the
 * background, and PCM pushed meanwhile is held (bounded) and sent once the session exists.
 */
export function startLivePreview(opts: LivePreviewOptions = {}): LivePreview {
  let state: "connecting" | "live" | "unavailable" = "connecting"
  let reason: string | undefined
  let session: LiveSession | undefined
  let stopped = false
  let committed = ""
  let partial = ""
  const early: Uint8Array[] = []
  let earlyBytes = 0
  // PCM16 frames must stay sample-aligned; a pipe chunk can end on an odd byte.
  let odd: Uint8Array | undefined

  const text = () => [committed, partial].filter(Boolean).join(" ")

  const unavailable = (why: string, phase: "setup" | "stream" = "stream") => {
    if (state === "unavailable") return
    state = "unavailable"
    reason = why
    early.length = 0
    session?.close()
    opts.onUnavailable?.(why, phase)
  }

  const onEvent = (event: LiveEvent) => {
    if (event.type === "unavailable") return unavailable(event.reason)
    state = "live"
    if (event.type === "partial") partial = event.text
    else {
      committed = [committed, event.text].filter(Boolean).join(" ")
      partial = ""
    }
    opts.onText?.(text())
  }

  const align = (pcm: Uint8Array): Uint8Array | undefined => {
    let bytes = pcm
    if (odd) {
      const joined = new Uint8Array(odd.length + pcm.length)
      joined.set(odd)
      joined.set(pcm, odd.length)
      bytes = joined
      odd = undefined
    }
    if (bytes.length % 2 === 1) {
      odd = bytes.slice(bytes.length - 1)
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    return bytes.length ? bytes : undefined
  }

  void (async () => {
    let resolved: { config: LiveConfig } | { reason: string }
    try {
      resolved = await (opts.resolve ?? resolveLiveConfig)()
    } catch (e) {
      resolved = { reason: e instanceof Error ? e.message : String(e) }
    }
    if ("reason" in resolved) return unavailable(resolved.reason, "setup")
    // Stopped before any audio arrived (the recorder failed to start): nothing to send, so no socket.
    if (stopped && early.length === 0) return
    try {
      session = (opts.open ?? openLiveSession)(resolved.config, { language: opts.language, onEvent })
    } catch (e) {
      return unavailable(e instanceof Error ? e.message : String(e))
    }
    for (const chunk of early) session.send(chunk)
    early.length = 0
    if (stopped) finish()
  })()

  let closer: ReturnType<typeof setTimeout> | undefined
  function finish() {
    if (!session || state === "unavailable") return
    session.done()
    // The batch transcript is what gets used; the last finals only matter if they land while
    // the batch runs. Give them a moment, then let the socket go.
    closer = setTimeout(() => session?.close(), 3000)
    ;(closer as { unref?: () => void }).unref?.()
  }

  return {
    push(pcm) {
      if (stopped || state === "unavailable") return
      const bytes = align(pcm)
      if (!bytes) return
      if (session) return session.send(bytes)
      if (earlyBytes + bytes.length > MAX_EARLY_BYTES) return
      early.push(bytes.slice())
      earlyBytes += bytes.length
    },
    stop() {
      if (stopped) return
      stopped = true
      finish()
    },
    text,
    state: () => state,
    reason: () => reason,
  }
}

/** The preview squeezed into `width` columns, keeping the newest words — they are the point. */
export function livePreviewLine(text: string, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (width <= 1) return ""
  if (clean.length <= width) return clean
  return "…" + clean.slice(clean.length - (width - 1))
}

/** The board the platform files this person's takes under when none is configured (#188013). */
async function defaultBoard(token: string, env: Record<string, string | undefined>, configPath?: string): Promise<string | undefined> {
  const { resolvePlatformConfig, resolveBoard } = await import("./platform-transcribe")
  const p = await resolvePlatformConfig({ env, configPath, token: async () => token })
  return "config" in p ? resolveBoard(p.config) : undefined
}
