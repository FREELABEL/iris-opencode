import { Auth } from "../auth"

/**
 * Client error beacon → fl-iris-api POST /api/v6/telemetry/errors.
 *
 * The client half of per-client telemetry (server side: ClientTelemetryService +
 * TelemetryController). Reports CLI errors so we can see "is it working for THIS
 * client", not just aggregate logs. The server attributes the event to the user
 * via the iris token.
 *
 * Rules: best-effort, fire-and-forget, NEVER throws, NEVER blocks meaningfully
 * (3s timeout). Telemetry must never break the CLI.
 */
export namespace Beacon {
  export type EventType = "cli_uncaught" | "cli_command_error" | "cli_request_error"

  /**
   * Span kinds (#178533). Unlike the error types above these describe the HAPPY
   * PATH as well as failures — they are what gives the error rate a denominator.
   */
  export type SpanType = "run_start" | "run_end" | "tool_call" | "llm_call" | "mcp_call"

  export type Outcome = "ok" | "error" | "aborted" | "timeout"

  export interface Event {
    message?: string
    command?: string
    status_code?: number
    provider?: string
    model?: string
    context?: Record<string, unknown>
  }

  export interface Span extends Event {
    trace_id: string
    span_id?: string
    parent_span_id?: string
    tool_name?: string
    outcome?: Outcome
    duration_ms?: number
  }

  function baseUrl(): string {
    // Mirror the proxy's base resolution (provider.ts) so beacon + chat agree.
    return process.env.IRIS_API_URL ?? process.env.IRIS_LOCAL_URL ?? "https://freelabel.net"
  }

  function clip(s: string | undefined, n: number): string | undefined {
    if (s === undefined) return undefined
    return s.length > n ? s.slice(0, n) : s
  }

  /**
   * Opt-out. Spans are metadata-only (see the PHI note on emit) but a client
   * must always be able to turn telemetry off entirely.
   */
  function disabled(): boolean {
    const v = process.env.IRIS_TELEMETRY
    return v === "0" || v === "off" || v === "false"
  }

  // ── id generation ────────────────────────────────────────────────────────
  // Not crypto — these only need to be collision-free enough to join rows.
  function hex(bytes: number): string {
    let out = ""
    for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
    return out
  }

  /** 32-char trace id — one per run/session. */
  export function newTraceId(): string {
    return hex(16)
  }

  /** 16-char span id — one per step. */
  export function newSpanId(): string {
    return hex(8)
  }

  // ── span buffer ──────────────────────────────────────────────────────────
  // Spans are frequent (one per tool call), so they are batched rather than
  // POSTed individually. The server accepts up to 50 per request.
  const MAX_BATCH = 50
  let buffer: Array<Record<string, unknown>> = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Queue one span. Fire-and-forget: returns immediately, never throws, and
   * never blocks the thing it is observing.
   *
   * PHI RULE — pass SHAPES, NOT VALUES. A tool's name, how long it took, whether
   * it finished. Never an argument value, never prompt or response text. The
   * server whitelists fields and strips payload keys, but that is a second line
   * of defense, not the first: do not send it in the first place.
   */
  export function span(spanType: SpanType, span: Span): void {
    if (disabled()) return
    try {
      buffer.push({
        source: process.env.IRIS_MCP === "1" ? "mcp" : "cli",
        event_type: spanType,
        severity: "info",
        trace_id: clip(span.trace_id, 32),
        span_id: clip(span.span_id, 16),
        parent_span_id: clip(span.parent_span_id, 16),
        tool_name: clip(span.tool_name, 64),
        outcome: span.outcome,
        duration_ms: span.duration_ms,
        command: clip(span.command, 128),
        provider: span.provider,
        model: span.model,
        status_code: span.status_code,
        message: clip(span.message, 2000),
        context: span.context,
      })

      if (buffer.length >= MAX_BATCH) {
        void flush()
        return
      }
      // Coalesce a burst of spans into one request. unref() so a pending flush
      // never keeps the process alive on its own.
      if (!flushTimer) {
        flushTimer = setTimeout(() => void flush(), 2000)
        ;(flushTimer as { unref?: () => void }).unref?.()
      }
    } catch {
      // never throw
    }
  }

  /**
   * Send everything buffered. Await this on an exit path so a run's spans are
   * not lost when the process ends — an unflushed run_end is indistinguishable
   * from a run that died, which is exactly the signal we are trying to collect.
   */
  export async function flush(): Promise<boolean> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (buffer.length === 0) return true

    const events = buffer.splice(0, buffer.length)
    try {
      const auth = await Auth.get("iris")
      const key = (auth as { key?: string } | undefined)?.key
      if (!key) return false // nothing to attribute the spans to

      const res = await fetch(`${baseUrl()}/api/v6/telemetry/errors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)

      return !!res?.ok
    } catch {
      return false
    }
  }

  /**
   * Send a telemetry event. Returns true if the POST was accepted, false otherwise.
   * Awaitable so callers on an exit path can flush before process.exit().
   */
  export async function report(eventType: EventType, event: Event = {}): Promise<boolean> {
    if (disabled()) return false
    try {
      const auth = await Auth.get("iris")
      const key = (auth as { key?: string } | undefined)?.key
      if (!key) return false // no iris token → nothing to attribute, skip silently

      const res = await fetch(`${baseUrl()}/api/v6/telemetry/errors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          source: "cli",
          event_type: eventType,
          message: clip(event.message, 2000),
          command: clip(event.command, 128),
          status_code: event.status_code,
          provider: event.provider,
          model: event.model,
          context: event.context,
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)

      return !!res?.ok
    } catch {
      return false // never throw — telemetry must not break the CLI
    }
  }
}
