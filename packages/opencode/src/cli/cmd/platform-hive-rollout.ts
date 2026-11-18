// `iris hive rollout` — the command. The engine (planning, ordering, stop-on-failure, verifying
// by asking each node) is hive-rollout.ts; this file only wires it to the real Hive API.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { bold, dim, requireAuth, requireUserId, success, writeJson } from "./iris-api"
import { Installation } from "../../installation"
import type { FleetNode, RolloutDeps, TaskOutcome } from "./hive-rollout"

/** Exit codes, for automation: 0 everything current · 1 a node failed · 2 nothing ran (usage, refused, not confirmed) · 3 done, but nodes are still pending. */
export const ROLLOUT_EXIT = { ok: 0, failed: 1, aborted: 2, pending: 3 } as const

async function localNodeId(nodes: FleetNode[]): Promise<string | null> {
  const { resolveLocalNode } = await import("./hive-local-node")
  let configNodeId: string | null = null
  try {
    configNodeId = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".iris", "config.json"), "utf-8")).node_id || null
  } catch {}
  let daemonNodeId: string | null = null
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.BRIDGE_PORT || 3200}/health`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) daemonNodeId = ((await res.json()) as any)?.node_id ?? null
  } catch {}
  const r = resolveLocalNode({ daemonNodeId, configNodeId, hostname: os.hostname(), nodes: nodes.map((n) => ({ id: String(n.id), name: String(n.name) })) })
  // A hostname guess is not good enough to pick the canary.
  return r.uncertain ? null : r.nodeId
}

/**
 * Every task the rollout sends. `force: true` always: the owner asked for this maintenance, and a
 * node the hub calls busy from CPU/memory pressure must not refuse it (#191603).
 */
export function rolloutTaskBody(
  build: typeof import("./hive-run-body").buildHiveRunBody,
  userId: number,
  nodeId: string,
  title: string,
  script: string,
  timeoutSec: number,
): Record<string, unknown> {
  return build({ userId, nodeId, title, script, timeoutSec, force: true })
}

export async function realDeps(userId: number, log: (s: string) => void): Promise<RolloutDeps> {
  const { fetchNodes, dispatchTaskAndWait, hiveFetch } = await import("./platform-hive-nodes")
  const { buildHiveRunBody } = await import("./hive-run-body")
  const { fromHiveTask } = await import("./hive-script-result")
  const { resolveRef } = await import("./daemon-update")
  let cached: FleetNode[] | null = null
  return {
    async listNodes() {
      cached = (await fetchNodes(userId)) as unknown as FleetNode[]
      return cached
    },
    resolveRef: (ref) => resolveRef(ref),
    async run(node, script, o): Promise<TaskOutcome> {
      const body = rolloutTaskBody(buildHiveRunBody, userId, node.id, o.title, script, o.timeoutSec)
      const { taskId, final } = await dispatchTaskAndWait(userId, body)
      if (!final) return { finished: false, exit_code: null, stdout: "", stderr: "", taskId }
      const r = fromHiveTask(final as any)
      return { finished: true, exit_code: r.exit_code ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", taskId }
    },
    async cancel(taskId) {
      await hiveFetch(`/api/v6/nodes/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => {})
    },
    localNodeId: async () => localNodeId(cached ?? ((await fetchNodes(userId)) as unknown as FleetNode[])),
    localCliVersion: Installation.VERSION,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log,
  }
}

