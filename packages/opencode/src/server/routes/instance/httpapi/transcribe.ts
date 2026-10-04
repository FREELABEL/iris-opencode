import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { cancelCapture, isRecording, peakAmplitude, startCapture, stopCapture } from "@/transcribe/capture"
import { ChainError, transcribeWithFallback } from "@/transcribe/chain"
import { hold, listHeld, readHeld, release, type Held } from "@/transcribe/held"
import { readRemoteConfig } from "@/transcribe/remote"
import { TranscribeError } from "@/transcribe/local"

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
  const result = await transcribeWithFallback(audio, { filename, language, remote: readRemoteConfig() }).catch(
    (e: unknown) => (e instanceof Error ? e : new TranscribeError(String(e))),
  )
  if (result instanceof Error)
    return HttpServerResponse.jsonUnsafe(
      {
        error: result.message,
        held: held ? { id: held.id, seconds: held.seconds } : undefined,
        attempts: result instanceof ChainError ? result.attempts : [],
        ...extra,
      },
      { status: 503 },
    )
  if (held) release(held.id)
  return HttpServerResponse.jsonUnsafe({
    text: result.text,
    provider: result.provider,
    attempts: result.attempts,
    ...extra,
  })
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
    yield* router.add("POST", "/dictate/start", () =>
      Effect.sync(() => {
        try {
          const { startedAt } = startCapture()
          return HttpServerResponse.jsonUnsafe({ recording: true, startedAt })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe({ error: e instanceof Error ? e.message : String(e) }, { status: 409 })
        }
      }),
    )

    yield* router.add("POST", "/dictate/stop", () =>
      Effect.tryPromise({
        try: async () => {
          const { audio, ms } = await stopCapture()

          // Speech models answer silence with a confident "You". Refusing here means a dead input
          // device never arrives disguised as a bad transcription, and silence is never uploaded.
          const peak = peakAmplitude(audio)
          if (peak < 0.01) {
            return HttpServerResponse.jsonUnsafe(
              {
                error: `The microphone recorded silence (peak ${peak.toFixed(4)}). Check the input device in System Settings › Sound.`,
                peak,
              },
              { status: 422 },
            )
          }

          // `capture` names which process recorded this. The two capture paths fail in completely
          // different ways and a transcript alone cannot tell you which one ran.
          return transcribeHeld(holdOrNull(audio), audio, "dictation.wav", undefined, { ms, peak, capture: "sidecar" })
        },
        catch: (e) => (e instanceof TranscribeError ? e : new TranscribeError(String(e))),
      }).pipe(
        Effect.catch((e) => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: e.message }, { status: 500 }))),
      ),
    )

    yield* router.add("POST", "/dictate/cancel", () =>
      Effect.sync(() => {
        cancelCapture()
        return HttpServerResponse.jsonUnsafe({ recording: false })
      }),
    )

    yield* router.add("GET", "/dictate/status", () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ recording: isRecording() })),
    )
  }),
)

export const transcribeRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("POST", "/transcribe", (request) =>
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

    yield* router.add("GET", "/transcribe/held", () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ held: listHeld() })),
    )

    yield* router.add("POST", "/transcribe/retry", (request) =>
      Effect.gen(function* () {
        const id = new URL(request.url, "http://localhost").searchParams.get("id") ?? ""
        const audio = readHeld(id)
        if (!audio)
          return HttpServerResponse.jsonUnsafe({ error: "That recording is no longer saved." }, { status: 404 })
        const held = listHeld().find((h) => h.id === id) ?? { id, bytes: audio.byteLength, seconds: 0, createdAt: 0 }
        return yield* Effect.promise(() => transcribeHeld(held, audio, "dictation.wav", undefined, { id }))
      }),
    )

    yield* router.add("POST", "/transcribe/discard", (request) =>
      Effect.sync(() => {
        release(new URL(request.url, "http://localhost").searchParams.get("id") ?? "")
        return HttpServerResponse.jsonUnsafe({ discarded: true })
      }),
    )
  }),
)
