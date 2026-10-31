import { Schema } from "effect"
import { ulid } from "ulid"

// Terminal mode (#190530): commands the user runs from the composer's shell mode, kept OUT of
// the session until they close the terminal. Session.shell writes a user turn and a tool part
// for every command; this registry only holds each run's output and final state, so the app can
// show a live transcript and append it to the session once, as one entry.
//
// Process-wide and in memory on purpose: a run is a few seconds of output the user is watching,
// not a record. Output is capped per run (oldest bytes dropped, and the read says so), and a
// finished run is forgotten after TTL_MS so an abandoned terminal cannot pile up buffers.
export namespace TerminalRun {
  export const OUTPUT_LIMIT = 1024 * 1024
  export const TTL_MS = 30 * 60 * 1000
  export const RUNNING_LIMIT = 8

  export const Status = Schema.Literals(["running", "exited", "cancelled", "error"])
  export type Status = typeof Status.Type

  export const Read = Schema.Struct({
    id: Schema.String,
    command: Schema.String,
    status: Status,
    // Output from the requested offset to the end, and the offset to ask for next time.
    output: Schema.String,
    next: Schema.Number,
    // True when bytes before the requested offset were dropped by the per-run cap.
    truncated: Schema.Boolean,
    exitCode: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String),
    started: Schema.Number,
    ended: Schema.NullOr(Schema.Number),
  })
  export type Read = typeof Read.Type

  export interface Run {
    id: string
    sessionID: string
    command: string
    status: Status
    output: string
    // Bytes dropped from the front of `output`; absolute offset of output[0].
    dropped: number
    exitCode: number | null
    error: string | null
    started: number
    ended: number | null
    cancel?: () => void
  }

  const runs = new Map<string, Run>()

  export function sweep(now = Date.now()) {
    for (const [id, run] of runs) {
      if (run.ended !== null && now - run.ended > TTL_MS) runs.delete(id)
    }
  }

  export function running(sessionID: string) {
    return [...runs.values()].filter((r) => r.sessionID === sessionID && r.status === "running").length
  }

  export function create(sessionID: string, command: string, now = Date.now()): Run {
    sweep(now)
    const run: Run = {
      id: ulid(),
      sessionID,
      command,
      status: "running",
      output: "",
      dropped: 0,
      exitCode: null,
      error: null,
      started: now,
      ended: null,
    }
    runs.set(run.id, run)
    return run
  }

  export function get(sessionID: string, id: string): Run | undefined {
    const run = runs.get(id)
    return run && run.sessionID === sessionID ? run : undefined
  }

  export function append(run: Run, chunk: string) {
    run.output += chunk
    const excess = run.output.length - OUTPUT_LIMIT
    if (excess <= 0) return
    run.output = run.output.slice(excess)
    run.dropped += excess
  }

  // First final state wins: a cancel that lands after the process already exited stays "exited".
  export function finish(
    run: Run,
    end: { status: Exclude<Status, "running">; exitCode?: number | null; error?: string | null },
    now = Date.now(),
  ) {
    if (run.status !== "running") return
    run.status = end.status
    run.exitCode = end.exitCode ?? null
    run.error = end.error ?? null
    run.ended = now
    run.cancel = undefined
  }

  export function read(run: Run, from = 0): Read {
    const start = Math.max(from, run.dropped)
    const total = run.dropped + run.output.length
    return {
      id: run.id,
      command: run.command,
      status: run.status,
      output: start >= total ? "" : run.output.slice(start - run.dropped),
      next: total,
      truncated: from < run.dropped,
      exitCode: run.exitCode,
      error: run.error,
      started: run.started,
      ended: run.ended,
    }
  }

  export function reset() {
    runs.clear()
  }
}
