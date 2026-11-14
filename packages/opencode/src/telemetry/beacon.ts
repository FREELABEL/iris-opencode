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
  export type EventType = "cli_uncaught" | "cli_command_error" | "cli_request_error" | "first_command"

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

  /**
   * The token the spans are attributed to — and the reason the beta looked idle.
   *
   * This used to be `Auth.get("iris")` alone, which reads ONLY auth.json on disk.
   * That is correct for a laptop and wrong for every other way the binary runs.
   * Under the MCP connector, iris-exec spawns the binary in a fresh container with
   * `IRIS_API_KEY` in the ENVIRONMENT and no auth.json anywhere — so `get()` returned
   * undefined, `flush()` hit `if (!key) return false`, and every span from the entire
   * MCP surface was dropped on the floor without a log line. The beta ships through
   * MCP. That is why 30 days of fleet telemetry was 230 rows from two people: not
   * "nobody hit errors", but "the only clients that could report were the two of us
   * running it from a shell".
   *
   * Same cascade as platform-bug.ts:resolveReporterToken() — which already had this
   * right. Env first: a caller that went to the trouble of setting IRIS_API_KEY for
   * this process means that identity, not whatever is cached on the box.
   */
  async function resolveToken(): Promise<string> {
    if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
    if (process.env.FL_API_TOKEN) return process.env.FL_API_TOKEN

    try {
      // Any stored shape that carries a key, not just type:"api" — oauth and
      // wellknown entries have one too, and the previous implementation read it
      // without discriminating. Narrowing here would have quietly un-attributed
      // whichever users are on those flows.
      const stored = (await Auth.get("iris")) as { key?: string } | undefined
      if (stored?.key) return stored.key
    } catch {}

    try {
      const { homedir } = await import("os")
      const { join } = await import("path")
      const { existsSync, readFileSync } = await import("fs")
      const envPath = join(homedir(), ".iris", "sdk", ".env")
      if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, "utf8").split("\n")) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith("#")) continue
          const eq = trimmed.indexOf("=")
          if (eq < 0) continue
          if (trimmed.slice(0, eq).trim() === "IRIS_API_KEY") return trimmed.slice(eq + 1).trim()
        }
      }
    } catch {}

    return ""
  }

  /**
   * Which surface this process is. Read in one place so `source` cannot drift
   * between spans and errors — they have to be comparable to be worth grouping.
   */
  function source(): "mcp" | "cli" {
    return process.env.IRIS_MCP === "1" ? "mcp" : "cli"
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
  /**
   * ACTIVATION: the first command this person ever ran after authenticating.
   *
   * install_success says the software landed. It does not say a person arrived —
   * someone can install, fail to log in, and never come back, and the install
   * looks identical to a success. This is the event that separates "installed"
   * from "actually used", and it is the last step of the signup funnel the
   * server cannot see: by the time a command runs, auth is long finished.
   *
   * Fires ONCE per machine, guarded by a marker file next to machine-id. Sending
   * it on every command would make it a usage counter, which the spans already
   * are — the value here is precisely that it happens once.
   *
   * Best-effort and silent, like everything else in this file: a telemetry
   * failure must never be visible to someone using the CLI.
   */
  export async function firstCommand(command?: string): Promise<void> {
    try {
      if (disabled()) return

      const { homedir } = await import("os")
      const { join } = await import("path")
      const { existsSync, writeFileSync, mkdirSync } = await import("fs")

      const marker = join(homedir(), ".iris", "first-command")
      if (existsSync(marker)) return

      // Only meaningful once authenticated — an unauthenticated run is not
      // activation, it is someone still trying to get in.
      const token = await resolveToken()
      if (!token) return

      // Write the marker BEFORE reporting. If the POST fails we still do not want
      // to re-fire on every subsequent command; one lost activation event is a far
      // smaller problem than a counter masquerading as a milestone.
      mkdirSync(join(homedir(), ".iris"), { recursive: true })
      writeFileSync(marker, new Date().toISOString() + "\n", { mode: 0o600 })

      await report("first_command", { command })
    } catch {
      // deliberately silent
    }
  }

  export function newTraceId(): string {
    return hex(16)
  }

  /**
   * The trace id for THIS process — created once, then stable.
   *
   * One `iris <cmd>` invocation is one run, so the run_start span and anything that wants
   * to say "I belong to that run" have to agree on the id. They cannot agree if each
   * caller mints its own, and they cannot agree by ordering either: the model provider is
   * built lazily and may be constructed before or after index.ts opens the trace. Owning
   * it here removes the ordering question rather than documenting it.
   *
   * This is what lets the model proxy stamp spend with the run that caused it (#179797) —
   * a join that is impossible to reconstruct after the fact, so the id has to be correct
   * at the moment of the request, not merely available somewhere.
   */
  let processTraceId: string | undefined
  export function traceId(): string {
    if (!processTraceId) processTraceId = newTraceId()
    return processTraceId
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
        source: source(),
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
  /**
   * @param timeoutMs how long the POST may take. The default suits a background
   *   flush. Exit paths pass something short: every `iris <cmd>` now closes a
   *   trace, so this await sits between the user and their shell prompt, and a
   *   telemetry write must never be the slowest thing a command does. A span
   *   lost to a bad network costs a row; three seconds of dead terminal on every
   *   command costs the CLI.
   */
  export async function flush(timeoutMs = 3000): Promise<boolean> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (buffer.length === 0) return true

    const events = buffer.splice(0, buffer.length)
    try {
      const key = await resolveToken()
      if (!key) return false // nothing to attribute the spans to

      const res = await fetch(`${baseUrl()}/api/v6/telemetry/errors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(timeoutMs),
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
      const key = await resolveToken()
      if (!key) return false // no iris token → nothing to attribute, skip silently

      const res = await fetch(`${baseUrl()}/api/v6/telemetry/errors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          // Not hardcoded "cli" — an MCP-originated crash that reads as a CLI crash
          // sends you debugging the wrong surface.
          source: source(),
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
