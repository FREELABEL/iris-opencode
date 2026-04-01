import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { requireAuth, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Config
// ============================================================================

const N8N_API_URL = process.env.IRIS_N8N_API_URL ?? "http://localhost:5678"
const N8N_API_KEY = process.env.IRIS_N8N_API_KEY ?? process.env.N8N_API_KEY ?? ""

const WORKFLOWS_DIR = "fl-docker-dev/n8n/workflows"

function resolveWorkflowsDir(): string {
  // Walk up from cwd to find the freelabel root (has fl-docker-dev/)
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, WORKFLOWS_DIR)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), WORKFLOWS_DIR)
}

// ============================================================================
// n8n fetch helper
// ============================================================================

async function n8nFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (!N8N_API_KEY) {
    throw new Error("n8n API key not set. Set IRIS_N8N_API_KEY or N8N_API_KEY env var.")
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-N8N-API-KEY": N8N_API_KEY,
    ...(options.headers as Record<string, string>),
  }
  return fetch(`${N8N_API_URL}/api/v1${path}`, { ...options, headers })
}

// ============================================================================
// Display helpers
// ============================================================================

function statusBadge(active: boolean): string {
  return active
    ? `${UI.Style.TEXT_SUCCESS}active${UI.Style.TEXT_NORMAL}`
    : `${UI.Style.TEXT_DIM}inactive${UI.Style.TEXT_NORMAL}`
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

// ============================================================================
// Subcommands
// ============================================================================

const N8nListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all n8n workflows",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  n8n Workflows")

    const spinner = prompts.spinner()
    spinner.start("Fetching workflows…")

    try {
      const res = await n8nFetch("/workflows")
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const raw = (await res.json()) as { data?: any[] }
      const workflows: any[] = raw?.data ?? []
      spinner.stop(`${workflows.length} workflow(s)`)

      if (workflows.length === 0) {
        prompts.log.warn("No workflows found")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const w of workflows) {
        const name = bold(String(w.name))
        const id = dim(w.id)
        const status = statusBadge(w.active)
        const nodes = w.nodeCount ? dim(`${w.nodeCount} nodes`) : ""
        const archived = w.isArchived ? `  ${dim("[archived]")}` : ""
        console.log(`  ${name}  ${id}  ${status}  ${nodes}${archived}`)
      }
      printDivider()

      prompts.outro(dim("iris n8n pull <id>  |  iris n8n push <id>  |  iris n8n diff <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const N8nPullCommand = cmd({
  command: "pull <id>",
  describe: "download workflow JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "string", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Workflow ${args.id}`)

    const spinner = prompts.spinner()
    spinner.start("Fetching workflow…")

    try {
      const res = await n8nFetch(`/workflows/${args.id}`)
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const workflow = (await res.json()) as Record<string, unknown>
      const name = String(workflow.name ?? args.id)
      const nodeCount = (workflow.nodes as any[])?.length ?? 0

      // Determine output path
      const dir = resolveWorkflowsDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? `${slugify(name)}.json`
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(workflow, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Workflow", name)
      printKV("ID", args.id)
      printKV("Nodes", nodeCount)
      printKV("Active", workflow.active)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris n8n push ${args.id}  |  iris n8n diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const N8nPushCommand = cmd({
  command: "push <id>",
  describe: "upload local workflow JSON to n8n",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "string", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Workflow ${args.id}`)

    const spinner = prompts.spinner()

    try {
      // Find local file
      const dir = resolveWorkflowsDir()
      let filepath = args.file

      if (!filepath) {
        // Auto-discover: find JSON files in workflows dir
        if (!existsSync(dir)) {
          spinner.start("")
          spinner.stop("Failed", 1)
          prompts.log.error(`Workflows directory not found: ${dir}`)
          prompts.outro("Done")
          return
        }

        const files = require("fs")
          .readdirSync(dir)
          .filter((f: string) => f.endsWith(".json") && !f.endsWith(".disabled"))

        if (files.length === 0) {
          spinner.start("")
          spinner.stop("Failed", 1)
          prompts.log.error(`No .json files in ${dir}`)
          prompts.outro("Done")
          return
        }

        if (files.length === 1) {
          filepath = join(dir, files[0])
        } else {
          const selected = await prompts.select({
            message: "Select workflow file",
            options: files.map((f: string) => ({ value: join(dir, f), label: f })),
          })
          if (prompts.isCancel(selected)) {
            prompts.outro("Cancelled")
            return
          }
          filepath = selected as string
        }
      }

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        prompts.log.error(`File not found: ${filepath}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const workflow = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: workflow.name,
        nodes: workflow.nodes,
        connections: workflow.connections,
        settings: workflow.settings ?? {},
      }

      const res = await n8nFetch(`/workflows/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        spinner.stop("Failed", 1)
        let msg = `HTTP ${res.status}`
        try { const b = await res.json() as any; msg = b.message ?? msg } catch {}
        prompts.log.error(msg)
        prompts.outro("Done")
        return
      }

      const result = (await res.json()) as Record<string, unknown>
      const nodeCount = (result.nodes as any[])?.length ?? 0
      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Workflow", result.name)
      printKV("ID", args.id)
      printKV("Nodes", nodeCount)
      printKV("Active", result.active)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris n8n diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const N8nDiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local workflow vs live n8n instance",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "string", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Workflow ${args.id}`)

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      // Fetch live workflow
      const res = await n8nFetch(`/workflows/${args.id}`)
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const live = (await res.json()) as Record<string, any>

      // Find local file
      const dir = resolveWorkflowsDir()
      let filepath = args.file
      if (!filepath) {
        const files = existsSync(dir)
          ? require("fs").readdirSync(dir).filter((f: string) => f.endsWith(".json") && !f.endsWith(".disabled"))
          : []
        filepath = files.length === 1 ? join(dir, files[0]) : undefined
      }

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris n8n pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      // Compare
      const liveNodes = new Set((live.nodes ?? []).map((n: any) => n.name))
      const localNodes = new Set((local.nodes ?? []).map((n: any) => n.name))

      const added = [...localNodes].filter((n) => !liveNodes.has(n))
      const removed = [...liveNodes].filter((n) => !localNodes.has(n))
      const shared = [...localNodes].filter((n) => liveNodes.has(n))

      const liveCount = liveNodes.size
      const localCount = localNodes.size

      spinner.stop(added.length === 0 && removed.length === 0 ? success("In sync") : "Differences found")

      printDivider()
      printKV("Workflow", live.name ?? args.id)
      printKV("Live nodes", liveCount)
      printKV("Local nodes", localCount)
      printKV("Active (live)", live.active)
      console.log()

      if (added.length > 0) {
        console.log(`  ${UI.Style.TEXT_SUCCESS}+ Added locally (${added.length}):${UI.Style.TEXT_NORMAL}`)
        for (const n of added) console.log(`    ${UI.Style.TEXT_SUCCESS}+ ${n}${UI.Style.TEXT_NORMAL}`)
        console.log()
      }
      if (removed.length > 0) {
        console.log(`  ${UI.Style.TEXT_DANGER}- Removed locally (${removed.length}):${UI.Style.TEXT_NORMAL}`)
        for (const n of removed) console.log(`    ${UI.Style.TEXT_DANGER}- ${n}${UI.Style.TEXT_NORMAL}`)
        console.log()
      }
      if (added.length === 0 && removed.length === 0) {
        console.log(`  ${success("No node differences")}`)
        console.log()
      }

      // Check connection differences
      const liveConnKeys = Object.keys(live.connections ?? {}).sort()
      const localConnKeys = Object.keys(local.connections ?? {}).sort()
      const connAdded = localConnKeys.filter((k) => !liveConnKeys.includes(k))
      const connRemoved = liveConnKeys.filter((k) => !localConnKeys.includes(k))

      if (connAdded.length > 0 || connRemoved.length > 0) {
        console.log(`  ${dim("Connection changes:")}`)
        for (const c of connAdded) console.log(`    ${UI.Style.TEXT_SUCCESS}+ ${c}${UI.Style.TEXT_NORMAL}`)
        for (const c of connRemoved) console.log(`    ${UI.Style.TEXT_DANGER}- ${c}${UI.Style.TEXT_NORMAL}`)
        console.log()
      }

      printDivider()

      if (added.length > 0 || removed.length > 0) {
        prompts.outro(dim(`iris n8n push ${args.id}  — to push local changes live`))
      } else {
        prompts.outro("Done")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const N8nActivateCommand = cmd({
  command: "activate <id>",
  describe: "activate a workflow",
  builder: (yargs) =>
    yargs.positional("id", { describe: "workflow ID", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Activate Workflow ${args.id}`)

    const spinner = prompts.spinner()
    spinner.start("Activating…")

    try {
      const res = await n8nFetch(`/workflows/${args.id}/activate`, { method: "POST" })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const wf = (await res.json()) as Record<string, unknown>
      spinner.stop(success("Activated"))
      printDivider()
      printKV("Workflow", wf.name)
      printKV("Active", wf.active)
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const N8nDeactivateCommand = cmd({
  command: "deactivate <id>",
  describe: "deactivate a workflow",
  builder: (yargs) =>
    yargs.positional("id", { describe: "workflow ID", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Deactivate Workflow ${args.id}`)

    const spinner = prompts.spinner()
    spinner.start("Deactivating…")

    try {
      const res = await n8nFetch(`/workflows/${args.id}/deactivate`, { method: "POST" })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }
      const wf = (await res.json()) as Record<string, unknown>
      spinner.stop(success("Deactivated"))
      printDivider()
      printKV("Workflow", wf.name)
      printKV("Active", wf.active)
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const N8nDispatchCommand = cmd({
  command: "dispatch <campaign>",
  aliases: ["run"],
  describe: "dispatch a SOM outreach campaign via Hive",
  builder: (yargs) =>
    yargs
      .positional("campaign", {
        describe: "campaign name (courses, creators, dj)",
        type: "string",
        demandOption: true,
      })
      .option("limit", { alias: "l", describe: "lead limit", type: "number", default: 15 })
      .option("board-id", { alias: "b", describe: "board ID", type: "number", default: 38 })
      .option("node-id", { describe: "target node ID", type: "string" })
      .option("dry-run", { describe: "show payload without dispatching", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Dispatch SOM: ${args.campaign}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    // Campaign presets
    const campaigns: Record<string, { title: string; prompt: string; igAccount: string; strategy: string }> = {
      courses: {
        title: "SOM: AI Course Outreach",
        prompt: `courses limit=${args.limit} boardId=${args["board-id"]} strategy=AI Course | V3 igAccount=heyiris.io`,
        igAccount: "heyiris.io",
        strategy: "AI Course | V3",
      },
      creators: {
        title: "SOM: Creator Outreach",
        prompt: `creators limit=${args.limit} boardId=${args["board-id"]} strategy=Creator Outreach | V1 igAccount=thediscoverpage_`,
        igAccount: "thediscoverpage_",
        strategy: "Creator Outreach | V1",
      },
      dj: {
        title: "SOM: DJ Outreach",
        prompt: `dj limit=${args.limit} boardId=${args["board-id"]} strategy=DJ Outreach | V1 igAccount=thebeatbox__`,
        igAccount: "thebeatbox__",
        strategy: "DJ Outreach | V1",
      },
    }

    const preset = campaigns[args.campaign.toLowerCase()]
    if (!preset) {
      prompts.log.error(`Unknown campaign: ${args.campaign}`)
      prompts.log.info(`Available: ${Object.keys(campaigns).join(", ")}`)
      prompts.outro("Done")
      return
    }

    const IRIS_API_URL = process.env.IRIS_API_URL ?? "https://fl-iris-api-v5-mnmol.ondigitalocean.app"
    const nodeId = args["node-id"] ?? process.env.IRIS_NODE_ID ?? ""

    const payload = {
      user_id: 193,
      title: preset.title,
      prompt: preset.prompt,
      type: "som",
      node_id: nodeId,
      config: {
        timeout_seconds: 1800,
        boardId: String(args["board-id"]),
        strategy: preset.strategy,
        igAccount: preset.igAccount,
        platform: "instagram",
      },
    }

    if (args["dry-run"]) {
      printDivider()
      console.log(`  ${dim("POST")} ${IRIS_API_URL}/api/v6/nodes/tasks`)
      console.log()
      console.log(JSON.stringify(payload, null, 2).split("\n").map((l) => `  ${l}`).join("\n"))
      printDivider()
      prompts.outro(dim("Dry run — no request sent"))
      return
    }

    if (!nodeId) {
      prompts.log.error("No node ID. Set IRIS_NODE_ID env or use --node-id")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Dispatching…")

    try {
      const res = await fetch(`${IRIS_API_URL}/api/v6/nodes/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        spinner.stop("Failed", 1)
        let msg = `HTTP ${res.status}`
        try { const b = await res.json() as any; msg = b.message ?? msg } catch {}
        prompts.log.error(msg)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { task?: any; dispatched?: boolean }
      const task = data.task
      spinner.stop(success("Dispatched"))

      printDivider()
      printKV("Task ID", task?.id)
      printKV("Title", task?.title)
      printKV("Type", task?.type)
      printKV("Status", task?.status)
      printKV("Node", task?.node?.name)
      printKV("Campaign", args.campaign)
      printKV("Limit", args.limit)
      printKV("Board", args["board-id"])
      printDivider()

      prompts.outro(dim("Task dispatched to Hive node"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformN8nCommand = cmd({
  command: "n8n",
  describe: "manage n8n workflows — pull, push, diff, dispatch",
  builder: (yargs) =>
    yargs
      .command(N8nListCommand)
      .command(N8nPullCommand)
      .command(N8nPushCommand)
      .command(N8nDiffCommand)
      .command(N8nActivateCommand)
      .command(N8nDeactivateCommand)
      .command(N8nDispatchCommand)
      .demandCommand(),
  async handler() {},
})
