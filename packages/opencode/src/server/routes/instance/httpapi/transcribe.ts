import { Effect, Layer, Queue, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  cancelCapture,
  currentLevel,
  ffmpegPath,
  isRecording,
  listInputDevices,
  onCaptureChunk,
  peakAmplitude,
  recorderReadiness,
  resolveCaptureDevice,
  soundSettingsHint,
  startCapture,
  stopCapture,
} from "@/transcribe/capture"
import { ChainError, effectiveEngines, transcribeWithFallback } from "@/transcribe/chain"
import { hold, listHeld, readHeld, release, type Held } from "@/transcribe/held"
import { splitWav } from "@/transcribe/segments"
import { openLiveSession, readLiveConfig } from "@/transcribe/live"
import { openSpeakSession } from "@/transcribe/speak"
import { describeRemoteConfig, readRemoteConfig } from "@/transcribe/remote"
import { localWhisperReady, TranscribeError } from "@/transcribe/local"

/**
 * LOOPBACK ONLY. These routes are a microphone and a way to send audio off the machine; reachable
 * from the LAN they are a microphone the LAN can switch on. --mdns (or any non-loopback
 * --hostname) binds 0.0.0.0, so the bind address cannot be trusted to keep them local.
 *
 * Mirrors main's /transcribe refusal, which checked the BOUND hostname because Hono could not see
 * the peer. Here the connection's own address is available, which is the stricter test: a
 * 0.0.0.0 server still answers its own machine and refuses everyone else.
 *
 * The Host header is checked too. A web page can rebind its own DNS name to 127.0.0.1 and reach
 * this server from the user's browser — the connection is then loopback, but the Host is the
 * page's name. No caller of ours ever sends one.
 *
 * A request with no peer address is an in-process call (Server.Default().app.fetch) and allowed.
 */
