/**
 * The night shift's bookkeeping — which tasks ran, how each ended, and what a person must decide
 * in the morning (#191797, #191800).
 *
 * THREE RULES THE STATE KEEPS:
 *
 *   1. A TASK NEVER RUNS TWICE ON ITS OWN. The batch id is the hash of the tasks file, so re-running
 *      the same file resumes the same batch and skips what finished. A task found `running` (the
 *      process died mid-task) becomes `interrupted`, NOT pending: we cannot know whether it got as
 *      far as the send, and re-running a half-sent payment is worse than asking.
 *   2. LATE IS EXPIRED, NOT RUN. Anything not started by the cutoff is `expired`. A reminder text
 *      sent at 10am is a different act from the one approved for 3am.
 *   3. A CHECKER THAT CANNOT FAIL IS NOT A CHECKER. A `send: true` task with nothing in `expect:` is
 *      refused at parse time — there would be nothing to hold it on.
 *
 * Pure. platform-android.ts does the I/O.
 */

import { createHash } from "crypto"
import type { Mismatch } from "./android-screen"

export type Profile = "flash" | "pro"
export type TaskStatus = "pending" | "running" | "passed" | "failed" | "held" | "expired" | "interrupted" | "dropped"

export interface TaskSpec {
  id: string
  prompt: string
  profile: Profile
  /** Commit with a send-class tap after the checker passes. The actor never presses it itself. */
  send: boolean
  expect: Record<string, string>
}

export interface TaskResult {
  status: TaskStatus
  started_at?: string
  finished_at?: string
  reason?: string
  mismatches?: Mismatch[]
  before?: string
  after?: string
  trace?: string
  exit_code?: number | null
}

export interface HealthSample {
  ts: string
  level: number | null
  plugged: boolean | null
  tempC: number | null
  ok: boolean
  reason?: string
}

export interface BatchState {
  batch_id: string
  file: string
  device: string
  created_at: string
  until: string
  tasks: Record<string, TaskResult>
  order: string[]
  health: HealthSample[]
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export class TaskFileError extends Error {}

/**
 * Parse a tasks file's already-decoded content (YAML or JSON): either `{ tasks: [...] }` or a bare
 * list. Every problem is reported at once — finding the third bad task after fixing the first two
 * is how a batch gets started at 2am instead of 11pm.
 */
export function parseTasks(doc: unknown): TaskSpec[] {
  const list = Array.isArray(doc) ? doc : (doc as any)?.tasks
  if (!Array.isArray(list) || list.length === 0) throw new TaskFileError("no tasks — expected a list, or `tasks:` with a list under it")
  const errors: string[] = []
  const seen = new Set<string>()
  const out: TaskSpec[] = []
  list.forEach((t: any, i: number) => {
    const where = `task ${i + 1}${t?.id ? ` (${t.id})` : ""}`
    const id = String(t?.id ?? "").trim()
    if (!ID.test(id)) errors.push(`${where}: id must be letters, digits, - or _ (it names files)`)
    else if (seen.has(id)) errors.push(`${where}: duplicate id`)
    seen.add(id)
    const prompt = String(t?.prompt ?? "").trim()
    if (!prompt) errors.push(`${where}: prompt is empty`)
    const profile = String(t?.profile ?? "pro").toLowerCase()
    if (profile !== "flash" && profile !== "pro") errors.push(`${where}: profile must be flash or pro`)
    const expect: Record<string, string> = {}
    if (t?.expect !== undefined && t?.expect !== null) {
      if (typeof t.expect !== "object" || Array.isArray(t.expect)) errors.push(`${where}: expect must be a map of name: value`)
      else for (const [k, v] of Object.entries(t.expect)) expect[k] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
    }
    const send = t?.send === true
    if (send && Object.keys(expect).length === 0)
      errors.push(`${where}: send: true needs expect: — a checker with nothing to check cannot fail, so it cannot hold the send`)
    out.push({ id, prompt, profile: profile as Profile, send, expect })
  })
  if (errors.length) throw new TaskFileError(errors.join("\n"))
  return out
}

/** Same file content → same batch. A changed file is a different batch, and starts clean. */
export function batchIdFor(content: string): string {
  return "b" + createHash("sha256").update(content).digest("hex").slice(0, 12)
}

/**
 * The cutoff. `07:00` means the NEXT 07:00 in local time (so starting at 23:00 means tomorrow
 * morning, and starting at 06:00 means in an hour). An ISO time is taken as given. A cutoff in
 * the past is refused rather than producing a batch where everything expires instantly.
 */
export function parseUntil(value: string, now: Date): Date {
  const v = String(value ?? "").trim()
  const hm = v.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (hm) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return d
  }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new TaskFileError(`--until "${v}" is neither HH:MM nor an ISO time`)
  if (d.getTime() <= now.getTime()) throw new TaskFileError(`--until ${d.toISOString()} is already past`)
  return d
}

export function newState(args: { batchId: string; file: string; device: string; until: Date; tasks: TaskSpec[]; now: Date }): BatchState {
  const tasks: Record<string, TaskResult> = {}
  for (const t of args.tasks) tasks[t.id] = { status: "pending" }
  return {
    batch_id: args.batchId,
    file: args.file,
    device: args.device,
    created_at: args.now.toISOString(),
    until: args.until.toISOString(),
    tasks,
    order: args.tasks.map((t) => t.id),
    health: [],
  }
}

