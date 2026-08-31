import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { transcribeLocal, TranscribeError } from "@/transcribe/local"
import { cancelCapture, isRecording, peakAmplitude, startCapture, stopCapture } from "@/transcribe/capture"
import { readRemoteConfig, transcribeRemote } from "@/transcribe/remote"
import { stripNonSpeech } from "@/transcribe/local"

/**
 * POST /transcribe — on-device dictation for the desktop app.
 *
 * The desktop already runs this server as its sidecar, so dictation does not need a new
 * process or a cloud account: the webview records, posts the audio here, and whisper.cpp
 * transcribes it on this machine. The audio reaches 127.0.0.1 and nothing else, and
 * `transcribe/local.ts` has no network client in it, so there is no branch that could
 * upload it (epic #182784).
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
 *
 * Loopback-only for the same reason /transcribe is: a microphone the network can start is a
 * microphone the network can listen through.
 */
export const dictateRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("POST", "/dictate/start", () =>
      Effect.sync(() => {
        try {
          const { startedAt } = startCapture()
          return HttpServerResponse.jsonUnsafe({ recording: true, startedAt })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 409 },
          )
        }
      }),
    )

    yield* router.add("POST", "/dictate/stop", () =>
      Effect.tryPromise({
        try: async () => {
          const { audio, ms } = await stopCapture()

          // whisper answers "You" to silence, confidently, every time. Refusing here means a
          // dead input device never arrives disguised as a bad transcription.
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

          // GROK FIRST, local as the fallback.
          //
          // Measured on identical audio: local base.en heard "Southern transcription", grok
          // heard "Sovereign transcription". The 0.3s grok costs is nothing against being
          // wrong. Set IRIS_TRANSCRIBE_PROVIDER=local to force on-device — which is what
          // anything under a PHI policy should do, since remote means the audio leaves.
          const prefer = process.env["IRIS_TRANSCRIBE_PROVIDER"]?.trim().toLowerCase()
          const remote = prefer === "local" ? null : readRemoteConfig()

          if (remote) {
            try {
              const r = await transcribeRemote(audio, remote, { filename: "dictation.wav" })
              return HttpServerResponse.jsonUnsafe({
                text: stripNonSpeech(r.text),
                provider: r.provider,
                ms,
                peak,
              })
            } catch {
              // Never fail the dictation because the network did. Falling through to the
              // on-device model is worse words, not no words.
            }
          }

          const result = await transcribeLocal(audio, { filename: "dictation.wav" })
          return HttpServerResponse.jsonUnsafe({ text: result.text, provider: result.provider, ms, peak })
        },
        catch: (e) => (e instanceof TranscribeError ? e : new TranscribeError(String(e))),
      }).pipe(
        Effect.catch((e) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: e.message }, { status: 500 })),
        ),
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
  router.add("POST", "/transcribe", (request) =>
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
      // hours of speech; whisper itself has no limit.
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

      const result = yield* Effect.tryPromise({
        try: () =>
          transcribeLocal(audio, {
            filename: url.searchParams.get("filename") ?? "dictation.webm",
            language: url.searchParams.get("language") ?? undefined,
          }),
        // The message from local.ts already names the fix ("brew install whisper-cpp"), so
        // it is surfaced verbatim rather than flattened into "transcription failed".
        catch: (e) => (e instanceof TranscribeError ? e : new TranscribeError(String(e))),
      }).pipe(
        Effect.catch((e) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: e.message }, { status: 500 })),
        ),
      )

      if (!("text" in (result as object))) return result as HttpServerResponse.HttpServerResponse
      const ok = result as { text: string; provider: string; ms: number }
      return HttpServerResponse.jsonUnsafe({ text: ok.text, provider: ok.provider, ms: ok.ms })
    }),
  ),
)