export const HiveRolloutCommand = cmd({
  command: "rollout",
  describe: "update the IRIS daemon (and the iris CLI) on every machine in your Hive — plan, canary, then one at a time",
  builder: (y) =>
    y
      .option("ref", { type: "string", default: "main", describe: "iris-daemon commit SHA or branch to roll out (resolved once; every node gets the same commit)" })
      .option("nodes", { type: "string", describe: "comma-separated node names or ids (default: every node)" })
      .option("all", { type: "boolean", default: false, describe: "every node (the default when --nodes is not given)" })
      .option("canary", { type: "string", describe: "node to update first (default: this machine if it is a node, else the first ready one)" })
      .option("dry-run", { type: "boolean", default: false, describe: "ask every online node for its plan and print the table — changes nothing" })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "do not ask for confirmation" })
      .option("parallel", { type: "number", default: 1, describe: "nodes updated at once after the canary" })
      .option("force", { type: "boolean", default: false, describe: "also replace installs with local edits to shipped files (kept in ~/.iris/bridge.prev)" })
      .option("keep-going", { type: "boolean", default: false, describe: "continue with the other nodes after a failure (the canary always stops it)" })
      .option("wait", { type: "number", default: 420, describe: "seconds to wait for each node to report its outcome" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable report" })
      .option("user-id", { type: "number", describe: "user ID" })
      .example("iris hive rollout --dry-run", "see what would change on every machine")
      .example("iris hive rollout --canary my-laptop", "update my-laptop first, then the rest one at a time")
      .example("iris hive rollout --nodes office-mac,build-box --yes", "two machines, no prompt"),
  async handler(args) {
    const engine = await import("./hive-rollout")
    const json = Boolean(args.json)
    const dryRun = Boolean(args["dry-run"])
    const say = json ? () => {} : (s: string) => console.log(s)
    if (args.nodes && args.all) {
      prompts.log.error("Use --nodes or --all, not both.")
      process.exitCode = ROLLOUT_EXIT.aborted
      return
    }
    // A rollout restarts daemons; it never starts without a person saying so.
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !json
    if (!dryRun && !args.yes && !interactive) {
      const msg = "Refusing to update machines without confirmation: add --yes (or run --dry-run first)."
      if (json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = ROLLOUT_EXIT.aborted
      return
    }

    await requireAuth()
    const userId = await requireUserId(args["user-id"])
    if (!userId) {
      process.exitCode = ROLLOUT_EXIT.aborted
      return
    }
    const deps = await realDeps(userId, say)
    const nodes = args.nodes ? String(args.nodes).split(",").map((s) => s.trim()).filter(Boolean) : undefined

    say(bold("  iris hive rollout") + dim(dryRun ? "  (dry run — nothing will change)" : ""))
    say(dim(`  resolving ${args.ref} and asking every online node for its plan…`))
    let report
    try {
      report = await engine.runRollout(deps, {
        ref: String(args.ref),
        nodes,
        canary: args.canary ? String(args.canary) : undefined,
        dryRun,
        force: Boolean(args.force),
        keepGoing: Boolean(args["keep-going"]),
        parallel: Math.max(1, Number(args.parallel) || 1),
        waitSec: Number(args.wait) || 420,
        confirm: async (plan) => {
          say("")
          say(`  target: ${plan.target}  (${plan.ref})`)
          for (const l of engine.formatPlanTable(plan)) say(l)
          say("")
          say(`  order: ${plan.order.map((r) => r.name).join(" → ")}${Number(args.parallel) > 1 ? dim(` (after the canary, ${args.parallel} at a time)`) : dim(" (one at a time; stops at the first failure)")}`)
          if (args.yes) return true
          const ok = await prompts.confirm({ message: `Update ${plan.order.length} machine(s)? Each daemon restarts once and rolls itself back if the new code does not come up.` })
          return ok === true
        },
      })
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = ROLLOUT_EXIT.failed
      return
    }

    if (json) {
      await writeJson(report)
    } else {
      if (dryRun) {
        say("")
        say(`  target: ${report.target}  (${report.ref})`)
        const canary = report.plan.find((r) => r.id === report.canary) ?? null
        for (const l of engine.formatPlanTable({ rows: report.plan, target: report.target, canary })) say(l)
        const ready = report.plan.filter(engine.isReady).length
        say("")
        say(ready ? `  ${ready} machine(s) would update${canary ? `, ${canary.name} first` : ""}. Run it: iris hive rollout --ref ${report.target}${nodes ? ` --nodes ${nodes.join(",")}` : ""}` : "  Nothing to update.")
      } else {
        say("")
        if (report.aborted) prompts.log.warn(report.aborted)
        for (const l of engine.formatReport(report)) say(l)
        if (report.ok && !report.aborted) prompts.log.info(`${success("✓")} rollout of ${report.target.slice(0, 7)} finished`)
      }
    }
    const pending = report.summary.offline.length + report.summary.skipped.length + report.summary.notAttempted.length
    process.exitCode = report.aborted ? ROLLOUT_EXIT.aborted : !report.ok ? ROLLOUT_EXIT.failed : pending && !dryRun ? ROLLOUT_EXIT.pending : ROLLOUT_EXIT.ok
  },
})
