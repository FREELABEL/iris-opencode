import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success } from "./iris-api"
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

// ============================================================================
// Root
// ============================================================================

export const PlatformScriptsCommand = cmd({
  command: "scripts",
  describe: "account-scoped, slug-addressed scripts that run on your Hive fleet",
  builder: (y) => y.command(ListCmd).command(PushCmd).command(PullCmd).command(RmCmd).demandCommand(),
  async handler() {},
})
