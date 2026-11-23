import fs from "fs"
import os from "os"
import path from "path"
import { Cause, Effect, Fiber } from "effect"
import * as Stream from "effect/Stream"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ulid } from "ulid"
import { TerminalRun } from "@/session/terminal-run"

/**
 * HIVE SIMULATIONS, LIVE (#194084).
 *
 * The hive-simulations playbook (engine → pull → tie-out → simulate → flip) ran as shell steps the
 * agent fired one by one; the person saw nothing until the agent pasted a table into the chat.
 * This runs the playbook's four shell steps for one engine as ONE run the desktop can watch —
 * Hive › Simulations polls it — and the agent waits on through the side_panel `simulate` action.
 *
 * WHAT IS REUSED. Each step's output is a TerminalRun (#190530): the same 1 MB cap, offset reads
 * and finish-once rule the composer's terminal mode uses, and the same ChildProcess spawn
 * (process group, killed on interrupt). This file adds only the order of the steps, the run record
 * around them, and the optional structured feed.
 *
 * IN MEMORY, for the engine's lifetime: a run is something the person watches and the agent reads
 * back, not a record. The last MAX_RUNS are kept; restarting the engine forgets them.
 *
 * THE OPTIONAL FEED (backward compatible). The simulate step runs with HIVE_SIM_EVENTS=<file>. An
 * engine that knows the variable appends JSON lines to it — progress, inputs (MEASURED/DRAWN),
 * tables, flips. An engine that does not still runs: the view shows its steps and its output, and
 * MEASURED/DRAWN are read from its header text. A line that does not parse is counted and ignored.
 */
export namespace HiveSim {
  export const TIMEOUT_MS = 900_000
  export const MAX_RUNS = 50
  export const RUNNING_LIMIT = 4
  /** What the agent gets back of the simulate step's output. */
  export const RESULT_HEAD = 3_000
  export const RESULT_TAIL = 9_000
  const MAX_TABLES = 20
  const MAX_ROWS = 500
  const MAX_COLS = 40
  const MAX_FLIPS = 10
  const MAX_CELL = 200

  export type StepId = "engine" | "pull" | "tie-out" | "simulate" | "flip"
  export type StepStatus = "waiting" | "running" | "passed" | "failed"
  export type RunStatus = "running" | "passed" | "failed" | "cancelled"

  export type Progress = { done: number; total: number }
  export type Inputs = { measured: string[]; drawn: string[] }
  export type Table = { title: string; columns: string[]; rows: string[][] }
  export type Flip = { text: string; input?: string; range?: string }
  export type Event =
    | ({ type: "progress" } & Progress)
    | ({ type: "inputs" } & Inputs)
    | ({ type: "table" } & Table)
    | ({ type: "flip" } & Flip)

  export type Knobs = { worlds: number; cohort: number; days: number; refresh: boolean }
  export type Input = { sessionID: string; directory: string; engine: string } & Partial<Knobs>

  export type Step = {
    id: StepId
    title: string
    status: StepStatus
    started: number | null
    ended: number | null
    exitCode: number | null
    /** Why it failed, in the step's own words (its last lines), or what the flip step found. */
    reason: string | null
    /** The step's output buffer; flip has none (it is the agent's step). */
    output?: TerminalRun.Run
  }

  export type Feed = {
    progress?: Progress
    inputs?: Inputs
    tables: Table[]
    flips: Flip[]
    /** Lines the feed had that were not a known event — ignored, but counted. */
    ignored: number
  }

  export type Run = {
    id: string
    sessionID: string
    directory: string
    engine: string
    knobs: Knobs
    status: RunStatus
    started: number
    ended: number | null
    /** Why the run did not pass: the failed step's reason, "stopped", or a timeout. */
    reason: string | null
    steps: Step[]
    feed: Feed
    /** MEASURED / DRAWN lines read from the output, for engines that do not write the feed. */
    header: string[]
    cancel?: (reason: string) => void
  }

  // ── the playbook's shell steps ──────────────────────────────────────────────────────────────
  // Verbatim from PLAYBOOK.md (hive-simulations v2), with one change: the sha256 falls back to
  // sha256sum where shasum is missing (a bare Linux node). TMPDIR is per run, so two runs never
  // share the hive-sim.engine handoff file.

