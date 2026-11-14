import type { AgentChatEvent } from "./iris-api"

/**
 * Verbose tracing for `iris chat` / `iris agents chat`.
 *
 * The V6 ReactLoop stream has ALWAYS carried the full trace — iteration headers,
 * every memory injection with its sources, the model and tool count for each
 * decision, each tool call WITH ITS ARGUMENTS, and each tool result with status.
 * The CLI parsed those frames and used them for one thing: setting the spinner
 * label. Everything else was dropped on the floor.
 *
 * So this is a renderer, not a new capability. Nothing here asks the server for
 * anything it was not already sending.
 *
 * Two levels, because they answer different questions:
 *
 *   light (-V)   "what did it do?"  — the shape of the run. One line per step:
 *                iterations, tool names, argument SUMMARIES, result status and
 *                size. Reads like a stack trace; fits on a screen.
 *
 *   heavy (-VV)  "why did it do that?" — the same timeline with the payloads
 *                left in: full tool arguments, full tool results, the reasoning
 *                text, and the data behind each memory injection. This is what
 *                you need to tell "the tool returned nothing" apart from "the
 *                model ignored what the tool returned", which are the two
 *                failures that look identical from the outside.
 */
export type TraceLevel = 0 | 1 | 2

/** One rendered step, kept structurally so --json can carry the same trace. */
export interface TraceStep {
  seq: number
  at_ms: number
  type: string
  iteration?: number
  tool?: string
  label: string
  detail?: string
  data?: unknown
}

const MAX_LIGHT = 160
const MAX_HEAVY = 4000

/** Compact a value to one line — enough to recognise it, never enough to wrap. */
function summarize(value: unknown, limit = MAX_LIGHT): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return clip(value.replace(/\s+/g, " ").trim(), limit)
  if (typeof value !== "object") return String(value)

  if (Array.isArray(value)) return clip(`[${value.length} item${value.length === 1 ? "" : "s"}]`, limit)

  const obj = value as Record<string, unknown>
  const parts = Object.entries(obj).map(([k, v]) => {
    if (v === null || v === undefined) return `${k}=null`
    if (typeof v === "string") return `${k}=${clip(v.replace(/\s+/g, " ").trim(), 48)}`
    if (Array.isArray(v)) return `${k}=[${v.length}]`
    if (typeof v === "object") return `${k}={…}`
    return `${k}=${String(v)}`
  })
  return clip(parts.join(" "), limit)
}

function clip(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit - 1) + "…" : s
}

function pretty(value: unknown, limit = MAX_HEAVY): string {
  if (typeof value === "string") return clip(value, limit)
  try {
    return clip(JSON.stringify(value, null, 2), limit)
  } catch {
    return clip(String(value), limit)
  }
}

/**
 * How big was the thing a tool handed back? A tool that "succeeded" with an empty
 * result is the single most common cause of a confidently wrong answer, and it is
 * invisible unless the size is printed next to the status.
 */
const RESULT_ARRAY_KEYS = ["results", "items", "records", "rows", "data", "hits", "matches"]

/**
 * Tool results arrive wrapped, and the wrapper depth varies by tool:
 * `{results: []}`, `{data: {results: []}}`, `{status, data: {found, results: []}}`.
 * Counting the top-level keys of the envelope reports "2 keys" for a search that
 * found nothing AND for one that found fifty — which is the one distinction the
 * line exists to make. So descend through the envelope keys to the first array.
 */
function findRows(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value
  if (depth >= 3 || value === null || typeof value !== "object") return null
  const o = value as Record<string, unknown>
  for (const k of RESULT_ARRAY_KEYS) {
    if (k in o) {
      const found = findRows(o[k], depth + 1)
      if (found) return found
    }
  }
  return null
}

function resultSize(result: unknown): string {
  if (result === null || result === undefined) return "empty"
  if (typeof result === "string") return result.length === 0 ? "empty" : `${result.length} chars`
  if (typeof result === "object") {
    const rows = findRows(result)
    if (rows) return `${rows.length} items`
    return `${Object.keys(result as object).length} keys`
  }
  return String(result)
}

/**
 * Turn the event stream into rendered lines. Pure — it takes events in and gives
 * strings back, so it is testable without a network or a terminal, which is the
 * only reason the level rules can be asserted at all.
 */