export function isLoopbackAddress(address: string) {
  const a = address.replace(/^::ffff:/i, "")
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

export function isLoopbackHost(host: string) {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1")
  return name === "localhost" || isLoopbackAddress(name)
}

function refusal(request: HttpServerRequest.HttpServerRequest) {
  const peer = Option.getOrUndefined(request.remoteAddress)
  const host = request.headers["host"]
  if ((peer === undefined || isLoopbackAddress(peer)) && (host === undefined || isLoopbackHost(host))) return
  return HttpServerResponse.jsonUnsafe(
    { error: "Refused: the voice routes are loopback-only and this request did not come from this machine." },
    { status: 403 },
  )
}

/** Wrap a voice-route handler in the loopback check. */
function localOnly<E, R>(
  handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return (request: HttpServerRequest.HttpServerRequest) => {
    const refused = refusal(request)
    return refused ? Effect.succeed(refused) : handler(request)
  }
}

/** router.add, behind the loopback check. Every voice route is registered through this. */
function add<E, R>(
  router: HttpRouter.HttpRouter,
  method: "GET" | "POST",
  path: `/${string}`,
  handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return router.add(method, path, localOnly(handler))
}

/**
 * Recorder readiness spawns ffmpeg (on Windows it enumerates DirectShow devices), so it is cached
 * briefly per ffmpeg path rather than re-measured on every poll.
 */
let readinessCache: { key: string | null; at: number; value: ReturnType<typeof recorderReadiness> } | undefined
function cachedRecorderReadiness() {
  const key = ffmpegPath()
  if (readinessCache && readinessCache.key === key && Date.now() - readinessCache.at < 10_000) return readinessCache.value
  const value = recorderReadiness(process.platform, key)
  readinessCache = { key, at: Date.now(), value }
  return value
}

/**
 * GET /transcribe/health — can dictation work right now, and if not, why. The composer reads this
 * to decide what to offer before the person presses anything.
 */
function health() {
  const remote = describeRemoteConfig()
  const whisper = localWhisperReady()
  return {
    recorder: cachedRecorderReadiness(),
    cloud: remote.config ? { configured: true } : { configured: false, reason: remote.reason },
    local: { whisper },
    engines: effectiveEngines({ remote: remote.config, local: whisper }),
  }
}

/**
 * POST /transcribe — dictation for the desktop app, transcribed by Grok.
 *
 * The webview records, posts the audio here, and this server forwards it to Grok (xAI) through
 * the IRIS platform. The audio LEAVES THE MACHINE. Since 2026-10-04 Grok is the primary engine;
 * other cloud engines and an already-installed on-device whisper are fallbacks (transcribe/chain.ts).
 *
 * Every recording is written to disk BEFORE any engine is called (transcribe/held.ts). If every
 * engine fails, the response carries `held: { id, seconds }` and the recording waits:
 *   GET  /transcribe/held          list recordings still waiting
 *   POST /transcribe/retry?id=     run the chain again on one; released on success
 *   POST /transcribe/discard?id=   delete one
 *   GET  /transcribe/health        { recorder: { sidecar, reason? }, cloud: { configured, reason? },
 *                                    local: { whisper }, engines: string[] }
 *   GET  /dictate/level            { level, seconds } — RMS of the last ~50 ms of a sidecar take
 *
 * A recording over the platform's size limit answers 413 and is NOT held: no retry can take it.
 * Every route here is loopback-only (see refusal) and sits behind the server password when set.
 *
 * The body is the raw audio, not multipart. Both ends of this are ours, and a raw body
 * avoids a multipart parser on a path that only ever carries one file.
 *
 * Registered BEFORE the UI catch-all in server.ts — `uiRoute` matches "*" "/*", so a route
 * added after it would never be reached.
 */
/**
 * Dictation capture, driven from the UI but performed HERE.
 *
 * The webview cannot record: Tauri's macOS shell implements no WKUIDelegate media-capture
 * callback, so WebKit never grants getUserMedia and hands back a track that emits nothing —
 * measured in the shipped app as a 10-second recording with peak 0.0000, while the app's own
 * microphone permission was granted. This process has that permission and can just record.
 */
/**
 * Run the engine chain on a recording that is already held. Shared by /transcribe,
 * /dictate/stop and /transcribe/retry: three ways audio arrives, ONE engine policy.
 *
 * Success releases the held file. Failure keeps it and answers 503 with the held id and every
 * attempt, so the UI can say what failed and offer a retry instead of a re-recording.
 */
async function transcribeHeld(
  held: Held | null,
  audio: Uint8Array,
  filename: string,
  language: string | undefined,
  extra: Record<string, unknown> = {},
) {
  const result = await transcribeSegments(audio, filename, language).catch((e: unknown) =>
    e instanceof Error ? e : new TranscribeError(String(e)),
  )
  // Over the platform's size limit: no engine and no retry will take it, so it is not kept.
  if (result instanceof ChainError && result.final) {
    if (held) release(held.id)
    return HttpServerResponse.jsonUnsafe(
      { error: result.message, attempts: result.attempts, ...extra },
      { status: result.status ?? 413 },
    )
  }
  if (result instanceof Error) {
    // Ended on a rate limit: tell the app when the platform said to come back, so its automatic
    // retry of the held recording does not arrive early into the same 429.
    const last = result instanceof ChainError ? result.attempts.at(-1) : undefined
    const wait = last?.status === 429 ? last.retryAfterMs : undefined
    return HttpServerResponse.jsonUnsafe(
      {
        error: result.message,
        held: held ? { id: held.id, seconds: held.seconds } : undefined,
        attempts: result instanceof ChainError ? result.attempts : [],
        ...extra,
      },
      { status: 503, headers: wait !== undefined ? { "retry-after": String(Math.ceil(wait / 1000)) } : undefined },
    )
  }
  if (held) release(held.id)
  return HttpServerResponse.jsonUnsafe({
    text: result.text,
    provider: result.provider,
    attempts: result.attempts,
    ...extra,
  })
}

/**
 * The engine chain over a recording too long for one upload (background takes run up to an hour):
 * consecutive segments, text joined in order. Any segment failing fails the whole take, so the held
 * recording is kept until every part has a transcript.
 */
async function transcribeSegments(audio: Uint8Array, filename: string, language: string | undefined) {
  const remote = readRemoteConfig()
  const parts = splitWav(audio)
  if (parts.length === 1) return transcribeWithFallback(audio, { filename, language, remote })
  const results = []
  for (const part of parts) results.push(await transcribeWithFallback(part, { filename, language, remote }))
  return {
    text: results
      .map((r) => r.text.trim())
      .filter(Boolean)
      .join(" "),
    provider: results[0]!.provider,
    attempts: results.flatMap((r) => r.attempts),
  }
}

/** Holding is the safety net, not a precondition: a full disk must not also block transcription. */
function holdOrNull(audio: Uint8Array) {
  try {
    return hold(audio)
  } catch {
    return null
  }
}

export const dictateRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* add(router, "POST", "/dictate/start", (request) =>
      Effect.sync(() => {
        try {
          // ?device=<name> is the Settings choice. A mic that is not plugged in records from the
          // default instead of failing the take, and the response says so.
          const params = new URL(request.url, "http://localhost").searchParams
          const requested = params.get("device")?.trim() || undefined
          const device = resolveCaptureDevice(requested)
          // ?max_seconds= lifts the 5-minute cap for background recordings; capture.ts bounds it.
          const maxSeconds = Number(params.get("max_seconds")) || undefined
          const { startedAt } = startCapture(device, maxSeconds)
          return HttpServerResponse.jsonUnsafe({
            recording: true,
            startedAt,
            device: requested ? { requested, found: device !== undefined } : undefined,
          })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe({ error: e instanceof Error ? e.message : String(e) }, { status: 409 })
        }
      }),
    )

    yield* add(router, "POST", "/dictate/stop", () =>
      Effect.tryPromise({
        try: async () => {
          const { audio, ms, input } = await stopCapture()

          // Speech models answer silence with a confident "You". Refusing here means a dead input
          // device never arrives disguised as a bad transcription, and silence is never uploaded.
          const peak = peakAmplitude(audio)
          if (peak < 0.01) {
            return HttpServerResponse.jsonUnsafe(
              {
                error: `The microphone recorded silence (peak ${peak.toFixed(4)}). Check the input device in ${soundSettingsHint()}.`,
                peak,
              },
              { status: 422 },
            )
          }

          // `capture` names which process recorded this. The two capture paths fail in completely
          // different ways and a transcript alone cannot tell you which one ran.
          return transcribeHeld(holdOrNull(audio), audio, "dictation.wav", undefined, { ms, peak, capture: "sidecar", input })
        },
        catch: (e) => (e instanceof TranscribeError ? e : new TranscribeError(String(e))),
      }).pipe(
        Effect.catch((e) => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: e.message }, { status: 500 }))),
      ),
    )

    yield* add(router, "POST", "/dictate/cancel", () =>
      Effect.sync(() => {
        cancelCapture()
        return HttpServerResponse.jsonUnsafe({ recording: false })
      }),
    )

    yield* add(router, "GET", "/dictate/status", () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ recording: isRecording() })),
    )

    // RMS of the last ~50 ms of the sidecar recording, for the composer's level meter; {0, 0} idle.
    yield* add(router, "GET", "/dictate/level", () => Effect.sync(() => HttpServerResponse.jsonUnsafe(currentLevel())))

    // Live dictation preview: a WebSocket from the composer, bridged to the IRIS STT relay.
    //   ?source=window   the client sends 16 kHz PCM16 frames as it records
    //   ?source=sidecar  this server feeds the relay from its own capture (onCaptureChunk)
    // Client frames carry a 1-byte tag (see decodeLiveFrame) — the socket layer delivers text and
    // binary frames alike as bytes, so a JSON control message would otherwise be forwarded as audio
    // (measured: audio.done arrived at the relay as 21 bytes of "audio"). Server frames: LiveEvent
    // JSON ({type:"partial"|"final"|"unavailable"}). Every failure becomes one "unavailable" and a
    // close — the batch transcription of the held recording is the result that counts.
    yield* add(router, "GET", "/dictate/live", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const fromSidecar = url.searchParams.get("source") === "sidecar"
        const socket = yield* Effect.orDie(request.upgrade)
        const write = yield* socket.writer
        const outbox = yield* Queue.unbounded<string | Socket.CloseEvent>()
        const closeWith = (event?: { type: "unavailable"; reason: string }) => {
          if (event) Queue.offerUnsafe(outbox, JSON.stringify(event))
          Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000))
        }

        const live = readLiveConfig()
        const session =
          "config" in live
            ? openLiveSession(live.config, {
                language: url.searchParams.get("language") ?? undefined,
                onEvent: (event) =>
                  event.type === "unavailable" ? closeWith(event) : Queue.offerUnsafe(outbox, JSON.stringify(event)),
                onClose: () => closeWith(),
              })
            : undefined
        if (!session) closeWith({ type: "unavailable", reason: "reason" in live ? live.reason : "unavailable" })
        const unsubscribe = session && fromSidecar ? onCaptureChunk((pcm) => session.send(pcm)) : undefined

        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(outbox)
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })
        yield* Effect.race(
          drain,
          socket.runRaw((message) => {
            if (!session) return
            const frame = decodeLiveFrame(message)
            if (frame?.kind === "audio") session.send(frame.pcm)
            if (frame?.kind === "finalize") session.finalize()
            if (frame?.kind === "done") session.done()
          }),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              unsubscribe?.()
              session?.close()
            }),
          ),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )

    // Spoken replies: a WebSocket from the window, bridged to the relay's /v1/tts/stream.
    //   client -> server: JSON text frames {"type":"text.delta","delta"}, {"type":"text.done"},
    //                     {"type":"text.clear"} (the socket layer hands them over as bytes; they are
    //                     decoded as UTF-8 JSON — this socket never carries client audio)
    //   server -> client: BINARY frames of 24 kHz mono PCM16, and JSON {"type":"done"|"cleared"|
    //                     "unavailable"}. Every failure is one "unavailable" and a close.
    yield* add(router, "GET", "/voice/speak", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const socket = yield* Effect.orDie(request.upgrade)
        const write = yield* socket.writer
        const outbox = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
        const closeWith = (event?: { type: "unavailable"; reason: string }) => {
          if (event) Queue.offerUnsafe(outbox, JSON.stringify(event))
          Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000))
        }

        const live = readLiveConfig()
        const session =
          "config" in live
            ? openSpeakSession(live.config, {
                voice: url.searchParams.get("voice") ?? undefined,
                language: url.searchParams.get("language") ?? undefined,
                onAudio: (pcm) => Queue.offerUnsafe(outbox, pcm),
                onEvent: (event) =>
                  event.type === "unavailable" ? closeWith(event) : Queue.offerUnsafe(outbox, JSON.stringify(event)),
                onClose: () => closeWith(),
              })
            : undefined
        if (!session) closeWith({ type: "unavailable", reason: "reason" in live ? live.reason : "unavailable" })

        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(outbox)
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })
        yield* Effect.race(
          drain,
          socket.runRaw((message) => {
            if (!session) return
            const frame = decodeSpeakFrame(message)
            if (frame?.type === "text.delta") session.text(frame.delta)
            if (frame?.type === "text.done") session.done()
            if (frame?.type === "text.clear") session.clear()
          }),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(Effect.sync(() => session?.close())),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )

    // Microphone names for the Settings picker, behind the same loopback guard as every voice route.
    yield* add(router, "GET", "/dictate/devices", () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ devices: listInputDevices().map((name) => ({ name })) })),
    )
  }),
)