  export const TITLES: Record<StepId, string> = {
    engine: "Put the engine on disk",
    pull: "Pull the real data",
    "tie-out": "Tie out the data",
    simulate: "Run it",
    flip: "Name the guess that flips it",
  }

  export const SCRIPTS: Record<Exclude<StepId, "flip">, string> = {
    engine: `set -euo pipefail
command -v python3 >/dev/null || { echo "python3 is required — engines are Python 3, standard library only"; exit 1; }
ENGINE="\${engine:-research/monetization-engine.py}"
case "$ENGINE" in /*) ;; *) ENGINE="$PWD/$ENGINE" ;; esac
if [ ! -f "$ENGINE" ]; then
  echo "no engine at $ENGINE" >&2
  echo "  Run this from the repo, or copy your engine to the node — it is one Python file." >&2
  exit 1
fi
echo "engine: $ENGINE"
if command -v shasum >/dev/null; then SUM="$(shasum -a 256 "$ENGINE" | cut -d' ' -f1)"; else SUM="$(sha256sum "$ENGINE" | cut -d' ' -f1)"; fi
echo "sha256: $SUM"
echo "$ENGINE" > "\${TMPDIR:-/tmp}/hive-sim.engine"`,
    pull: `set -euo pipefail
ENGINE="$(cat "\${TMPDIR:-/tmp}/hive-sim.engine")"
if [ "\${refresh:-yes}" = "yes" ]; then
  python3 "$ENGINE" --refresh --days "\${days:-30}" --worlds 1 --cohort 1 >/dev/null
  echo "pulled \${days:-30}d"
else
  echo "using the dataset already on disk — read its pulled_at before quoting anything"
fi
echo "This file is the reason the job runs here. It does not leave this machine."`,
    "tie-out": `set -euo pipefail
ENGINE="$(cat "\${TMPDIR:-/tmp}/hive-sim.engine")"
if python3 "$ENGINE" --worlds 1 --cohort 1 >/dev/null 2>"\${TMPDIR:-/tmp}/tieout.err"; then
  echo "TIE-OUT PASSED"
else
  echo "TIE-OUT FAILED — nothing downstream of this would be true:"; cat "\${TMPDIR:-/tmp}/tieout.err"; exit 1
fi`,
    simulate: `set -euo pipefail
ENGINE="$(cat "\${TMPDIR:-/tmp}/hive-sim.engine")"
python3 "$ENGINE" --worlds "\${worlds:-4000}" --cohort "\${cohort:-1000}" --days "\${days:-30}"`,
  }

  export const SHELL_STEPS = ["engine", "pull", "tie-out", "simulate"] as const

  // ── knobs ──────────────────────────────────────────────────────────────────────────────────

  export const DEFAULTS: Knobs = { worlds: 4000, cohort: 1000, days: 30, refresh: true }
  const LIMITS = { worlds: 1_000_000, cohort: 1_000_000, days: 3_650 }

  /** The knobs, or why not. Integers only: they go into the engine's argv through the env. */
  export function knobs(input: Partial<Knobs>): Knobs | string {
    const out = { ...DEFAULTS }
    for (const k of ["worlds", "cohort", "days"] as const) {
      const v = input[k]
      if (v === undefined) continue
      if (!Number.isInteger(v) || v < 1 || v > LIMITS[k]) return `${k} must be a whole number from 1 to ${LIMITS[k]}`
      out[k] = v
    }
    if (input.refresh !== undefined) out.refresh = !!input.refresh
    return out
  }

  export function validEngine(engine: unknown): string | undefined {
    if (typeof engine !== "string" || !engine.trim()) return "engine needs a path to the engine's .py file"
    if (engine.length > 1024 || engine.includes("\0") || /[\r\n]/.test(engine)) return "engine is not a usable path"
    return undefined
  }

  // ── the run record (pure state transitions) ──────────────────────────────────────────────────

  const runs = new Map<string, Run>()

