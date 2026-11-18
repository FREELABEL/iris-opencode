// Renderer errors and document loads, written to engine.log (#191508).
//
// The window's console dies with every reload; engine.log, written by the shell, survives it. A
// report of "the window went black and reloaded" (1.18.153, on approving a permission) could not
// be explained from what was on disk: nothing recorded whether the document actually reloaded,
// or what the page threw just before. Each document load now writes one line saying how it was
// loaded (a first navigation, or a reload), and uncaught errors and unhandled rejections are
// forwarded, capped so a render loop cannot fill the log.

export type RendererLine = { kind: "load" | "error" | "rejection"; message: string }

const MAX_MESSAGE = 1500
const MAX_LINES_PER_MINUTE = 30

/** One line, no newlines, bounded. */
export function clip(text: string, max = MAX_MESSAGE): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}${reason.stack ? ` | ${reason.stack}` : ""}`
  if (typeof reason === "string") return reason
  try {
    return JSON.stringify(reason) ?? String(reason)
  } catch {
    return String(reason)
  }
}

export function describeError(event: Pick<ErrorEvent, "message" | "filename" | "lineno" | "colno" | "error">) {
  const where = event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : ""
  const detail = event.error ? ` | ${describeReason(event.error)}` : ""
  return clip(`${event.message || "error"}${where}${detail}`)
}

export function describeRejection(reason: unknown) {
  return clip(describeReason(reason))
}

/** How this document was loaded: "navigate" on a launch, "reload" when the page was reloaded. */
export function describeLoad(input: { navigationType?: string; url: string; startedAt: number }) {
  return clip(`document loaded (${input.navigationType ?? "unknown"}) ${input.url} t+${Math.round(input.startedAt)}ms`)
}

/** Allows at most `max` lines per rolling minute, so a render loop cannot flood engine.log. */
export function createLimiter(max = MAX_LINES_PER_MINUTE, now: () => number = Date.now) {
  const sent: number[] = []
  let dropped = 0
  return (): { ok: boolean; dropped: number } => {
    const t = now()
    while (sent.length && t - sent[0]! > 60_000) sent.shift()
    if (sent.length >= max) {
      dropped++
      return { ok: false, dropped }
    }
    sent.push(t)
    const d = dropped
    dropped = 0
    return { ok: true, dropped: d }
  }
}

export function installRendererLog(send: (line: RendererLine) => Promise<unknown>) {
  const allow = createLimiter()
  const write = (line: RendererLine) => {
    const gate = allow()
    if (!gate.ok) return
    const message = gate.dropped ? `${line.message} (${gate.dropped} earlier lines dropped)` : line.message
    void send({ kind: line.kind, message }).catch(() => undefined)
  }

  const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined
  write({
    kind: "load",
    message: describeLoad({ navigationType: nav?.type, url: location.href, startedAt: performance.now() }),
  })
  window.addEventListener("error", (event) => write({ kind: "error", message: describeError(event) }))
  window.addEventListener("unhandledrejection", (event) =>
    write({ kind: "rejection", message: describeRejection(event.reason) }),
  )
}
