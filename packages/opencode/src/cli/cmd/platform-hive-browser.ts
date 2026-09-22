/**
 * `iris hive browser` — render-verify a page, on this machine or another one.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 *
 * The capability was already built three times and had no verb. To render-check a page you
 * had to know that `~/.iris/bridge/scripts/browser-use/render-check.sh` exists, or that the
 * V6 tool is `hiveBrowserUse → render_check`, or that the task type is `browser_use` and its
 * config wants `{ function: "render_check" }`. Three surfaces, one capability, nothing in
 * `iris hive --help` — so the honest answer to "how do I check a page renders" was a file
 * path.
 *
 * Measured 2026-09-21: calling that script by absolute path returned
 * `{"ok": false, "measured": false, "error": "browser-use not installed"}` — and exited 0.
 * A check that cannot run must not look like a check that passed, and the thing that tells
 * you how to fix it should be the same thing you just ran. Hence `doctor`.
 *
 * ── THE DISTINCTION THIS VERB KEEPS ─────────────────────────────────────────────────────
 *
 * Three states, never two. The underlying script is careful about this and the verb must not
 * flatten it:
 *
 *   exit 0   rendered, nothing wrong
 *   exit 1   rendered, and here is what is wrong
 *   exit 2   COULD NOT MEASURE — no Chrome, no browser-use, page never loaded
 *
 * Exit 2 is not a pass. It is the answer "I do not know", and a CI step that treats it as
 * success is measuring nothing while reporting green.
 */

import * as prompts from "@clack/prompts"
import { cmd } from "./cmd"
import { requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { buildTaskPayload } from "./hive-task-create"
import { hiveFetch, resolveNode } from "./platform-hive-nodes"

const SCRIPT = `${process.env.HOME}/.iris/bridge/scripts/browser-use/render-check.sh`
const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const TERMINAL = new Set(["completed", "failed", "cancelled", "timeout"])

type RenderResult = {
  ok?: boolean
  measured?: boolean
  error?: string
  failures?: string[]
  screenshots?: { filename?: string; url?: string }[]
  [k: string]: unknown
}

function have(bin: string): string | null {
  try {
    return Bun.which(bin)
  } catch {
    return null
  }
}

/** The local toolchain, each part reported by looking for it rather than assuming. */
function localToolchain() {
  return {
    script: Bun.file(SCRIPT).size > 0 ? SCRIPT : null,
    chrome: Bun.file(CHROME_MAC).size > 0 ? CHROME_MAC : have("google-chrome") ?? have("chromium"),
    browserUse: have("browser-use"),
    uv: have("uv"),
  }
}

function printResult(r: RenderResult, url: string) {
  if (r.measured === false) {
    prompts.log.error(`Could not measure ${url}`)
    console.log(dim(`  ${r.error ?? "no reason given"}`))
    console.log(dim("  This is not a pass. Fix the toolchain:  iris hive browser doctor"))
    return
  }
  const failures = r.failures ?? []
  if (failures.length === 0) {
    console.log(`${success("✓")} ${bold(url)} rendered, no failures`)
  } else {
    prompts.log.warn(`${failures.length} failure(s) on ${url}`)
    for (const f of failures) console.log(`  ${dim("·")} ${f}`)
  }
  for (const s of r.screenshots ?? []) {
    if (s.url || s.filename) console.log(dim(`  shot: ${s.url ?? s.filename}`))
  }
}

const CheckCommand = cmd({
  command: "check <url>",
  describe: "render-verify a page in a throwaway headless Chrome — here, or on one of your machines",
  builder: (y: any) =>
    y
      .positional("url", { type: "string", describe: "the http(s) page to check" })
      .option("node", { type: "string", describe: "run it on this machine instead of here (needs the browser_use capability)" })
      .option("viewports", { type: "string", describe: "e.g. desktop:1280x900,mobile:390x844 (max 4)" })
      .option("schemes", { type: "string", describe: "light, dark, or light,dark — emulates the OS preference" })
      .option("out", { type: "string", describe: "(local only) directory for screenshots" })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" }),
  async handler(args: any) {
    const url = String(args.url ?? "")
    if (!/^https?:\/\//.test(url)) {
      prompts.log.error(`A url must be http(s) — got "${url}"`)
      process.exit(2)
    }

    if (args.node) return checkOnNode(args, url)

    const tools = localToolchain()
    if (!tools.script || !tools.browserUse) {
      // Exit 2, deliberately: nothing was measured. The missing piece is named, with its fix.
      const missing = [!tools.script && "the render-check script", !tools.browserUse && "browser-use"].filter(Boolean)
      if (args.json) {
        await writeJson({ ok: false, measured: false, error: `missing: ${missing.join(", ")}`, url })
      } else {
        prompts.log.error(`Cannot measure — missing ${missing.join(" and ")}.`)
        console.log(dim("  iris hive browser doctor    # what is missing, and the command that fixes it"))
      }
      process.exit(2)
    }

    const argv = [tools.script!, url]
    if (args.out) argv.push("--out", String(args.out))
    if (args.viewports) argv.push("--viewports", String(args.viewports))
    if (args.schemes) argv.push("--schemes", String(args.schemes))

    const proc = Bun.spawn(["bash", ...argv], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited

    let parsed: RenderResult | null = null
    try {
      parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "")
    } catch {
      /* the script prints one JSON object; if it did not, say so rather than guess */
    }

    if (args.json) {
      await writeJson(parsed ?? { ok: false, measured: false, error: stderr.trim() || `exit ${code}`, url })
      process.exitCode = code
      return
    }

    if (!parsed) {
      prompts.log.error(`The check produced no readable result (exit ${code}).`)
      if (stderr.trim()) console.log(dim(`  ${stderr.trim().split("\n").slice(-3).join("\n  ")}`))
      process.exit(2)
    }

    printResult(parsed, url)
    console.log(dim("\n  Point 10 of the design audit is a LOOK, not an exit code — open the screenshots."))
    process.exitCode = code
  },
})

/**
 * Run it on another machine, through the same `browser_use` task type the agents use.
 *
 * Deliberately routed with `--requires browser_use` rather than pinned blindly: a machine
 * without Chrome accepts a shell task happily and returns a clean empty answer, which is the
 * failure this capability gate exists to prevent.
 */
async function checkOnNode(args: any, url: string) {
  const userId = await requireUserId(args["user-id"] as number | undefined)
  if (!userId) process.exit(1)

  const node = await resolveNode(userId, String(args.node))
  if (!node) {
    prompts.log.error(`No machine matching "${args.node}" — see: iris hive nodes list`)
    process.exit(1)
  }

  const config: Record<string, unknown> = { function: "render_check", url }
  if (args.viewports) config.viewports = String(args.viewports)
  if (args.schemes) config.schemes = String(args.schemes)

  const payload = buildTaskPayload({
    userId,
    type: "browser_use",
    nodeId: node.id,
    config,
    title: `render check ${url}`,
    requiredCapabilities: ["browser_use"],
  })

  const res = await hiveFetch("/api/v6/nodes/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    prompts.log.error(`Could not create the task: HTTP ${res.status}`)
    process.exit(2)
  }
  const created = (await res.json()) as { task: { id: string; status: string } }
  const taskId = created.task.id
  if (!args.json) console.log(`${dim("→")} render check on ${bold(node.name)}  task ${taskId.slice(0, 8)}`)

  const deadline = Date.now() + 330_000
  let final: Record<string, unknown> | null = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const poll = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
    if (!poll.ok) continue
    const body = (await poll.json()) as { task: Record<string, unknown> }
    if (TERMINAL.has(String(body.task.status ?? ""))) {
      final = body.task
      break
    }
  }

  if (!final) {
    prompts.log.error(`No answer in time. The task is still there:  iris hive tasks get ${taskId}`)
    process.exit(2)
  }

  const result = ((final.result as Record<string, unknown>) ?? {}) as RenderResult
  const data = ((result.data as RenderResult) ?? result) as RenderResult
  if (args.json) {
    await writeJson(data)
    process.exitCode = data.measured === false ? 2 : data.failures?.length ? 1 : 0
    return
  }
  printResult(data, url)
  process.exitCode = data.measured === false ? 2 : data.failures?.length ? 1 : 0
}