/**
 * Bring a loaded state up to date for a resume: a task left `running` is `interrupted` (rule 1).
 * A cutoff passed EXPLICITLY on the resume replaces the old one, earlier or later — the person
 * re-running it is the one who decides the window. The first draft only allowed a later one, which
 * meant "stop by 5 instead" was silently ignored and the batch kept working until 7; a window that
 * cannot be shortened is the unsafe direction. No cutoff given → the original stands.
 */
export function resume(state: BatchState, newUntil?: Date): BatchState {
  const tasks: Record<string, TaskResult> = {}
  for (const [id, r] of Object.entries(state.tasks))
    tasks[id] = r.status === "running" ? { ...r, status: "interrupted", reason: "the batch stopped mid-task — it may or may not have acted; retry it deliberately" } : r
  const until = newUntil ? newUntil.toISOString() : state.until
  return { ...state, tasks, until }
}

/** The next task to run, or null. Expires everything still pending once the cutoff has passed. */
export function nextTask(state: BatchState, now: Date): { state: BatchState; id: string | null } {
  if (now.getTime() >= new Date(state.until).getTime()) return { state: expireRemaining(state, now), id: null }
  const id = state.order.find((i) => state.tasks[i]?.status === "pending") ?? null
  return { state, id }
}

export function expireRemaining(state: BatchState, now: Date): BatchState {
  const tasks = { ...state.tasks }
  for (const id of state.order)
    if (tasks[id].status === "pending") tasks[id] = { status: "expired", finished_at: now.toISOString(), reason: `not started before the cutoff (${state.until})` }
  return { ...state, tasks }
}

export function setResult(state: BatchState, id: string, r: TaskResult): BatchState {
  return { ...state, tasks: { ...state.tasks, [id]: r } }
}

/** `retry` puts a finished task back in the queue; `drop` takes it out for good. Both say why. */
export function retryTask(state: BatchState, id: string): BatchState {
  if (!state.tasks[id]) throw new TaskFileError(`no task "${id}" in batch ${state.batch_id}`)
  return setResult(state, id, { status: "pending" })
}

export function dropTask(state: BatchState, id: string, now: Date): BatchState {
  if (!state.tasks[id]) throw new TaskFileError(`no task "${id}" in batch ${state.batch_id}`)
  return setResult(state, id, { ...state.tasks[id], status: "dropped", finished_at: now.toISOString(), reason: "dropped by a person" })
}

export function counts(state: BatchState): Record<TaskStatus, number> {
  const c: Record<TaskStatus, number> = { pending: 0, running: 0, passed: 0, failed: 0, held: 0, expired: 0, interrupted: 0, dropped: 0 }
  for (const id of state.order) c[state.tasks[id].status]++
  return c
}

/** Needs a person: held by the checker, or interrupted with an unknown outcome. */
export function needsYou(state: BatchState): string[] {
  return state.order.filter((id) => ["held", "interrupted"].includes(state.tasks[id].status))
}

// ─────────────────────────────── the morning report ───────────────────────────────

/**
 * One markdown document a person can read on a phone. It leads with what needs them, because a
 * report that opens with "38 passed" buries the two tasks it exists to surface.
 */
export function renderReport(state: BatchState, specs: TaskSpec[]): string {
  const c = counts(state)
  const spec = new Map(specs.map((s) => [s.id, s]))
  const lines: string[] = []
  lines.push(`# Android night shift — batch ${state.batch_id}`)
  lines.push("")
  lines.push(`Device \`${state.device}\` · started ${state.created_at} · cutoff ${state.until} · file \`${state.file}\``)
  lines.push("")
  lines.push(`**${c.passed} passed · ${c.held} held · ${c.failed} failed · ${c.interrupted} interrupted · ${c.expired} expired · ${c.dropped} dropped**${c.pending ? ` · ${c.pending} still pending` : ""}`)
  lines.push("")

  const waiting = needsYou(state)
  lines.push("## Needs you")
  if (!waiting.length) lines.push("Nothing. Every task that ran either passed or failed on its own.")
  for (const id of waiting) {
    const r = state.tasks[id]
    lines.push(`### ${id} — ${r.status.toUpperCase()}`)
    if (spec.get(id)) lines.push(`> ${spec.get(id)!.prompt}`)
    if (r.reason) lines.push(r.reason)
    for (const m of r.mismatches ?? [])
      lines.push(`- **${m.key}**: expected \`${m.expected}\`${m.seen.length ? `, screen showed \`${m.seen.join("`, `")}\`` : ", not on screen"}`)
    if (r.after || r.before) lines.push(`- screenshot: \`${r.after ?? r.before}\``)
    lines.push(`- retry: \`iris android batch retry ${state.batch_id} ${id}\` · drop: \`iris android batch drop ${state.batch_id} ${id}\``)
    lines.push("")
  }

  lines.push("## Every task")
  lines.push("| task | status | reason |")
  lines.push("|---|---|---|")
  for (const id of state.order) {
    const r = state.tasks[id]
    lines.push(`| ${id} | ${r.status} | ${(r.reason ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)} |`)
  }

  const pauses = state.health.filter((h) => !h.ok)
  if (state.health.length) {
    const levels = state.health.map((h) => h.level).filter((l): l is number => l !== null)
    const temps = state.health.map((h) => h.tempC).filter((t): t is number => t !== null)
    lines.push("")
    lines.push("## Phone health")
    if (levels.length) lines.push(`Battery ${levels[0]}% → ${levels[levels.length - 1]}% · peak ${temps.length ? Math.max(...temps) : "?"} °C · ${pauses.length} paused check${pauses.length === 1 ? "" : "s"}`)
    for (const p of pauses.slice(0, 20)) lines.push(`- ${p.ts}: paused — ${p.reason}`)
  }
  return lines.join("\n")
}
