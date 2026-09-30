import { UsageBeacon } from "./usage-beacon"

/**
 * The desktop app's usage tracker (#186171, phase 2).
 *
 * `app_open` said someone started the app and nothing about what they did in it. This listens to
 * the engine's own event stream — the one the desktop UI renders from — and turns the core loop
 * into a handful of usage events, so no screen has to be instrumented by hand:
 *
 *   session_start    a new top-level conversation (sub-agent sessions are not counted)
 *   message_sent     the person sent a message            model, provider, agent
 *   response_done    the model finished answering         model, outcome, duration, token counts
 *   tool_run         a tool call finished                 tool name, outcome, duration
 *   permission_reply the person answered a permission     once | always | reject
 *   session_error    a conversation failed                the error's class name
 *
 * NAMES AND COUNTS ONLY, same rule as usage-beacon.ts: never message text, tool input or output,
 * file paths, titles or the working directory. `toUsageEvent` is the single place a bus payload
 * becomes an outgoing event, and it copies fields by name — nothing is forwarded wholesale.
 *
 * Batched: flushed every 30 s, at 25 events, and on exit. Bounded: at most 500 queued (oldest
 * dropped), and the dedupe memory is cleared past 5,000 ids. Never throws.
 */
export namespace UsageTracker {
  export type Event = {
    source: "desktop"
    event_type: string
    severity: "info" | "error"
    model?: string
    provider?: string
    tool_name?: string
    outcome?: "ok" | "error" | "aborted"
    duration_ms?: number
    context?: Record<string, string | number | boolean>
  }

  /** Remembers which ids have already produced an event — the bus repeats updates for one id. */
  export class Seen {
    private ids = new Set<string>()
    first(id: string): boolean {
      if (this.ids.has(id)) return false
      if (this.ids.size >= 5000) this.ids.clear()
      this.ids.add(id)
      return true
    }
  }

  /** A short identifier (`build`, `gpt-5-nano`, `bash`, `iris_leads`), or undefined. */
  function word(v: unknown, max = 64): string | undefined {
    if (typeof v !== "string") return undefined
    const s = v.trim()
    return /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(s) ? s.slice(0, max) : undefined
  }

  function count(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
  }

  function compact<T extends Record<string, unknown>>(o: T): T {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
    return o
  }

  /** One engine bus payload → at most one usage event. Pure apart from `seen`. */
  export function toUsageEvent(payload: any, seen: Seen): Event | undefined {
    const type = payload?.type
    const p = payload?.properties
    if (typeof type !== "string" || !p || typeof p !== "object") return undefined

    if (type === "session.created") {
      const info = p.info
      if (!info?.id || info.parentID || !seen.first(`s:${info.id}`)) return undefined
      return { source: "desktop", event_type: "session_start", severity: "info" }
    }

    if (type === "message.updated") {
      const m = p.info
      if (!m?.id) return undefined
      if (m.role === "user") {
        if (!seen.first(`u:${m.id}`)) return undefined
        return compact({
          source: "desktop",
          event_type: "message_sent",
          severity: "info",
          model: word(m.model?.modelID),
          provider: word(m.model?.providerID, 32),
          context: compact({ agent: word(m.agent, 32) }),
        } as Event)
      }
      if (m.role === "assistant") {
        // Only a finished answer counts; the bus sends this message many times while it streams.
        if (!m.time?.completed && !m.error) return undefined
        if (!seen.first(`a:${m.id}`)) return undefined
        const aborted = m.error?.name === "MessageAbortedError"
        return compact({
          source: "desktop",
          event_type: "response_done",
          severity: "info",
          model: word(m.modelID),
          provider: word(m.providerID, 32),
          outcome: aborted ? "aborted" : m.error ? "error" : "ok",
          duration_ms: m.time?.completed && m.time?.created ? count(m.time.completed - m.time.created) : undefined,
          context: compact({
            agent: word(m.agent, 32),
            finish: word(m.finish, 32),
            error_kind: m.error && !aborted ? word(m.error.name) : undefined,
            tokens_in: count(m.tokens?.input),
            tokens_out: count(m.tokens?.output),
            tokens_reasoning: count(m.tokens?.reasoning),
            tokens_cache_read: count(m.tokens?.cache?.read),
          }),
        } as Event)
      }
      return undefined
    }

    if (type === "message.part.updated") {
      const part = p.part
      if (part?.type !== "tool") return undefined
      const status = part.state?.status
      if (status !== "completed" && status !== "error") return undefined
      if (!seen.first(`t:${part.callID ?? part.id}`)) return undefined
      const t = part.state.time
      return compact({
        source: "desktop",
        event_type: "tool_run",
        severity: "info",
        tool_name: word(part.tool),
        outcome: status === "completed" ? "ok" : "error",
        duration_ms: t?.end && t?.start ? count(t.end - t.start) : undefined,
      } as Event)
    }

    if (type === "permission.replied") {
      const reply = word(p.reply ?? p.response, 16)
      if (!reply) return undefined
      return { source: "desktop", event_type: "permission_reply", severity: "info", context: { reply } }
    }

    if (type === "session.error") {
      const name = word(p.error?.name)
      // The person pressing stop is not a failure.
      if (name === "MessageAbortedError") return undefined
      return compact({
        source: "desktop",
        event_type: "session_error",
        severity: "error",
        context: compact({ error_kind: name }),
      } as Event)
    }

    return undefined
  }

  export type Options = {
    token: () => string | null
    apiBase: string
    version: string
    env?: NodeJS.ProcessEnv
    home?: string
    fetchImpl?: typeof fetch
    flushMs?: number
    batchSize?: number
  }

  export function create(opts: Options) {
    const seen = new Seen()
    const queue: Event[] = []
    const batchSize = opts.batchSize ?? 25
    let timer: ReturnType<typeof setInterval> | undefined
    let inflight: Promise<unknown> = Promise.resolve()

    async function flush(): Promise<void> {
      if (queue.length === 0) return
      const batch = queue.splice(0, 50)
      inflight = inflight.then(() =>
        UsageBeacon.post(batch, {
          token: opts.token(),
          apiBase: opts.apiBase,
          version: opts.version,
          env: opts.env,
          home: opts.home,
          fetchImpl: opts.fetchImpl,
        }),
      )
      await inflight
      if (queue.length > 0) return flush()
    }

    function push(event: Event | undefined) {
      if (!event) return
      if (!UsageBeacon.enabled(opts.env, opts.home)) return
      queue.push(event)
      if (queue.length > 500) queue.splice(0, queue.length - 500)
      if (queue.length >= batchSize) void flush().catch(() => {})
    }

    return {
      /** Feed one engine bus payload. */
      observe(payload: unknown) {
        try {
          push(toUsageEvent(payload, seen))
        } catch {}
      },
      track: push,
      flush,
      start() {
        if (timer) return
        timer = setInterval(() => void flush().catch(() => {}), opts.flushMs ?? 30_000)
        timer.unref?.()
      },
      stop() {
        if (timer) clearInterval(timer)
        timer = undefined
        return flush().catch(() => {})
      },
      get pending() {
        return queue.length
      },
    }
  }
}
