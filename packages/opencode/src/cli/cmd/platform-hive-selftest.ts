/**
 * `iris hive selftest` — prove the transport carries bytes, rather than assuming it (#182018).
 *
 * This dispatches a command whose output is a marker minted for THIS run, and then checks
 * what came back against what was sent. It talks to the task API directly instead of going
 * through `iris hive run`, because a harness that shares code with the thing under test
 * cannot detect a bug in the shared part.
 *
 * It is expected to FAIL today, and the failures are the point: each one names the ticket
 * that will fix it. A selftest that passed on a transport known to corrupt its output would
 * be worse than none.
 */

import { cmd } from "./cmd"
import { requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { hiveFetch, resolveNode, fetchNodes } from "./platform-hive-nodes"
import { fromHiveTask } from "./hive-script-result"
import { assessRoundTrip, summarise, type Assertion, type RoundTripObserved } from "./hive-selftest-assert"
import { randomUUID } from "crypto"

const SLEEP_MS = 3000
const EXIT_CODE = 42

interface NodeReport {
  node: string
  ok: boolean
  skipped?: string
  assertions: Assertion[]
  taskId?: string
}

async function runOnce(userId: number, nodeId: string, nodeName: string, timeoutSec: number): Promise<NodeReport> {
  const run = randomUUID().slice(0, 8)
  const stdoutMarker = `IRIS_SELFTEST_OUT_${run}`
  const stderrMarker = `IRIS_SELFTEST_ERR_${run}`

  // No `set -e`: this script is SUPPOSED to end on a non-zero exit, and a wrapper that
  // aborted early would test the wrapper instead of the transport.
  const script =
    `#!/bin/bash\n` +
    `echo ${stdoutMarker}\n` +
    `echo ${stderrMarker} >&2\n` +
    `sleep ${SLEEP_MS / 1000}\n` +
    `exit ${EXIT_CODE}\n`

  const createRes = await hiveFetch(`/api/v6/nodes/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      title: `iris hive selftest ${run}`,
      type: "sandbox_execute",
      node_id: nodeId,
      prompt: script,
      config: { timeout_seconds: timeoutSec },
      timeout_seconds: timeoutSec,
    }),
  })
  if (!createRes.ok) {
    return { node: nodeName, ok: false, skipped: `could not dispatch: HTTP ${createRes.status}`, assertions: [] }
  }
  const created = (await createRes.json()) as { task: { id: string } }
  const taskId = created.task.id

  const started = Date.now()
  const deadline = started + (timeoutSec + 30) * 1000
  const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
  let final: any = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
    if (!r.ok) break
    const t = ((await r.json()) as any).task
    if (terminal.has(t.status)) {
      final = t
      break
    }
  }

  if (!final) {
    return {
      node: nodeName,
      ok: false,
      taskId,
      assertions: [
        {
          id: "task-reaches-a-terminal-state",
          claim: "the task reaches a terminal state within its timeout",
          pass: false,
          detail: `still not terminal after ${Math.round((Date.now() - started) / 1000)}s`,
          knownIssue: "#182004 — the tmux wait-for channel does not always fire",
        },
      ],
    }
  }

  const mapped = fromHiveTask(final)
  const observed: RoundTripObserved = {
    stdout: mapped.stdout ?? "",
    stderr: mapped.stderr ?? "",
    reportedExit: mapped.exit_code ?? null,
    exitSource: mapped.exit_code_source ?? null,
    status: String(final.status),
    durationMs: typeof final.duration_ms === "number" ? final.duration_ms : null,
    timedOut: mapped.timed_out === true,
  }

  const assertions = assessRoundTrip(
    { stdoutMarker, stderrMarker, exitCode: EXIT_CODE, expectedMs: SLEEP_MS },
    observed,
  )
  return { node: nodeName, ok: summarise(assertions).ok, assertions, taskId }
}

const HiveSelftestCommand = cmd({
  command: "selftest [node]",
  describe: "prove a node's task transport actually carries stdout, stderr and an exit code",
  builder: (yargs) =>
    yargs
      .positional("node", { describe: "node name or id (omit with --all)", type: "string" })
      .option("all", { describe: "test every online node you own", type: "boolean", default: false })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 60 })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    let targets: Array<{ id: string; name: string; connection_status?: string }> = []
    if (argv.all) {
      targets = ((await fetchNodes(userId)) as any[]).filter((n) => n.connection_status === "online")
    } else if (argv.node) {
      const n = await resolveNode(userId, String(argv.node))
      if (!n) {
        console.error(`No node matching "${argv.node}". Run: iris hive nodes list`)
        process.exit(1)
      }
      targets = [n as any]
    } else {
      console.error("Specify a node, or pass --all.")
      process.exit(1)
    }

    // SKIP LOUDLY. A suite that silently exercised nothing is the failure mode this command
    // exists to prevent, so "no online node" is reported, never treated as a pass.
    if (targets.length === 0) {
      const msg = "SKIPPED — no online node to test against. This is NOT a pass; the transport was not exercised."
      if (argv.json) {
        await writeJson({ ok: false, skipped: true, reason: msg, nodes: [] })
      } else {
        console.log()
        console.log(`  ${bold(msg)}`)
        console.log()
      }
      process.exit(2)
    }

    const timeoutSec = Math.max(30, Math.min(600, Number(argv.timeout) || 60))
    const reports: NodeReport[] = []
    for (const t of targets) {
      if (!argv.json) console.log(`${dim("→")} round-trip on ${bold(t.name)}…`)
      reports.push(await runOnce(userId, t.id, t.name, timeoutSec))
    }

    if (argv.json) {
      await writeJson({ ok: reports.every((r) => r.ok), nodes: reports })
      if (!reports.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of reports) {
      const s = summarise(r.assertions)
      console.log(`${r.ok ? success("✓") : dim("✗")} ${bold(r.node)}  ${dim(`${s.passed}/${r.assertions.length} assertions`)}${r.taskId ? dim(`  task ${r.taskId.slice(0, 8)}`) : ""}`)
      if (r.skipped) console.log(`    ${r.skipped}`)
      for (const a of r.assertions) {
        const mark = a.pass ? success("  ✓") : dim("  ✗")
        console.log(`  ${mark} ${a.claim}`)
        console.log(`       ${dim(a.detail)}`)
        if (!a.pass && a.knownIssue) console.log(`       ${dim("known: " + a.knownIssue)}`)
      }
      console.log()
    }

    const failing = reports.filter((r) => !r.ok)
    const known = reports.flatMap((r) => r.assertions).filter((a) => !a.pass && a.knownIssue).length
    console.log(`  ${reports.length - failing.length}/${reports.length} node(s) with a fully working transport`)
    if (known > 0) {
      console.log(`  ${dim(`${known} failing assertion(s) are known and already ticketed — this command is how you will know they are fixed`)}`)
    }
    console.log()
    if (failing.length) process.exit(1)
  },
})

export const HiveSelftestCommandExport = HiveSelftestCommand