export const transcribeRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* add(router, "POST", "/transcribe", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")

        // Collect the raw body. Effect gives the request as a byte stream; there is no
        // Content-Length to trust on a chunked upload from MediaRecorder.
        // runFold takes a LazyArg for the seed in this Effect version, not a value.
        const chunks: Uint8Array[] = yield* Stream.runFold(
          request.stream,
          (): Uint8Array[] => [],
          (acc: Uint8Array[], chunk: Uint8Array) => {
            acc.push(chunk)
            return acc
          },
        )
        const total = chunks.reduce((n: number, c: Uint8Array) => n + c.byteLength, 0)

        // An unbounded body on a local daemon is a way to fill someone's disk. 200MB is
        // hours of speech.
        const MAX = 200 * 1024 * 1024
        if (total === 0) {
          return HttpServerResponse.jsonUnsafe({ error: "no audio in request body" }, { status: 400 })
        }
        if (total > MAX) {
          return HttpServerResponse.jsonUnsafe({ error: `audio exceeds ${MAX} bytes` }, { status: 413 })
        }

        const audio = new Uint8Array(total)
        let offset = 0
        for (const c of chunks) {
          audio.set(c, offset)
          offset += c.byteLength
        }

        return yield* Effect.promise(() =>
          transcribeHeld(
            holdOrNull(audio),
            audio,
            url.searchParams.get("filename") ?? "dictation.wav",
            url.searchParams.get("language") ?? undefined,
          ),
        )
      }),
    )

    yield* add(router, "GET", "/transcribe/health", () => Effect.sync(() => HttpServerResponse.jsonUnsafe(health())))

    yield* add(router, "GET", "/transcribe/held", () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ held: listHeld() })),
    )

    yield* add(router, "POST", "/transcribe/retry", (request) =>
      Effect.gen(function* () {
        const id = new URL(request.url, "http://localhost").searchParams.get("id") ?? ""
        const audio = readHeld(id)
        if (!audio)
          return HttpServerResponse.jsonUnsafe({ error: "That recording is no longer saved." }, { status: 404 })
        const held = listHeld().find((h) => h.id === id) ?? { id, bytes: audio.byteLength, seconds: 0, createdAt: 0 }
        return yield* Effect.promise(() => transcribeHeld(held, audio, "dictation.wav", undefined, { id }))
      }),
    )

    yield* add(router, "POST", "/transcribe/discard", (request) =>
      Effect.sync(() => {
        release(new URL(request.url, "http://localhost").searchParams.get("id") ?? "")
        return HttpServerResponse.jsonUnsafe({ discarded: true })
      }),
    )
  }),
)

