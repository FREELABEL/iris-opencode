/**
 * The task `iris hive run` creates — pulled out of the handler so what it sends can be tested.
 *
 * Delegation lineage (#188667): `hive run` is the command people actually use to hand work to
 * another machine, and it was the one sender that never stamped `metadata.origin`. `tasks create`
 * and `handoff --run` did, so the same work reported back into the session or vanished depending
 * on which spelling you used. With --queue (or when the bash tool kills a long wait at its own
 * timeout) the CLI is gone before the task ends, and without an origin nothing ever came back.
 */
import type { DelegationOrigin } from "./hive-delegation-origin"

export interface HiveRunBodyInput {
  userId: number
  nodeId: string
  title: string
  script: string
  timeoutSec: number
  priority?: number
  origin?: DelegationOrigin | null
  /** --force (#191603): run on this node even though it reports CPU/memory pressure. */
  force?: boolean
  /**
   * #191559 — when the node is full (or busy), wait in its queue instead of failing. Being full is
   * a normal, transient state: a 3-slot node given 4 jobs used to fail the 4th in 1.7 s.
   */
  waitForSlot?: boolean
  /** ISO time by which the task must have STARTED; past it the platform expires it (#187568). */
  notAfter?: string
}

export function buildHiveRunBody(input: HiveRunBodyInput): Record<string, unknown> {
  return {
    user_id: input.userId,
    title: input.title,
    type: "sandbox_execute",
    node_id: input.nodeId,
    prompt: input.script,
    config: { timeout_seconds: input.timeoutSec },
    timeout_seconds: input.timeoutSec,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.force ? { force: true } : {}),
    ...(input.waitForSlot ? { allow_busy_queue: true } : {}),
    ...(input.notAfter ? { not_after: input.notAfter } : {}),
    ...(input.origin ? { metadata: { origin: input.origin } } : {}),
  }
}

/** Statuses that END a task. `expired` is one (#187568): a task that never started in time. */
export const ENDED_STATUSES = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored", "expired"])

/**
 * May `hive run` send work to a node in this connection state? (#191559)
 *
 * `busy` is what the platform calls a node whose slots are all taken. The CLI used to refuse it
 * itself — "Node is busy … Cannot dispatch", rc=2 — so even `--queue` queued nothing. Only a node
 * that is not connected is refused here; full or loaded nodes are the platform's to queue.
 */
export function dispatchableConnection(status: string | null | undefined): boolean {
  return status === "online" || status === "busy"
}

export interface CreatedTask {
  id: string
  status: string
  error?: string | null
  queued_reason?: string | null
}

/**
 * What `hive run --queue` reports for the task the platform just created (#191575).
 *
 * It printed "✓ dispatched … status=failed" for a task the platform had already refused, and
 * exited 0 — a fire-and-forget caller never looks again, so the work silently never happened.
 * Pure, so it is tested.
 */
export function queuedReport(task: CreatedTask, nodeName: string): { ok: boolean; headline: string; detail: string | null; exitCode: number } {
  if (ENDED_STATUSES.has(task.status)) {
    return {
      ok: false,
      headline: `✗ not queued — task ${task.id} is ${task.status}`,
      detail: task.error ? String(task.error) : null,
      exitCode: 1,
    }
  }
  if (task.status === "pending") {
    return {
      ok: true,
      headline: `✓ queued task ${task.id} — waiting for ${nodeName}`,
      detail: task.queued_reason ? `${nodeName} is ${task.queued_reason}; it starts when a slot frees` : null,
      exitCode: 0,
    }
  }
  return { ok: true, headline: `✓ dispatched task ${task.id}  status=${task.status}`, detail: null, exitCode: 0 }
}

/**
 * One line for a status change while `hive run` waits (#191560), or null for "say nothing new".
 *
 * A task that goes BACK to pending after it was sent was dropped by its machine and queued again;
 * printing a bare "status=pending" read as "not started yet" for 20 minutes.
 */
export function statusLine(prev: string | undefined, task: { status: string; progress?: number | null; queued_reason?: string | null }): string | null {
  if (ENDED_STATUSES.has(task.status)) return null
  if (task.status === "pending") {
    if (prev && prev !== "pending" && prev !== "assigned") return "requeued — its machine dropped it before it finished; waiting to send it again"
    return `queued — waiting for a free slot${task.queued_reason ? ` (${task.queued_reason})` : ""}`
  }
  return `status=${task.status}${task.progress ? `  progress=${task.progress}%` : ""}`
}

/** The honest last word when the CLI stops waiting before the task ends (#191560). */
export function stoppedWaitingNote(lastStatus: string | undefined): string {
  if (lastStatus === "pending" || lastStatus === "assigned") return "the task has not started on the node yet (still queued); it was not cancelled"
  if (lastStatus === "dispatched") return "the task was sent to the node but has not reported starting; it was not cancelled"
  return "the task was last reported running on the node; it was not cancelled"
}