  export function create(input: Input & { knobs: Knobs }, now = Date.now()): Run {
    const run: Run = {
      id: `sim_${ulid()}`,
      sessionID: input.sessionID,
      directory: input.directory,
      engine: input.engine,
      knobs: input.knobs,
      status: "running",
      started: now,
      ended: null,
      reason: null,
      steps: (["engine", "pull", "tie-out", "simulate", "flip"] as const).map((id) => ({
        id,
        title: TITLES[id],
        status: "waiting",
        started: null,
        ended: null,
        exitCode: null,
        reason: null,
      })),
      feed: { tables: [], flips: [], ignored: 0 },
      header: [],
    }
    runs.set(run.id, run)
    // Bounded: drop the oldest FINISHED runs first; a running one is never forgotten.
    for (const [id, r] of runs) {
      if (runs.size <= MAX_RUNS) break
      if (r.status !== "running") runs.delete(id)
    }
    return run
  }

  export function get(sessionID: string, id: string): Run | undefined {
    const run = runs.get(id)
    return run && run.sessionID === sessionID ? run : undefined
  }

  /** This session's runs, newest first. */
  export function list(sessionID: string): Run[] {
    return [...runs.values()].filter((r) => r.sessionID === sessionID).sort((a, b) => b.started - a.started)
  }

  export function running(): number {
    return [...runs.values()].filter((r) => r.status === "running").length
  }

  export function step(run: Run, id: StepId): Step {
    return run.steps.find((s) => s.id === id)!
  }

  export function begin(run: Run, id: StepId, now = Date.now()) {
    if (run.status !== "running") return
    const s = step(run, id)
    s.status = "running"
    s.started = now
  }

  /** The last few non-empty lines of a step's output: why it failed, in its own words. */
  export function lastLines(text: string, n = 3, max = 400): string {
    const lines = text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
    const tail = lines.slice(-n).join("\n")
    return tail.length > max ? "…" + tail.slice(-max) : tail
  }

  /** A shell step ended. A failure ends the run: nothing downstream of a failed step is true. */
  export function end(run: Run, id: StepId, exitCode: number, now = Date.now()) {
    if (run.status !== "running") return
    const s = step(run, id)
    s.ended = now
    s.exitCode = exitCode
    if (exitCode === 0) {
      s.status = "passed"
      return
    }
    s.status = "failed"
    s.reason = lastLines(s.output?.output ?? "") || `exited with code ${exitCode}`
    fail(run, `${s.title}: ${s.reason}`, now)
  }

  function fail(run: Run, reason: string, now: number, status: RunStatus = "failed") {
    run.status = status
    run.reason = reason
    run.ended = now
    run.cancel = undefined
  }

  /** Stop: the running step fails with the reason; steps after it stay waiting. */
  export function stop(run: Run, reason = "stopped", now = Date.now()) {
    if (run.status !== "running") return
    for (const s of run.steps) {
      if (s.status !== "running") continue
      s.status = "failed"
      s.ended = now
      s.reason = reason
      if (s.output) TerminalRun.finish(s.output, { status: "cancelled" }, now)
    }
    fail(run, reason, now, reason === "stopped" ? "cancelled" : "failed")
  }

  /**
   * All four shell steps passed: the flip step is the agent's (it reads the flip and answers the
   * playbook's three questions). What the run CAN check is that there is a flip to read — the
   * contract requires one, and a ranking without it is the confident wrong answer.
   */
  export function conclude(run: Run, now = Date.now()) {
    if (run.status !== "running") return
    const s = step(run, "flip")
    s.started = now
    s.ended = now
    const text = step(run, "simulate").output?.output ?? ""
    if (run.feed.flips.length) {
      s.status = "passed"
      s.reason = `${run.feed.flips.length} flip${run.feed.flips.length === 1 ? "" : "s"} reported — the agent answers the three questions`
    } else if (/\bflip/i.test(text)) {
      s.status = "passed"
      s.reason = "flip section in the output — the agent answers the three questions"
    } else {
      s.status = "failed"
      s.reason = "no flip section in the output: the contract requires one, and a ranking without it is not an answer"
      return fail(run, `${s.title}: ${s.reason}`, now)
    }
    run.status = "passed"
    run.ended = now
    run.cancel = undefined
  }