/**
 * A client frame on /dictate/live: byte 0 is the tag, the rest the payload.
 *   0x00 + PCM16 audio   0x01 + "finalize"   0x02 + "audio.done"
 * Strings are accepted too (the same tag as a character) for clients whose sockets send text.
 */
export function decodeLiveFrame(
  message: string | Uint8Array,
): { kind: "audio"; pcm: Uint8Array } | { kind: "finalize" } | { kind: "done" } | undefined {
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message
  if (bytes.byteLength === 0) return undefined
  if (bytes[0] === 0x00) return bytes.byteLength > 1 ? { kind: "audio", pcm: bytes.subarray(1) } : undefined
  if (bytes[0] === 0x01) return { kind: "finalize" }
  if (bytes[0] === 0x02) return { kind: "done" }
  return undefined
}

/** A client frame on /voice/speak: UTF-8 JSON, allowlisted to the three speech messages. */
export function decodeSpeakFrame(
  message: string | Uint8Array,
): { type: "text.delta"; delta: string } | { type: "text.done" } | { type: "text.clear" } | undefined {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message)
  const value = (() => {
    try {
      return JSON.parse(text) as { type?: unknown; delta?: unknown }
    } catch {
      return undefined
    }
  })()
  if (value?.type === "text.delta" && typeof value.delta === "string" && value.delta) return { type: "text.delta", delta: value.delta }
  if (value?.type === "text.done") return { type: "text.done" }
  if (value?.type === "text.clear") return { type: "text.clear" }
  return undefined
}
