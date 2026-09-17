import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("sleep caps delay to max 32-bit signed integer to avoid TimeoutOverflowWarning", async () => {
    const controller = new AbortController()

    const warnings: string[] = []
    const originalWarn = process.emitWarning
    process.emitWarning = (warning: string | Error) => {
      warnings.push(typeof warning === "string" ? warning : warning.message)
    }

    const promise = SessionRetry.sleep(2_560_914_000, controller.signal)
    controller.abort()

    try {
      await promise
    } catch {}

    process.emitWarning = originalWarn
    expect(warnings.some((w) => w.includes("TimeoutOverflowWarning"))).toBe(false)
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await Bun.sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID: "test" })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })
})

describe("session.retry.isEmptyFinalization", () => {
  // The shape #157647 named: the stream ended, nothing came back, and NO error event fired —
  // so without this the turn renders as an empty bubble and `iris run` exits zero.
  const empty = { finish: undefined as string | undefined, hasOutput: false, outputTokens: 0 }

  test("no finish, no output, no tokens is an empty finalization", () => {
    expect(SessionRetry.isEmptyFinalization(empty)).toBe(true)
  })

  test("'unknown' and 'error' finishes count too", () => {
    expect(SessionRetry.isEmptyFinalization({ ...empty, finish: "unknown" })).toBe(true)
    expect(SessionRetry.isEmptyFinalization({ ...empty, finish: "error" })).toBe(true)
  })

  test("a normal finish is NOT one, even with nothing to show", () => {
    // A model may legitimately stop with no text (e.g. 'stop' after a tool result).
    expect(SessionRetry.isEmptyFinalization({ ...empty, finish: "stop" })).toBe(false)
    expect(SessionRetry.isEmptyFinalization({ ...empty, finish: "tool-calls" })).toBe(false)
  })

  test("ANY output disqualifies it — a partial answer must never be retried", () => {
    // This is the safety property the retry rests on: retrying can only duplicate work if
    // something was already produced, so 'produced something' has to exclude it.
    expect(SessionRetry.isEmptyFinalization({ ...empty, hasOutput: true })).toBe(false)
    expect(SessionRetry.isEmptyFinalization({ ...empty, outputTokens: 12 })).toBe(false)
    expect(SessionRetry.isEmptyFinalization({ finish: "unknown", hasOutput: true, outputTokens: 12 })).toBe(false)
  })
})

describe("session.retry.retryEmptyFinalization", () => {
  test("retries, then stops at the cap", () => {
    // #185820: the old code never retried at all — the user typed 'continue' by hand and the
    // same request succeeded first try.
    const attempts = Array.from({ length: SessionRetry.EMPTY_FINALIZATION_MAX_RETRIES + 2 }, (_, i) =>
      SessionRetry.retryEmptyFinalization({ attempts: i, aborted: false }),
    )
    expect(attempts.slice(0, SessionRetry.EMPTY_FINALIZATION_MAX_RETRIES).every(Boolean)).toBe(true)
    expect(attempts.slice(SessionRetry.EMPTY_FINALIZATION_MAX_RETRIES).some(Boolean)).toBe(false)
  })

  test("it is bounded — a dead provider still ends the turn", () => {
    expect(SessionRetry.EMPTY_FINALIZATION_MAX_RETRIES).toBeGreaterThan(0)
    expect(SessionRetry.retryEmptyFinalization({ attempts: 99, aborted: false })).toBe(false)
  })

  test("an ABORTED turn is never retried", () => {
    // Otherwise cancelling would be answered by another request.
    expect(SessionRetry.retryEmptyFinalization({ attempts: 0, aborted: true })).toBe(false)
  })

  test("the delay it uses is the existing backoff, not an immediate hammer", () => {
    expect(SessionRetry.delay(1)).toBeGreaterThanOrEqual(1000)
    expect(SessionRetry.delay(2)).toBeGreaterThan(SessionRetry.delay(1))
  })
})
