/**
 * Hive › Simulations (#194084) — the pure half. The engine runs the hive-simulations playbook's
 * steps (packages/opencode/src/iris/hive-sim.ts); this turns its reads into what the view draws.
 * No Solid here, so every rule below is tested on the server build too.
 */

export type StepId = "engine" | "pull" | "tie-out" | "simulate" | "flip"
export type StepStatus = "waiting" | "running" | "passed" | "failed"
export type RunStatus = "running" | "passed" | "failed" | "cancelled"

export type Progress = { done: number; total: number }
export type Table = { title: string; columns: string[]; rows: string[][] }
export type Flip = { text: string; input?: string; range?: string }

export type StepRead = {
  id: StepId
  title: string
  status: StepStatus
  started: number | null
  ended: number | null
  exitCode: number | null
  reason: string | null
  output: string
  next: number
  truncated: boolean
}

export type RunRead = {
  id: string
  engine: string
  knobs: { worlds: number; cohort: number; days: number; refresh: boolean }
  status: RunStatus
  started: number
  ended: number | null
  reason: string | null
  steps: StepRead[]
  feed: { progress?: Progress; inputs?: { measured: string[]; drawn: string[] }; tables: Table[]; flips: Flip[]; ignored: number }
  header: string[]
}

export type RunSummary = {
  id: string
  engine: string
  status: RunStatus
  started: number
  ended: number | null
  reason: string | null
  steps: { id: StepId; status: StepStatus }[]
  progress?: Progress
}

/** The client keeps at most this much of one step's output; the engine caps the same. */
export const OUTPUT_LIMIT = 1024 * 1024

/** A run as the view holds it: the latest read, with each step's output accumulated. */
export type RunView = RunRead & { outputs: Record<string, string> }

/**
 * Fold a read into what the view holds. Each step's output arrives from the offset the view asked
 * for, so it is APPENDED; a read whose step says `truncated` lost bytes before that offset to the
 * engine's cap, and the view says so rather than pretending the output is whole.
 */
export function mergeRead(prev: RunView | undefined, read: RunRead): RunView {
  const outputs: Record<string, string> = {}
  for (const s of read.steps) {
    const before = prev && prev.id === read.id ? (prev.outputs[s.id] ?? "") : ""
    const next = before + s.output
    outputs[s.id] = next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next
  }
  return { ...read, outputs }
}

/** The `from` query for the next read: each step's `next`, in step order. */
export function offsets(view: RunView | undefined): string {
  if (!view) return ""
  return view.steps.map((s) => s.next).join(",")
}

export function percent(p: Progress | undefined): number | undefined {
  if (!p || !(p.total > 0)) return undefined
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)))
}

/**
 * MEASURED vs DRAWN, pinned at the top of a run. From the feed when the engine wrote it; else the
 * header lines the engine printed; else a plain statement that the engine did not say — never an
 * empty space a reader could mistake for "nothing was guessed".
 */
export type Basis =
  | { kind: "feed"; measured: string[]; drawn: string[] }
  | { kind: "header"; lines: string[] }
  | { kind: "missing"; waiting: boolean }

export function basis(run: Pick<RunRead, "feed" | "header" | "status" | "steps">): Basis {
  const io = run.feed.inputs
  if (io) return { kind: "feed", measured: io.measured, drawn: io.drawn }
  if (run.header.length) return { kind: "header", lines: run.header }
  const sim = run.steps.find((s) => s.id === "simulate")
  return { kind: "missing", waiting: run.status === "running" && sim?.status !== "passed" && sim?.status !== "failed" }
}

/**
 * Which run to show: the one the person picked, while it exists; otherwise the newest running
 * one; otherwise the newest. A NEW run (an agent just started it) takes over unless the person
 * has picked one since it started.
 */
export function pickRun(runs: RunSummary[], picked: { id: string; at: number } | undefined): string | undefined {
  if (!runs.length) return undefined
  const newest = [...runs].sort((a, b) => b.started - a.started)
  const chosen = picked && runs.find((r) => r.id === picked.id)
  if (chosen && !newest.some((r) => r.started > picked!.at && r.id !== chosen.id)) return chosen.id
  return (newest.find((r) => r.status === "running") ?? newest[0]).id
}

export function engineName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function duration(ms: number): string {
  if (!(ms >= 0)) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

export const STATUS_WORD: Record<RunStatus, string> = {
  running: "Running",
  passed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
}

/** The raw output, every step that has run, each under its own rule. */
export function transcript(view: RunView): string {
  return view.steps
    .filter((s) => s.id !== "flip" && (s.status !== "waiting" || view.outputs[s.id]))
    .map((s) => `── ${s.id} ──\n${view.outputs[s.id] ?? ""}`.trimEnd())
    .join("\n\n")
}

/** Auto-follow only while the reader is at the bottom; scrolling up to read stops it. */
export function atBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}
