#!/usr/bin/env bun
/**
 * Agent benchmark for the IRIS MCP tool layout (#193064).
 *
 *   bun script/agent-bench/run.ts [--label baseline] [--repeats 3] [--model sonnet] [--only id,id] [--max-usd 0.50]
 *
 * Each run: `claude -p <task>` in a fresh empty folder, with ONLY this checkout's `iris mcp serve` (no
 * built-in tools, no other MCP servers, no project instructions), under IRIS_MCP_DRY_RUN=1 — reads run
 * for real, everything else is recorded and not executed. A task passes when the agent made at least one
 * call matching its `accept` list (tasks.json). Writes a JSON report to script/agent-bench/results/.
 *
 * Costs real model calls: tasks × repeats runs. Start small (#193064 decision: 10 tasks first).
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

type Accept = { tool: string; command?: string; action?: string }
type Task = { id: string; effect: string; prompt: string; accept: Accept[] }
type Call = { tool: string; input: Record<string, unknown> }

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const HERE = import.meta.dir
const ROOT = resolve(HERE, "..", "..") // packages/opencode
const label = arg("label", "baseline")
const repeats = Number(arg("repeats", "3"))
const model = arg("model", "sonnet")
const maxUsd = arg("max-usd", "0.50")
const only = arg("only", "")
const { tasks } = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf8")) as { tasks: Task[] }
const chosen = only ? tasks.filter((t) => only.split(",").includes(t.id)) : tasks

/** Pure: does this call satisfy one of the task's accept entries? Exported for the test. */
export function matches(call: Call, accept: Accept[]): boolean {
  return accept.some((a) => {
    if (call.tool !== a.tool) return false
    if (a.command && !new RegExp(a.command).test(String(call.input.command ?? "").replace(/^iris\s+/, "").trim())) return false
    if (a.action && call.input.action !== a.action) return false
    return true
  })
}

/** Pure: the IRIS tool calls and the final result out of claude's stream-json lines. */
export function parseStream(stdout: string) {
  const calls: Call[] = []
  let result: any = null
  let mcpStatus = ""
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === "assistant")
      for (const c of ev.message?.content ?? [])
        if (c?.type === "tool_use" && typeof c.name === "string" && c.name.startsWith("mcp__iris__"))
          calls.push({ tool: c.name.slice("mcp__iris__".length), input: c.input ?? {} })
    if (ev.type === "result") result = ev
    if (ev.type === "system" && ev.subtype === "init") mcpStatus = (ev.mcp_servers ?? []).map((m: any) => `${m.name}:${m.status}`).join(",")
  }
  return { calls, result, mcpStatus }
}

async function runOnce(task: Task, n: number) {
  const dir = mkdtempSync(join(tmpdir(), `iris-bench-${task.id}-`))
  const dryLog = join(dir, "dry-run.jsonl")
  const mcp = {
    mcpServers: {
      iris: {
        command: process.execPath,
        // `run --cwd` (in that order — `bun --cwd X run` prints usage and exits): bun resolves the project's config (JSX runtime) from its working folder; started from the
        // agent's empty temp folder the server crashed on load and Claude reported it "failed".
        args: ["run", "--cwd", ROOT, "--conditions=browser", join(ROOT, "src", "index.ts"), "mcp", "serve", "--playbooks=false"],
        env: { IRIS_MCP_DRY_RUN: "1", IRIS_MCP_DRY_RUN_LOG: dryLog },
      },
    },
  }
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp))
  const started = Date.now()
  const proc = Bun.spawn(
    ["claude", "-p", task.prompt, "--model", model, "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", "--mcp-config", join(dir, "mcp.json"), "--tools", "", "--allowedTools", "mcp__iris__*",
      "--no-session-persistence", "--max-budget-usd", maxUsd],
    // MCP_TIMEOUT: a server started from source compiles on launch; give it a minute to connect.
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, MCP_TIMEOUT: "60000" } },
  )
  const timer = setTimeout(() => proc.kill(), 240_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(timer)
  const { calls, result, mcpStatus } = parseStream(stdout)
  const dryRun = existsSync(dryLog) ? readFileSync(dryLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  const lookups = calls.filter((c) => c.tool === "iris_help").length
  const hit = calls.some((c) => matches(c, task.accept))
  return {
    task: task.id, effect: task.effect, n, pass: hit, mcp: mcpStatus,
    calls: calls.length, lookups, wrong: calls.filter((c) => c.tool !== "iris_help" && !matches(c, task.accept)).length,
    tools: calls.map((c) => `${c.tool}${c.input.command ? `:${String(c.input.command).slice(0, 60)}` : c.input.action ? `:${c.input.action}` : ""}`),
    dry_run_recorded: dryRun.length,
    turns: result?.num_turns ?? null, cost_usd: result?.total_cost_usd ?? null,
    input_tokens: result?.usage?.input_tokens ?? null, output_tokens: result?.usage?.output_tokens ?? null,
    cache_read_tokens: result?.usage?.cache_read_input_tokens ?? null,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    error: result ? (result.is_error ? String(result.result ?? result.subtype).slice(0, 200) : null) : `no result — ${stderr.slice(0, 200)}`,
  }
}

if (import.meta.main) {
  const runs: Awaited<ReturnType<typeof runOnce>>[] = []
  for (const task of chosen)
    for (let n = 1; n <= repeats; n++) {
      const r = await runOnce(task, n)
      runs.push(r)
      console.log(`${r.pass ? "PASS" : "FAIL"} ${task.id} #${n}  [${r.mcp}] calls=${r.calls} wrong=${r.wrong} dry=${r.dry_run_recorded} ${r.seconds}s $${r.cost_usd ?? "?"}  ${r.tools.join(" → ")}${r.error ? `  ERROR ${r.error}` : ""}`)
    }
  const sum = (k: string) => runs.reduce((s, r: any) => s + (Number(r[k]) || 0), 0)
  const summary = {
    label, model, repeats, tasks: chosen.length, runs: runs.length,
    pass_rate: runs.filter((r) => r.pass).length / runs.length,
    per_task: Object.fromEntries(chosen.map((t) => [t.id, runs.filter((r) => r.task === t.id && r.pass).length + "/" + repeats])),
    mean_calls: sum("calls") / runs.length, mean_wrong: sum("wrong") / runs.length, mean_seconds: sum("seconds") / runs.length,
    total_cost_usd: Math.round(sum("cost_usd") * 100) / 100,
  }
  mkdirSync(join(HERE, "results"), { recursive: true })
  const file = join(HERE, "results", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(file, JSON.stringify({ summary, runs }, null, 2))
  console.log("\n" + JSON.stringify(summary, null, 2) + `\nreport: ${file}`)
}
