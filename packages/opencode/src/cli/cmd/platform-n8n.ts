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

      spinner.start(`Validating ${basename(filepath)}…`)

      const workflow = JSON.parse(readFileSync(filepath, "utf-8"))

      // Validate before pushing — prevent corruption
      const issues = validateWorkflowNodes(workflow.nodes ?? [])
      const errors = issues.filter((i: ValidationIssue) => i.severity === "error")
      if (errors.length > 0) {
        spinner.stop("Validation failed", 1)
        for (const issue of errors) {
          prompts.log.error(`${bold(issue.node)}.${issue.field}: ${issue.message}`)
        }
        prompts.log.error("Fix these issues before pushing. Use the n8n UI for complex edits.")
        prompts.outro("Aborted")
        return
      }

      spinner.message(`Pushing ${basename(filepath)}…`)

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

    const IRIS_API_URL = process.env.IRIS_API_URL ?? "https://freelabel.net"
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
// Validate — check workflow JSON can load without crashing n8n
// ============================================================================

const SAFE_NODE_KEYS = new Set([
  "id", "name", "type", "typeVersion", "position", "parameters", "disabled",
  "onError", "notes", "notesInFlow", "credentials", "webhookId", "continueOnFail",
  "retryOnFail", "maxTries", "waitBetweenTries", "alwaysOutputData", "executeOnce",
  "extendsCredential", "color",
])

interface ValidationIssue {
  node: string
  field: string
  message: string
  severity: "error" | "warning"
}

function validateWorkflowNodes(nodes: any[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const node of nodes) {
    const name = node.name ?? "unknown"

    // Check for unknown top-level keys
    for (const key of Object.keys(node)) {
      if (!SAFE_NODE_KEYS.has(key)) {
        issues.push({ node: name, field: key, message: `Unknown top-level property "${key}"`, severity: "warning" })
      }
    }

    // Check null values on numeric fields (n8n crashes on these)
    if ("waitBetweenTries" in node && node.waitBetweenTries === null) {
      issues.push({ node: name, field: "waitBetweenTries", message: "null value (n8n expects number or omitted)", severity: "error" })
    }
    if ("maxTries" in node && node.maxTries === null) {
      issues.push({ node: name, field: "maxTries", message: "null value (n8n expects number or omitted)", severity: "error" })
    }

    // Check parameters
    const params = node.parameters ?? {}

    // headerParameters/bodyParameters should be objects with .parameters array
    for (const arrayField of ["headerParameters", "bodyParameters", "queryParameters"]) {
      const val = params[arrayField]
      if (val !== undefined) {
        if (typeof val === "boolean" || typeof val === "string") {
          issues.push({ node: name, field: `parameters.${arrayField}`, message: `Should be object with .parameters array, got ${typeof val}`, severity: "error" })
        } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          const inner = val.parameters
          if (inner !== undefined && !Array.isArray(inner)) {
            issues.push({ node: name, field: `parameters.${arrayField}.parameters`, message: `Should be array, got ${typeof inner}`, severity: "error" })
          }
        }
      }
    }

    // Check for duplicate parameter names in body/header params
    for (const arrayField of ["headerParameters", "bodyParameters"]) {
      const val = params[arrayField]
      if (val?.parameters && Array.isArray(val.parameters)) {
        const names = val.parameters.map((p: any) => p.name).filter(Boolean)
        const dupes = names.filter((n: string, i: number) => names.indexOf(n) !== i)
        if (dupes.length > 0) {
          issues.push({ node: name, field: `parameters.${arrayField}`, message: `Duplicate parameter names: ${[...new Set(dupes)].join(", ")}`, severity: "warning" })
        }
      }
    }
  }

  return issues
}