export class ChatTracer {
  private seq = 0
  private readonly started: number
  readonly steps: TraceStep[] = []

  constructor(
    private readonly level: TraceLevel,
    private readonly emit: (line: string) => void,
    private readonly style: { dim: (s: string) => string; bold: (s: string) => string } = {
      dim: (s) => s,
      bold: (s) => s,
    },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.started = now()
  }

  get enabled(): boolean {
    return this.level > 0
  }

  handle(evt: AgentChatEvent): void {
    if (this.level === 0) return
    const step = this.describe(evt)
    if (!step) return
    this.steps.push(step)
    this.render(step)
  }

  private describe(evt: AgentChatEvent): TraceStep | null {
    const e = evt as Record<string, unknown>
    const iteration = typeof evt.iteration === "number" ? evt.iteration : Number(e.iteration) || undefined
    const base = {
      seq: this.seq++,
      at_ms: this.now() - this.started,
      type: evt.type,
      iteration,
    }

    switch (evt.type) {
      case "iteration":
        return { ...base, label: String(e.message ?? `Iteration ${iteration}`) }

      case "memory_injection":
        return {
          ...base,
          label: `context: ${String(e.memory_type ?? "unknown")}`,
          detail: summarize(e.description),
          data: e.data,
        }

      case "thinking":
        return {
          ...base,
          label: "thinking",
          // The model and the tool count are the two facts that explain a bad
          // routing decision, and neither appears anywhere else in the output.
          detail: [
            e.model ? `model=${e.model}` : "",
            e.tools_available !== undefined ? `tools_available=${e.tools_available}` : "",
          ]
            .filter(Boolean)
            .join(" "),
          data: e.content,
        }

      case "reasoning":
        return { ...base, label: "reasoning", detail: summarize(e.content), data: e.content }

      case "tool_call":
        return {
          ...base,
          tool: evt.tool,
          label: `→ ${evt.tool ?? "tool"}`,
          detail: summarize(e.arguments),
          data: e.arguments,
        }

      case "tool_result":
        return {
          ...base,
          tool: evt.tool,
          label: `← ${evt.tool ?? "tool"}`,
          detail: `${String(e.status ?? "?")} · ${resultSize(e.result)}`,
          data: e.result,
        }

      case "error":
        return { ...base, label: "error", detail: summarize(e.error) }

      // `done` and `text` both carry the answer, which the normal output already
      // prints in full directly below. Echoing it inside the trace pushes the real
      // steps off the screen with a copy of the thing you are about to read, so
      // light drops it; heavy keeps `text` because a payload-level trace is where
      // you go to compare what was streamed against what was finally rendered.
      case "done":
        return null

      case "text":
        if (this.level < 2) return null
        return { ...base, label: "text", detail: summarize(e.content), data: e.content }

      default:
        return { ...base, label: evt.type, detail: summarize(e.content ?? e.message) }
    }
  }

  private render(step: TraceStep): void {
    const { dim, bold } = this.style
    const t = `${(step.at_ms / 1000).toFixed(1)}s`.padStart(6)
    const iter = step.iteration !== undefined ? `i${step.iteration}` : "  "
    const head = `  ${dim(t)} ${dim(iter)}  ${step.type === "tool_call" || step.type === "tool_result" ? bold(step.label) : step.label}`
    this.emit(step.detail ? `${head} ${dim(step.detail)}` : head)

    if (this.level < 2 || step.data === undefined || step.data === null || step.data === "") return

    // Heavy: the payload, indented under the step it belongs to. Skipped when the
    // summary already IS the payload (short strings — `reasoning`, `text`), because
    // printing the same sentence twice on consecutive lines reads as a bug.
    const body = pretty(step.data)
    if (!body || body === '""' || body === step.detail) return
    for (const line of body.split("\n")) this.emit(dim(`         │ ${line}`))
  }
}

/** yargs gives `-VVV` as a count; anything above 2 is still heavy. */
export function toTraceLevel(count: unknown): TraceLevel {
  const n = typeof count === "number" ? count : 0
  if (n >= 2) return 2
  if (n === 1) return 1
  return 0
}