const DoctorCommand = cmd({
  command: "doctor",
  describe: "can this machine render-check a page — and if not, the command that fixes it",
  builder: (y: any) => y.option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const t = localToolchain()
    const rows = [
      { name: "render-check script", got: t.script, fix: "install the IRIS bridge (iris-daemon) — it ships the script" },
      { name: "Chrome", got: t.chrome, fix: "install Google Chrome" },
      { name: "browser-use", got: t.browserUse, fix: t.uv ? "uv tool install browser-use" : "brew install uv && uv tool install browser-use" },
    ]
    const missing = rows.filter((r) => !r.got)

    if (args.json) {
      await writeJson({ ready: missing.length === 0, checks: rows.map((r) => ({ name: r.name, present: Boolean(r.got), path: r.got, fix: r.got ? null : r.fix })) })
      process.exitCode = missing.length ? 1 : 0
      return
    }

    for (const r of rows) {
      if (r.got) console.log(`  ${success("✓")} ${r.name.padEnd(22)} ${dim(String(r.got))}`)
      else console.log(`  ${bold("✗")} ${r.name.padEnd(22)} ${dim(r.fix)}`)
    }
    console.log()
    if (missing.length) {
      prompts.log.warn("This machine cannot render-check a page yet — a check here would exit 2, not fail.")
    } else {
      console.log(`${success("✓")} ready — try:  iris hive browser check https://example.com`)
    }
    process.exitCode = missing.length ? 1 : 0
  },
})

export const HiveBrowserCommand = cmd({
  command: "browser <subcommand>",
  describe: "render-verify a page in a real browser — here, or on one of your machines",
  builder: (y: any) => y.command(CheckCommand).command(DoctorCommand).demandCommand(1, "Pick one: check, doctor"),
  async handler() {},
})