const N8nValidateCommand = cmd({
  command: "validate [id]",
  describe: "validate workflow JSON — catch corruption before it breaks n8n",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID (validates live) or omit to validate local file", type: "string" })
      .option("file", { alias: "f", describe: "local JSON file to validate", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Validate Workflow")

    const spinner = prompts.spinner()
    let nodes: any[]
    let source: string

    try {
      if (args.id) {
        // Validate live workflow
        spinner.start("Fetching live workflow…")
        const res = await n8nFetch(`/workflows/${args.id}`)
        if (!res.ok) {
          spinner.stop("Failed", 1)
          prompts.log.error(`HTTP ${res.status}`)
          prompts.outro("Done")
          return
        }
        const wf = (await res.json()) as any
        nodes = wf.nodes ?? []
        source = `live n8n (${args.id})`
      } else {
        // Validate local file
        const dir = resolveWorkflowsDir()
        let filepath = args.file
        if (!filepath) {
          const files = existsSync(dir)
            ? require("fs").readdirSync(dir).filter((f: string) => f.endsWith(".json"))
            : []
          if (files.length === 0) {
            spinner.start("")
            spinner.stop("No files", 1)
            prompts.log.error(`No .json files in ${dir}`)
            prompts.outro("Done")
            return
          }
          filepath = join(dir, files[0])
        }
        spinner.start(`Validating ${basename(filepath!)}…`)
        const wf = JSON.parse(readFileSync(filepath!, "utf-8"))
        nodes = wf.nodes ?? []
        source = filepath!
      }

      const issues = validateWorkflowNodes(nodes)
      const errors = issues.filter(i => i.severity === "error")
      const warnings = issues.filter(i => i.severity === "warning")

      if (issues.length === 0) {
        spinner.stop(`${success("✓")} Valid — ${nodes.length} nodes, 0 issues`)
      } else {
        spinner.stop(`${errors.length} errors, ${warnings.length} warnings`)
      }

      printDivider()
      printKV("Source", source)
      printKV("Nodes", nodes.length)

      for (const issue of errors) {
        prompts.log.error(`${bold(issue.node)}.${issue.field}: ${issue.message}`)
      }
      for (const issue of warnings) {
        prompts.log.warn(`${bold(issue.node)}.${issue.field}: ${issue.message}`)
      }

      if (errors.length > 0) {
        printDivider()
        prompts.log.error("DO NOT push this workflow — it will break n8n's UI")
        process.exitCode = 1
      } else {
        printDivider()
        prompts.log.info(dim("Safe to push"))
      }

      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Patch — safe, targeted field updates with validation
// ============================================================================

const SAFE_PATCH_FIELDS = new Set([
  "onError", "disabled", "retryOnFail", "maxTries", "waitBetweenTries",
  "parameters.url", "parameters.method",
])

const N8nPatchCommand = cmd({
  command: "patch <id> <node-name> <field> <value>",
  describe: "safely update a single field on a workflow node",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "string", demandOption: true })
      .positional("node-name", { describe: "node name (exact match)", type: "string", demandOption: true })
      .positional("field", { describe: "field to update", type: "string", demandOption: true })
      .positional("value", { describe: "new value", type: "string", demandOption: true })
      .example("iris n8n patch IeiQ... 'Buffer Twitter Post' onError continueRegularOutput", "")
      .example("iris n8n patch IeiQ... 'START CREATE CLIP' parameters.url http://api-nginx:80/api/v1/labs/queue/youtube-to-clip", "")
      .example("iris n8n patch IeiQ... 'My Node' disabled true", ""),
  async handler(args) {
    UI.empty()
    const nodeName = args["node-name"] as string
    const field = args.field as string
    const rawValue = args.value as string
    prompts.intro(`◈  Patch: ${bold(nodeName)}.${field}`)

    // Validate field is safe
    if (!SAFE_PATCH_FIELDS.has(field)) {
      prompts.log.error(`Field "${field}" is not in the safe-patch allowlist.`)
      prompts.log.info(`Allowed fields: ${[...SAFE_PATCH_FIELDS].join(", ")}`)
      prompts.log.info(dim("For complex edits, use the n8n UI then 'iris n8n pull'"))
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Fetching workflow…")

    try {
      // Fetch current workflow
      const res = await n8nFetch(`/workflows/${args.id}`)
      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const wf = (await res.json()) as any
      const nodes: any[] = wf.nodes ?? []

      // Find the node
      const node = nodes.find((n: any) => n.name === nodeName)
      if (!node) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Node "${nodeName}" not found. Available: ${nodes.map((n: any) => n.name).slice(0, 10).join(", ")}...`)
        prompts.outro("Done")
        return
      }

      // Parse value (handle booleans and numbers)
      let value: any = rawValue
      if (rawValue === "true") value = true
      else if (rawValue === "false") value = false
      else if (/^\d+$/.test(rawValue)) value = parseInt(rawValue, 10)

      // Apply the field
      const oldValue = field.startsWith("parameters.")
        ? node.parameters?.[field.replace("parameters.", "")]
        : node[field]

      if (field.startsWith("parameters.")) {
        const paramKey = field.replace("parameters.", "")
        node.parameters = node.parameters ?? {}
        node.parameters[paramKey] = value
      } else {
        node[field] = value
      }

      // Validate before pushing
      const issues = validateWorkflowNodes(nodes)
      const errors = issues.filter(i => i.severity === "error")
      if (errors.length > 0) {
        spinner.stop("Validation failed", 1)
        for (const issue of errors) {
          prompts.log.error(`${issue.node}.${issue.field}: ${issue.message}`)
        }
        prompts.outro("Aborted — would corrupt n8n")
        return
      }

      // Push the full workflow back
      spinner.message("Pushing…")
      const pushRes = await n8nFetch(`/workflows/${args.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: wf.name, nodes, connections: wf.connections, settings: wf.settings ?? {} }),
      })

      if (!pushRes.ok) {
        spinner.stop("Push failed", 1)
        let msg = `HTTP ${pushRes.status}`
        try { const b = await pushRes.json() as any; msg = b.message ?? msg } catch {}
        prompts.log.error(msg)
        prompts.outro("Done")
        return
      }

      spinner.stop(success("Patched"))

      printDivider()
      printKV("Node", nodeName)
      printKV("Field", field)
      printKV("Old", String(oldValue ?? "(not set)"))
      printKV("New", String(value))
      printDivider()

      prompts.outro(dim("iris n8n pull to sync to git"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Restore — emergency restore from git JSON to n8n DB
// ============================================================================

const N8nRestoreCommand = cmd({
  command: "restore <id>",
  describe: "emergency restore workflow from git JSON to live n8n",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "string", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" })
      .option("force", { describe: "skip confirmation", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Restore Workflow ${args.id}`)

    const spinner = prompts.spinner()

    try {
      // Find local file
      const dir = resolveWorkflowsDir()
      let filepath = args.file

      if (!filepath) {
        const files = existsSync(dir)
          ? require("fs").readdirSync(dir).filter((f: string) => f.endsWith(".json"))
          : []
        if (files.length === 0) {
          spinner.start("")
          spinner.stop("No files", 1)
          prompts.log.error(`No .json files in ${dir}`)
          prompts.outro("Done")
          return
        }
        filepath = files.length === 1 ? join(dir, files[0]) : join(dir, files[0])
      }

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        prompts.log.error(`File not found: ${filepath}`)
        prompts.outro("Done")
        return
      }

      // Read and validate
      const workflow = JSON.parse(readFileSync(filepath, "utf-8"))
      const nodes = workflow.nodes ?? []

      // Validate first
      const issues = validateWorkflowNodes(nodes)
      const errors = issues.filter(i => i.severity === "error")
      if (errors.length > 0) {
        prompts.log.error("Local file has validation errors — fix before restoring:")
        for (const issue of errors) {
          prompts.log.error(`  ${issue.node}.${issue.field}: ${issue.message}`)
        }
        prompts.outro("Aborted")
        return
      }

      // Check for redacted secrets
      const content = readFileSync(filepath, "utf-8")
      const hasRedacted = content.includes("REDACTED_TOKEN") || content.includes("WEBHOOK_PLACEHOLDER")
      if (hasRedacted) {
        prompts.log.warn("File contains redacted secrets (REDACTED_TOKEN / WEBHOOK_PLACEHOLDER)")
        prompts.log.warn("Credentials will be overwritten with placeholders!")

        if (!args.force) {
          const confirm = await prompts.confirm({ message: "Continue anyway? Credentials in affected nodes will break." })
          if (prompts.isCancel(confirm) || !confirm) {
            prompts.outro("Cancelled")
            return
          }
        }
      } else if (!args.force) {
        const confirm = await prompts.confirm({
          message: `Restore ${nodes.length} nodes from ${basename(filepath)} to live n8n? This overwrites the current workflow.`,
        })
        if (prompts.isCancel(confirm) || !confirm) {
          prompts.outro("Cancelled")
          return
        }
      }

      spinner.start(`Restoring from ${basename(filepath)}…`)

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
        spinner.stop("API restore failed — trying direct DB…", 1)

        // Fallback: write directly to postgres via docker exec
        prompts.log.warn("Attempting direct DB restore (docker exec)…")

        const nodesJson = JSON.stringify(workflow.nodes)
        const connsJson = JSON.stringify(workflow.connections)

        const { execSync } = require("child_process")
        try {
          // Write JSON to temp files inside the postgres container
          const escapedNodes = nodesJson.replace(/'/g, "''")
          const escapedConns = connsJson.replace(/'/g, "''")

          execSync(
            `docker exec fl-n8n-postgres psql -U n8n -d n8n -c "UPDATE workflow_entity SET nodes = '${escapedNodes}'::jsonb, connections = '${escapedConns}'::jsonb WHERE id = '${args.id}';"`,
            { stdio: "pipe", timeout: 10000 }
          )

          prompts.log.info(success("Direct DB restore successful"))
          prompts.log.warn("Restart n8n container: docker restart fl-n8n")
        } catch (dbErr) {
          prompts.log.error(`DB restore also failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`)
          prompts.outro("Failed")
          return
        }
      } else {
        spinner.stop(success("Restored"))
      }

      printDivider()
      printKV("Workflow", workflow.name)
      printKV("ID", args.id)
      printKV("Nodes", nodes.length)
      printKV("From", filepath)
      if (hasRedacted) printKV("Warning", "Contains redacted secrets")
      printDivider()

      prompts.outro(dim("Verify in n8n UI: http://localhost:5678/workflow/" + args.id))
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
  describe: "manage n8n workflows — pull, push, diff, validate, patch, restore",
  builder: (yargs) =>
    yargs
      .command(N8nListCommand)
      .command(N8nPullCommand)
      .command(N8nPushCommand)
      .command(N8nDiffCommand)
      .command(N8nActivateCommand)
      .command(N8nDeactivateCommand)
      .command(N8nDispatchCommand)
      .command(N8nValidateCommand)
      .command(N8nPatchCommand)
      .command(N8nRestoreCommand)
      .demandCommand(),
  async handler() {},
})