  // ── the structured feed ──────────────────────────────────────────────────────────────────────

  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined)
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : (str(v) ?? JSON.stringify(v))
    return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + "…" : s
  }
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map(str).filter((x): x is string => x !== undefined).slice(0, 50) : undefined

  /** One feed line → an event, or undefined for anything that is not exactly one. */
  export function parseEvent(line: string): Event | undefined {
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      return undefined
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
    const o = v as Record<string, unknown>
    switch (o.type) {
      case "progress": {
        const done = Number(o.done)
        const total = Number(o.total)
        if (typeof o.done !== "number" || typeof o.total !== "number") return undefined
        if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return undefined
        return { type: "progress", done: Math.min(done, total), total }
      }
      case "inputs": {
        const measured = strings(o.measured)
        const drawn = strings(o.drawn)
        if (!measured || !drawn) return undefined
        return { type: "inputs", measured, drawn }
      }
      case "table": {
        const title = str(o.title)
        if (!title || !Array.isArray(o.columns) || !Array.isArray(o.rows)) return undefined
        if (!o.rows.every(Array.isArray)) return undefined
        const columns = o.columns.slice(0, MAX_COLS).map(cell)
        const rows = (o.rows as unknown[][]).slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map(cell))
        return { type: "table", title: title.slice(0, MAX_CELL), columns, rows }
      }
      case "flip": {
        const text = str(o.text)
        if (!text) return undefined
        const input = str(o.input)
        const range = str(o.range)
        return { type: "flip", text: text.slice(0, 2_000), ...(input ? { input } : {}), ...(range ? { range } : {}) }
      }
    }
    return undefined
  }

  /**
   * Feed bytes → complete lines. A partial last line (the engine mid-write) is handed back to be
   * prefixed to the next read, so a line split across two reads is not counted as bad.
   */
  export function readLines(pending: string, chunk: string, final = false): { lines: string[]; rest: string } {
    const all = pending + chunk
    const parts = all.split("\n")
    const rest = final ? "" : parts.pop()!
    if (final && parts.length && parts[parts.length - 1] === "") parts.pop()
    return { lines: parts.filter((l) => l.trim()), rest }
  }

  export function apply(feed: Feed, line: string) {
    const ev = parseEvent(line)
    if (!ev) {
      feed.ignored++
      return
    }
    switch (ev.type) {
      case "progress":
        feed.progress = { done: ev.done, total: ev.total }
        return
      case "inputs":
        feed.inputs = { measured: ev.measured, drawn: ev.drawn }
        return
      case "table": {
        // Same title: the engine re-printed it (a table that fills in) — replace, do not stack.
        const t = { title: ev.title, columns: ev.columns, rows: ev.rows }
        const at = feed.tables.findIndex((x) => x.title === ev.title)
        if (at >= 0) feed.tables[at] = t
        else if (feed.tables.length < MAX_TABLES) feed.tables.push(t)
        return
      }
      case "flip":
        if (feed.flips.length < MAX_FLIPS)
          feed.flips.push({ text: ev.text, ...(ev.input ? { input: ev.input } : {}), ...(ev.range ? { range: ev.range } : {}) })
        return
    }
  }

  /**
   * MEASURED vs DRAWN from the output, for an engine without the feed: the contract puts it in
   * the header, so the first lines that name either are it.
   */
  export function headerLines(text: string): string[] {
    const out: string[] = []
    for (const line of text.split("\n").slice(0, 200)) {
      const t = line.trim()
      if (/^[#|*\-\s]*(MEASURED|DRAWN)\b/.test(t) || (/\bMEASURED\b/.test(t) && /\bDRAWN\b/.test(t))) {
        out.push(t.slice(0, 300))
        if (out.length >= 4) break
      }
    }
    return out
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  export type StepRead = Omit<Step, "output"> & { output: string; next: number; truncated: boolean }
  export type Read = Omit<Run, "steps" | "cancel"> & { steps: StepRead[] }
  export type Summary = Omit<Run, "steps" | "cancel" | "feed" | "header"> & {
    steps: Pick<Step, "id" | "status">[]
    progress?: Progress
  }

  /** The run with each step's output from its own offset (`from`, one per step, comma separated). */
  export function read(run: Run, from: number[] = []): Read {
    const { cancel: _c, steps, ...rest } = run
    return {
      ...rest,
      steps: steps.map((s, i) => {
        const { output, ...st } = s
        if (!output) return { ...st, output: "", next: 0, truncated: false }
        const r = TerminalRun.read(output, from[i] ?? 0)
        return { ...st, output: r.output, next: r.next, truncated: r.truncated }
      }),
    }
  }

  export function summary(run: Run): Summary {
    const { cancel: _c, steps, feed, header: _h, ...rest } = run
    return { ...rest, steps: steps.map((s) => ({ id: s.id, status: s.status })), ...(feed.progress ? { progress: feed.progress } : {}) }
  }

  /**
   * As the wire carries it. The routes describe a run as an unknown JSON value, and that encoder
   * refuses `undefined` anywhere — a run with no progress yet answered 400 until this.
   */
  export function json<T>(value: T): unknown {
    return JSON.parse(JSON.stringify(value))
  }

  export function parseFrom(q: string | undefined): number[] {
    if (!q) return []
    return q.split(",").map((x) => {
      const n = Number(x)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    })
  }

  /** What the agent gets back: each step's result and the simulate output, head and tail. */
  export function report(run: Run): string {
    const mark: Record<StepStatus, string> = { waiting: "·", running: "…", passed: "✓", failed: "✗" }
    const lines = [
      `simulation ${run.id}: ${run.status.toUpperCase()}${run.reason ? ` — ${run.reason}` : ""}`,
      `engine: ${run.engine}  worlds=${run.knobs.worlds} cohort=${run.knobs.cohort} days=${run.knobs.days} refresh=${run.knobs.refresh ? "yes" : "no"}`,
      "",
      "steps:",
      ...run.steps.map(
        (s) =>
          `  ${mark[s.status]} ${s.id} — ${s.status}${s.exitCode !== null && s.exitCode !== 0 ? ` (exit ${s.exitCode})` : ""}${s.reason ? `: ${s.reason.replace(/\n/g, " / ")}` : ""}`,
      ),
    ]
    const io = run.feed.inputs
    if (io) lines.push("", `MEASURED: ${io.measured.join(", ") || "—"}`, `DRAWN: ${io.drawn.join(", ") || "—"}`)
    else if (run.header.length) lines.push("", ...run.header)
    for (const f of run.feed.flips)
      lines.push("", `FLIP: ${f.text}${f.input ? ` [input: ${f.input}]` : ""}${f.range ? ` [range: ${f.range}]` : ""}`)
    const sim = step(run, "simulate")
    const out = sim.output?.output ?? ""
    const shown = sim.status === "waiting" ? undefined : out
    const failed = run.steps.find((s) => s.status === "failed" && s.id !== "flip" && s.id !== "simulate")
    if (failed?.output) lines.push("", `--- ${failed.id} output ---`, trim(failed.output.output))
    if (shown !== undefined) {
      lines.push("", "--- simulate output ---", trim(shown, sim.output?.dropped ?? 0))
    }
    if (run.status === "passed") lines.push("", "Next: step:flip — read the flip section above and answer the playbook's three questions.")
    return lines.join("\n")
  }

  /** Head and tail of a long output: the header (MEASURED/DRAWN) and the end (ranking, flip). */
  export function trim(text: string, dropped = 0): string {
    const cut = dropped > 0 ? `[${dropped} earlier bytes dropped by the 1 MB cap]\n` : ""
    if (text.length <= RESULT_HEAD + RESULT_TAIL) return cut + text
    const head = text.slice(0, RESULT_HEAD)
    const tail = text.slice(-RESULT_TAIL)
    return `${cut}${head}\n[… ${text.length - RESULT_HEAD - RESULT_TAIL} characters cut …]\n${tail}`
  }

  // ── running it ──────────────────────────────────────────────────────────────────────────────

  /** How a step's script is executed. The real one spawns bash; tests pass a fake. */
  export type Exec = (input: {
    step: StepId
    script: string
    cwd: string
    env: Record<string, string>
    onOutput: (chunk: string) => void
  }) => Effect.Effect<number>

  /** The real executor: the terminal-mode spawn (process group, killed when interrupted). */
  export function spawnExec(spawner: ChildProcessSpawner["Service"]): Exec {
    return (input) =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("bash", ["-c", input.script], {
            cwd: input.cwd,
            extendEnv: true,
            env: { ...input.env, TERM: "dumb" },
            stdin: "ignore",
            forceKillAfter: "3 seconds",
          }),
        )
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => Effect.sync(() => input.onOutput(chunk)))
        return Number(yield* handle.exitCode)
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                input.onOutput(`\n[could not run the step: ${String(Cause.squash(cause))}]\n`)
                return 127
              }),
        ),
      )
  }

  /** Read new feed lines from the events file into the run. */
  function tail(run: Run, file: string, state: { offset: number; rest: string }, final = false) {
    let chunk = ""
    try {
      const fd = fs.openSync(file, "r")
      try {
        const size = fs.fstatSync(fd).size
        if (size > state.offset) {
          const want = Math.min(size - state.offset, 4 * 1024 * 1024)
          const buf = Buffer.alloc(want)
          const got = fs.readSync(fd, buf, 0, want, state.offset)
          state.offset += got
          chunk = buf.subarray(0, got).toString("utf8")
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // No file yet: the engine has not written (or never will). Not an error.
    }
    const { lines, rest } = readLines(state.rest, chunk, final)
    state.rest = rest
    for (const line of lines) apply(run.feed, line)
  }

  /**
   * Start a run and return it at once; the steps run detached from the caller, so the run
   * survives the tool call or the request that started it. Refuses when too many are running.
   */
  export function start(input: Input, exec: Exec, opts: { timeoutMs?: number; pollMs?: number } = {}): Run | string {
    const bad = validEngine(input.engine)
    if (bad) return bad
    const k = knobs(input)
    if (typeof k === "string") return k
    if (running() >= RUNNING_LIMIT) return `${RUNNING_LIMIT} simulations are already running — stop one or wait`
    const run = create({ ...input, knobs: k })
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-sim-"))
    const events = path.join(tmp, "events.jsonl")
    const env: Record<string, string> = {
      engine: input.engine,
      refresh: k.refresh ? "yes" : "no",
      days: String(k.days),
      worlds: String(k.worlds),
      cohort: String(k.cohort),
      TMPDIR: tmp,
    }
    const pollMs = opts.pollMs ?? 250

    const program = Effect.gen(function* () {
      for (const id of SHELL_STEPS) {
        if (run.status !== "running") return
        const s = step(run, id)
        s.output = TerminalRun.create(run.sessionID, `hive-sim ${id}`)
        begin(run, id)
        const fed = id === "simulate"
        const feedState = { offset: 0, rest: "" }
        const timer = fed ? setInterval(() => tail(run, events, feedState), pollMs) : undefined
        const code = yield* exec({
          step: id,
          script: SCRIPTS[id],
          cwd: input.directory,
          env: fed ? { ...env, HIVE_SIM_EVENTS: events } : env,
          onOutput: (chunk) => TerminalRun.append(s.output!, chunk),
        }).pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))
        if (fed) tail(run, events, feedState, true)
        TerminalRun.finish(s.output, { status: "exited", exitCode: code })
        if (id === "simulate" || !run.header.length) run.header = headerLines(s.output.output)
        end(run, id, code)
      }
      conclude(run)
    })

    let reason = "stopped"
    let deadline: ReturnType<typeof setTimeout> | undefined
    const fiber = Effect.runFork(
      program.pipe(
        Effect.onInterrupt(() => Effect.sync(() => stop(run, reason))),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(() => stop(run, `the run broke: ${String(Cause.squash(cause))}`)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            clearTimeout(deadline)
            fs.rmSync(tmp, { recursive: true, force: true })
          }),
        ),
      ),
    )
    if (run.status !== "running") return run
    run.cancel = (why: string) => {
      reason = why
      Effect.runFork(Fiber.interrupt(fiber))
    }
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
    deadline = setTimeout(() => run.cancel?.(`timed out after ${Math.round(timeoutMs / 1000)} s (the playbook's limit)`), timeoutMs)
    return run
  }

  export function cancel(sessionID: string, id: string): boolean {
    const run = get(sessionID, id)
    if (!run || run.status !== "running" || !run.cancel) return false
    run.cancel("stopped")
    return true
  }

  /** Resolve when the run has ended, or after `ms`, or when `signal` aborts — whichever is first. */
  export function wait(run: Run, ms: number, signal?: AbortSignal, pollMs = 250): Promise<void> {
    return new Promise((resolve) => {
      const until = Date.now() + ms
      const tick = () => {
        if (run.status !== "running" || Date.now() >= until || signal?.aborted) return resolve()
        setTimeout(tick, pollMs)
      }
      tick()
    })
  }

  /** Tests only. */
  export function reset() {
    for (const r of runs.values()) r.cancel?.("stopped")
    runs.clear()
  }
}
