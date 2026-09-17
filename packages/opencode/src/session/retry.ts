import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  /**
 * EMPTY FINALIZATION — a stream that ended without an error, without output, having produced
 * nothing. #157647 identified it; the handling then treated it as terminal.
 *
 * It is NOT terminal. Measured 2026-09-17 (#185820): a user hit it, typed "continue", and the
 * same request succeeded immediately. At that moment the proxy's failover was healthy
 * (`models:smoke --model=iris/iris-ai` passed sync+stream+tools) and the spare OpenCode Go
 * licence had 80% headroom — only the primary was capped. The old comment claimed a stream
 * "only finishes empty once EVERY provider has failed", so retrying was pointless. That premise
 * did not hold, and the cost of it not holding was the user retyping "continue".
 *
 * Retrying is safe precisely because of what defines this case: zero output parts and zero
 * output tokens, so there is nothing partial to duplicate.
 */
export const EMPTY_FINALIZATION_MAX_RETRIES = 2

export function isEmptyFinalization(input: { finish?: string; hasOutput: boolean; outputTokens: number }) {
  const badFinish = input.finish === undefined || input.finish === "unknown" || input.finish === "error"
  return badFinish && !input.hasOutput && input.outputTokens === 0
}

/** Bounded, and never against a cancelled request — an aborted turn must stay aborted. */
export function retryEmptyFinalization(input: { attempts: number; aborted: boolean }) {
  if (input.aborted) return false
  return input.attempts < EMPTY_FINALIZATION_MAX_RETRIES
}

export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    if (typeof error.data?.message === "string") {
      try {
        const json = JSON.parse(error.data.message)
        if (json.type === "error" && json.error?.type === "too_many_requests") {
          return "Too Many Requests"
        }
        if (json.code.includes("exhausted") || json.code.includes("unavailable")) {
          return "Provider is overloaded"
        }
        if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
          return "Rate Limited"
        }
        if (
          json.error?.message?.includes("no_kv_space") ||
          (json.type === "error" && json.error?.type === "server_error") ||
          !!json.error
        ) {
          return "Provider Server Error"
        }
      } catch {}
    }

    return undefined
  }
}
