import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"

// IRIS's own spending cap. Distinct from the two OpenCode limits below: those are a vendor
// throttling us, this is us refusing us. The server marks it `limit_source: iris_billing_gate`,
// which is the only field in the body that cannot also be produced by a provider.
export const IRIS_LIMIT_SOURCE = "iris_billing_gate"
export const IRIS_UPGRADE_URL = "https://web.heyiris.io/pricing?source=desktop-limit"

export type RetryReason = "free_tier_limit" | "account_rate_limit" | "iris_budget_exceeded" | (string & {})

export type Retryable = {
  message: string
  // Publish the action once, then stop. A spending cap does not clear for hours, so retrying it
  // is instructing the caller to hammer a wall — which is what we were doing five times per
  // refusal, because the client reads the SDK's own isRetryable flag and never looked at the
  // `retryable: false` the server had gone to the trouble of sending.
  terminal?: boolean
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
    // WHEN THE LIMIT ACTUALLY CLEARS, as the server computed it. ISO-8601.
    //
    // The dialog used to suppress itself for a hard-coded four hours, on the reasoning that a
    // DAILY limit can be hit again tomorrow. That reasoning does not survive the allowance
    // becoming weekly: someone who exhausts a week on Monday would be shown the same dialog
    // every four hours until Sunday, explaining a thing that cannot change.
    //
    // The client must not compute this either — "a week" is policy, and policy lives in
    // config/allowance.php on the server. Suppress until this instant and the client stays
    // correct across every future change to the window.
    resetsAt?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    // OUR OWN CAP, CHECKED FIRST AND BEFORE THE RETRYABLE GATE.
    //
    // Before the gate, because the gate's job is "is this worth trying again" and the answer
    // here is a flat no — but we still need the action published so the upgrade dialog can
    // fire. Those are different questions and the old code could only answer one.
    if (error.data.responseBody?.includes(IRIS_LIMIT_SOURCE)) {
      const body = parseJSON(error.data.responseBody)
      const detail = isRecord(body) && isRecord(body.error) ? body.error : undefined
      const reason = str(detail?.message) || "You have reached your IRIS spending limit."
      const resets = str(detail?.resets_at)
      const cap = str(detail?.cap_usd)
      const period = str(detail?.period) || "period"

      // Built from what the server sent, never from a string typed here — the same rule the
      // web CTAs need. If the server stops sending a field the line disappears rather than
      // going stale.
      const parts = [reason]
      if (cap) parts.push(`Your ${period} limit is $${cap}.`)
      if (resets) parts.push(`It resets ${resets}.`)

      return {
        message: reason,
        terminal: true,
        action: {
          reason: "iris_budget_exceeded",
          provider,
          title: "You've hit your IRIS limit",
          message: parts.join(" "),
          label: "See plans",
          link: str(detail?.upgrade_url) || IRIS_UPGRADE_URL,
          resetsAt: resets,
        },
      }
    }

    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      // A terminal retryable publishes its action on the first pass — which is what raises the
      // dialog — and then stops. Without the first pass there is no status event and no dialog
      // at all; without the stop we would retry a wall that cannot clear for hours.
      if (retry.terminal && meta.attempt >= 1) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
