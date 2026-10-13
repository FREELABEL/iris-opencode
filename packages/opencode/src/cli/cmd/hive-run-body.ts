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
    ...(input.origin ? { metadata: { origin: input.origin } } : {}),
  }
}
