import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success } from "./iris-api"
import { resolveNode } from "./platform-hive-nodes"
import { existsSync, writeFileSync, readFileSync } from "fs"

// User scripts live on the IRIS API (fl-iris-api), not fl-api.
const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"
function scriptsFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

function inferRuntime(file: string): string {
  if (file.endsWith(".spec.ts") || file.endsWith(".ts")) return "playwright"
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "node"
  if (file.endsWith(".py")) return "python"
  return "bash"
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your saved scripts",
  builder: (y) => y.option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch("/api/v1/scripts")
    if (!res.ok) return void (await handleApiError(res, "List scripts"))
    const json = (await res.json()) as { data?: any[] }
    const scripts = json.data ?? []
    if (args.json) return void console.log(JSON.stringify(scripts, null, 2))
    if (!scripts.length) {
      prompts.log.info("No scripts yet. Save one: iris scripts push <slug> <file>")
      return
    }
    console.log(bold("\nYour scripts"))
    for (const s of scripts) {
      console.log(`  ${bold(s.slug)}  ${dim(`[${s.runtime}]`)}${s.auto_pull ? dim("  · auto-pull") : ""}`)
      if (s.name && s.name !== s.slug) console.log(`    ${dim(s.name)}`)
    }
    console.log()
  },
})

const PushCmd = cmd({
  command: "push <slug> <file>",
  describe: "save (upsert) a script to the cloud under a slug",
  builder: (y) =>
    y
      .positional("slug", { describe: "hyphenated slug, e.g. my-inbox-scan", type: "string", demandOption: true })
      .positional("file", { describe: "path to the script file", type: "string", demandOption: true })
      .option("runtime", { describe: "bash|node|python|playwright (default: inferred from extension)", type: "string" })
      .option("name", { describe: "human-readable name", type: "string" })
      .option("auto-pull", { describe: "pre-fetch this script to every node on heartbeat", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const file = args.file as string
    if (!existsSync(file)) return void prompts.log.error(`File not found: ${file}`)
    const content = readFileSync(file, "utf8")
    const res = await scriptsFetch("/api/v1/scripts", {
      method: "POST",
      body: JSON.stringify({
        slug: args.slug,
        name: args.name,
        runtime: (args.runtime as string) ?? inferRuntime(file),
        script_content: content,
        auto_pull: args["auto-pull"],
        user_id: await requireUserId(),
      }),
    })
    if (!res.ok) return void (await handleApiError(res, "Push script"))
    const json = (await res.json()) as { data?: any }
    const created = res.status === 201
    success(`${created ? "Created" : "Updated"} ${bold(json.data?.slug ?? String(args.slug))} ${dim(`[${json.data?.runtime}]`)}`)
  },
})

const PullCmd = cmd({
  command: "pull <slug> [file]",
  describe: "download a saved script (to a file, or stdout)",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .positional("file", { describe: "write to this path (default: stdout)", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(args.slug as string)}`)
    if (res.status === 404) return void prompts.log.error(`Script '${args.slug}' not found`)
    if (!res.ok) return void (await handleApiError(res, "Pull script"))
    const json = (await res.json()) as { data?: any }
    const content = json.data?.script_content ?? ""
    if (args.file) {
      writeFileSync(args.file as string, content)
      success(`Wrote ${bold(String(args.file))}`)
    } else {
      process.stdout.write(content.endsWith("\n") ? content : content + "\n")
    }
  },
})

const RmCmd = cmd({
  command: "rm <slug>",
  aliases: ["delete"],
  describe: "delete a saved script",
  builder: (y) => y.positional("slug", { describe: "script slug", type: "string", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(args.slug as string)}`, {
      method: "DELETE",
      body: JSON.stringify({ user_id: await requireUserId() }),
    })
    if (res.status === 404) return void prompts.log.error(`Script '${args.slug}' not found`)
    if (!res.ok) return void (await handleApiError(res, "Delete script"))
    success(`Deleted ${bold(String(args.slug))}`)
  },
})

const RunCmd = cmd({
  command: "run <slug>",
  describe: "run a saved script on a Hive node (the node pulls it from the cloud if missing)",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .option("node", { describe: "node name or id to run on", type: "string", demandOption: true })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 120 })
      .option("queue", { describe: "dispatch and exit (don't wait for output)", type: "boolean", default: false })
      .option("json", { describe: "JSON output (full task)", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return

    const node = await resolveNode(userId, String(args.node))
    if (!node) return void prompts.log.error(`No node matching "${args.node}". Run: iris hive nodes list`)
    if (node.connection_status !== "online") {
      return void prompts.log.error(`Node "${node.name}" is ${node.connection_status} — cannot dispatch.`)
    }

    const timeoutSec = Math.max(30, Math.min(3600, Number(args.timeout) || 120))
    if (!args.json) console.log(`${dim("→")} dispatching ${bold(String(args.slug))} to ${bold(node.name)}`)

    const createRes = await scriptsFetch("/api/v6/nodes/tasks", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        title: `iris scripts run: ${args.slug}`,
        type: "user_script",
        node_id: node.id,
        prompt: String(args.slug), // also the slug — the daemon reads config.script_slug ?? prompt
        config: { script_slug: args.slug },
        timeout_seconds: timeoutSec,
      }),
    })
    if (!createRes.ok) return void prompts.log.error(`Dispatch failed: ${createRes.status} ${await createRes.text()}`)

    const created = (await createRes.json()) as { task: { id: string; status: string } }
    const taskId = created.task.id
    if (args.queue) return void success(`Dispatched task ${bold(taskId)}  (check: iris hive tasks --task ${taskId})`)
    if (!args.json) console.log(dim("waiting for completion…"))

    const deadline = Date.now() + (timeoutSec + 30) * 1000
    const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
    let final: any = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const r = await scriptsFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) return void prompts.log.error(`Poll failed: ${r.status}`)
      const t = ((await r.json()) as { task: any }).task
      if (terminal.has(t.status)) {
        final = t
        break
      }
    }
    if (!final) return void prompts.log.error(`Timed out waiting for task ${taskId}`)
    if (args.json) return void console.log(JSON.stringify(final, null, 2))

    const out = final.result?.output ?? final.output ?? final.result?.stdout ?? ""
    console.log()
    if (out) console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2))
    if (["succeeded", "completed"].includes(final.status)) success(`${bold(String(args.slug))} ran on ${node.name}`)
    else prompts.log.error(`Script ${final.status} on ${node.name}`)
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformScriptsCommand = cmd({
  command: "scripts",
  describe: "account-scoped, slug-addressed scripts that run on your Hive fleet",
  builder: (y) =>
    y.command(ListCmd).command(PushCmd).command(PullCmd).command(RunCmd).command(RmCmd).demandCommand(),
  async handler() {},
})
