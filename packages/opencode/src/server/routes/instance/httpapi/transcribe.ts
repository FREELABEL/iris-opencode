import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { transcribeLocal, TranscribeError } from "@/transcribe/local"

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
