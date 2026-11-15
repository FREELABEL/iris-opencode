#!/usr/bin/env bun
/**
 * Browser-agent model bench (#193444): which model makes the browser agent finish booking-style
 * tasks most reliably, with the fewest steps, tokens and loops.
 *
 *   bun script/bench-browser/run.ts --models iris/iris-ai,iris/qwen3.8-flash --repeats 1
 *   bun script/bench-browser/run.ts --report bench-out/<dir>/runs.jsonl     # table only
 *
 * Each (model, task, repeat) is one headless `opencode run --format json` in an empty directory,
 * against a fresh fixture server (fixtures.ts). Success comes from the server's request log, not
 * from the model's words. Runs spend the IRIS allowance: a quota/auth error stops the whole bench
 * instead of retrying.
 *
 * The agent's Chrome reaches the fixtures as http://<task>.bench.test:<port>/ through
 * --host-resolver-rules in a wrapper around IRIS_BROWSER_CHROME. The tool's private-address
 * refusal is left exactly as it ships.
 *
 * Pay/book: in headless `run` the browser tool has no person to ask (target agent; the `question`
 * tool is denied by run; permission prompts are auto-rejected). A click with confirm: true goes
 * through. So the bench counts STOPPING before the forbidden POST as correct, and any hit on it
 * as a failure — nothing ever auto-approves a pay click.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TASKS, judge, serve, type Task } from "./fixtures"

const argv = process.argv.slice(2)
const arg = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}

const ENGINE = path.resolve(import.meta.dir, "../../src/index.ts")
const PKG = path.resolve(import.meta.dir, "../..")

type Run = {
  model: string
  task: string
  repeat: number
  success: boolean
  forbidden: boolean
  reason: string
  steps: number
  tool_calls: Record<string, number>
  tool_errors: number
  loops_tool: number
  loops_repeat: number
  wall_s: number
  timed_out: boolean
  exit: number | null
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number; total: number }
  cost: number
  model_steps: number
  error?: string
  final_text: string
  pages: string[]
}

const QUOTA = /quota|allowance|insufficient|credit|billing|payment required|\b402\b|\b401\b|unauthori[sz]ed|forbidden|rate.?limit|\b429\b|exceeded|api key/i

function chromeWrapper(dir: string, port: number) {
  const real = process.env["IRIS_BROWSER_CHROME"]
  if (!real) throw new Error("set IRIS_BROWSER_CHROME (on the hub: ~/tools/chrome-nosandbox.sh)")
  const file = path.join(dir, "chrome.sh")
  fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(real)} "--host-resolver-rules=MAP *.bench.test 127.0.0.1" "$@"\n`, { mode: 0o755 })
  void port
  return file
}

async function runOne(model: string, task: Task, repeat: number, timeoutS: number, outDir: string): Promise<Run> {
  const srv = serve()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`))
  const work = path.join(tmp, "work")
  fs.mkdirSync(work)
  const url = srv.url(task)
  const prompt = task.prompt.replaceAll("{url}", url)
  const started = Date.now()
  const env = { ...process.env, IRIS_BROWSER_CHROME: chromeWrapper(tmp, srv.port), IRIS_BROWSER_PROFILE_DIR: path.join(tmp, "profile") }
  const child = spawn("bun", ["run", "--conditions=browser", ENGINE, "run", "--model", model, "--format", "json", "--dir", work, prompt], {
    cwd: PKG,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const tag = `${model.replace(/\W+/g, "_")}.${task.id}.${repeat}`
  const rawOut = fs.createWriteStream(path.join(outDir, "raw", `${tag}.jsonl`))
  const rawErr = fs.createWriteStream(path.join(outDir, "raw", `${tag}.stderr`))
  let buf = ""
  const events: any[] = []
  child.stdout.on("data", (d) => {
    rawOut.write(d)
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        events.push(JSON.parse(line))
      } catch {}
    }
  })
  let stderr = ""
  child.stderr.on("data", (d) => {
    rawErr.write(d)
    stderr = (stderr + d).slice(-4000)
  })
  let timedOut = false
  const killTree = () => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
  }
  const timer = setTimeout(() => {
    timedOut = true
    killTree()
  }, timeoutS * 1000)
  const exit: number | null = await new Promise((res) => child.on("exit", (code) => res(code)))
  clearTimeout(timer)
  killTree() // the engine's Chrome, if it outlived the engine
  rawOut.end()
  rawErr.end()
  await Bun.sleep(300)

  const hits = srv.hits(task)
  srv.stop()
  const verdict = judge(task, hits)

  const tools = events.filter((e) => e.type === "tool_use").map((e) => e.part)
  const browser = tools.filter((p) => p.tool === "browser")
  const tool_calls: Record<string, number> = {}
  for (const p of tools) tool_calls[p.tool] = (tool_calls[p.tool] ?? 0) + 1
  const loops_tool = browser.filter((p) => String(p.state?.output ?? "").startsWith("LOOP:") || p.state?.metadata?.loop).length
  // 3+ identical consecutive (action, ref, text) calls, counted once per streak
  let loops_repeat = 0
  let streak = 0
  let prev = ""
  for (const p of browser) {
    const i = p.state?.input ?? {}
    const sig = `${i.action}|${i.ref ?? ""}|${i.text ?? ""}|${i.key ?? ""}|${i.direction ?? ""}|${i.url ?? ""}`
    streak = sig === prev ? streak + 1 : 1
    prev = sig
    if (streak === 3) loops_repeat++
  }
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 }
  let cost = 0
  const finishes = events.filter((e) => e.type === "step_finish").map((e) => e.part)
  for (const f of finishes) {
    const t = f.tokens ?? {}
    tokens.input += t.input ?? 0
    tokens.output += t.output ?? 0
    tokens.reasoning += t.reasoning ?? 0
    tokens.cache_read += t.cache?.read ?? 0
    tokens.cache_write += t.cache?.write ?? 0
    cost += f.cost ?? 0
  }
  tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cache_read + tokens.cache_write
  const errs = events.filter((e) => e.type === "error").map((e) => JSON.stringify(e.error?.data?.message ?? e.error))
  const texts = events.filter((e) => e.type === "text").map((e) => String(e.part?.text ?? ""))
  fs.rmSync(tmp, { recursive: true, force: true })
  return {
    model,
    task: task.id,
    repeat,
    ...verdict,
    steps: browser.length,
    tool_calls,
    tool_errors: tools.filter((p) => p.state?.status === "error").length,
    loops_tool,
    loops_repeat,
    wall_s: Math.round((Date.now() - started) / 100) / 10,
    timed_out: timedOut,
    exit,
    tokens,
    cost,
    model_steps: finishes.length,
    error: errs.length ? errs.join(" | ").slice(0, 600) : !events.length && exit ? stderr.slice(-600) : undefined,
    final_text: (texts.at(-1) ?? "").slice(0, 600),
    pages: hits.map((h) => `${h.method} ${h.path}`),
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function report(runs: Run[]): string {
  const models = [...new Set(runs.map((r) => r.model))]
  const lines = [
    "| model | runs | success | median steps | median tokens | median wall s | loops (LOOP: / 3x same) | forbidden hits | timeouts | cost |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ]
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m)
    const ok = rs.filter((r) => r.success).length
    lines.push(
      `| ${m} | ${rs.length} | ${ok}/${rs.length} (${Math.round((100 * ok) / rs.length)}%) | ${median(rs.map((r) => r.steps))} | ${k(median(rs.map((r) => r.tokens.total)))} | ${median(rs.map((r) => r.wall_s))} | ${rs.reduce((a, r) => a + r.loops_tool, 0)} / ${rs.reduce((a, r) => a + r.loops_repeat, 0)} | ${rs.filter((r) => r.forbidden).length} | ${rs.filter((r) => r.timed_out).length} | ${rs.reduce((a, r) => a + r.cost, 0).toFixed(4)} |`,
    )
  }
  lines.push("", "| model | task | rep | ok | steps | tokens (in/out/cache-r) | wall s | loops | why |", "|---|---|---|---|---|---|---|---|---|")
  for (const r of runs) {
    lines.push(
      `| ${r.model} | ${r.task} | ${r.repeat} | ${r.success ? "yes" : r.forbidden ? "FORBIDDEN" : "no"} | ${r.steps} | ${k(r.tokens.total)} (${k(r.tokens.input)}/${k(r.tokens.output)}/${k(r.tokens.cache_read)}) | ${r.wall_s}${r.timed_out ? " (timeout)" : ""} | ${r.loops_tool}/${r.loops_repeat} | ${(r.error ? `ERROR: ${r.error} — ` : "") + r.reason} |`.replace(/\n/g, " "),
    )
  }
  return lines.join("\n") + "\n"
}

if (import.meta.main) {
  const only = arg("report")
  if (only) {
    const runs = fs.readFileSync(only, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Run)
    process.stdout.write(report(runs))
    process.exit(0)
  }
  const models = (arg("models", "iris/iris-ai,iris/qwen3.8-flash") ?? "").split(",").filter(Boolean)
  const taskIds = arg("tasks", "all")!
  const tasks = taskIds === "all" ? TASKS : TASKS.filter((t) => taskIds.split(",").some((x) => t.id.startsWith(x)))
  const repeats = Number(arg("repeats", "1"))
  const timeoutS = Number(arg("timeout", "360"))
  const outDir = path.resolve(arg("out", path.join(PKG, "bench-out", new Date().toISOString().replace(/[:.]/g, "-")))!)
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true })
  const jsonl = path.join(outDir, "runs.jsonl")
  const runs: Run[] = []
  console.error(`bench: ${models.length} models × ${tasks.length} tasks × ${repeats} → ${outDir}`)
  outer: for (let rep = 1; rep <= repeats; rep++)
    for (const model of models)
      for (const task of tasks) {
        const r = await runOne(model, task, rep, timeoutS, outDir)
        runs.push(r)
        fs.appendFileSync(jsonl, JSON.stringify(r) + "\n")
        console.error(
          `${r.success ? "PASS" : r.forbidden ? "FORBIDDEN" : "FAIL"} ${model} ${task.id} #${rep} steps=${r.steps} tokens=${r.tokens.total} wall=${r.wall_s}s ${r.error ? "error=" + r.error.slice(0, 200) : ""} — ${r.reason}`,
        )
        if (r.error && QUOTA.test(r.error) && r.model_steps === 0) {
          console.error(`bench: stopping — looks like an allowance/auth error, not retrying:\n${r.error}`)
          break outer
        }
      }
  fs.writeFileSync(path.join(outDir, "results.md"), report(runs))
  process.stdout.write(report(runs))
}
