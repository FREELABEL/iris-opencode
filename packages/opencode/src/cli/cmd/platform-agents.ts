import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { executeChat } from "./platform-chat"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/agents"

function resolveSyncDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, SYNC_DIR)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), SYNC_DIR)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function agentFilename(a: Record<string, unknown>): string {
  return `${a.id}-${slugify(String(a.name ?? "agent"))}.json`
}

function findLocalFile(dir: string, id: number): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
  return files.length > 0 ? join(dir, files[0]) : undefined
}

// ============================================================================
// Shared helpers
// ============================================================================

function printAgent(a: Record<string, unknown>): void {
  const name = bold(String(a.name ?? `Agent #${a.id}`))
  const id = dim(`#${a.id}`)
  const model = a.model ? `  ${UI.Style.TEXT_HIGHLIGHT}${a.model}${UI.Style.TEXT_NORMAL}` : ""
  console.log(`  ${name}  ${id}${model}`)
  if (a.description) {
    console.log(`    ${dim(String(a.description).slice(0, 100))}`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const AgentsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your agents",
  builder: (yargs) =>
    yargs
      .option("search", { alias: "s", describe: "search by name/description", type: "string" })
      .option("bloq", { alias: "b", describe: "filter by bloq ID", type: "number" })
      .option("active", { describe: "show only active agents", type: "boolean" })
      .option("orphaned", { describe: "show agents with no bloq", type: "boolean" })
      .option("limit", { describe: "results per page", type: "number", default: 30 })
      .option("page", { alias: "p", describe: "page number", type: "number", default: 1 })
      .option("group", { alias: "g", describe: "group by bloq", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  IRIS Agents") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading agents…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit), page: String(args.page) })
      if (args.search) params.set("search", args.search)
      if (args.bloq) params.set("bloq_id", String(args.bloq))
      if (args.active) params.set("active", "1")

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?${params}`)
      const ok = await handleApiError(res, "List agents")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); process.exitCode = 1; return }

      const raw = (await res.json()) as Record<string, any>
      let agents: any[] = raw?.data ?? []
      const total = raw?.total ?? raw?.meta?.total ?? agents.length
      const currentPage = args.page
      const lastPage = Math.ceil(total / args.limit)

      // Client-side filters (for fields the API may not support)
      if (args.orphaned) agents = agents.filter((a: any) => !a.bloq_id)
      if (args.bloq && !params.has("bloq_id")) agents = agents.filter((a: any) => a.bloq_id === args.bloq)

      if (spinner) spinner.stop(`${agents.length} agent(s)${total > agents.length ? ` (${total} total — page ${currentPage}/${lastPage})` : ""}`)

      if (args.json) {
        console.log(JSON.stringify({ agents, page: currentPage, total, last_page: lastPage }, null, 2))
        return
      }

      if (agents.length === 0) {
        prompts.log.warn("No agents found")
        prompts.outro(`Create one: ${dim("iris agents create")}`)
        return
      }

      // Show active filters
      const filters: string[] = []
      if (args.search) filters.push(`search="${args.search}"`)
      if (args.bloq) filters.push(`bloq=${args.bloq}`)
      if (args.active) filters.push("active")
      if (args.orphaned) filters.push("orphaned")
      if (filters.length > 0) console.log(`  ${dim(`Filters: ${filters.join(", ")}`)}`)

      if (args.group) {
        const groups = new Map<string, any[]>()
        for (const a of agents) {
          const key = a.bloq_id ? `Bloq #${a.bloq_id}` : "(no bloq)"
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(a)
        }
        for (const [bloqLabel, groupAgents] of groups) {
          console.log()
          console.log(`  ${bold(bloqLabel)}`)
          printDivider()
          for (const a of groupAgents) {
            printAgent(a)
          }
        }
      } else {
        printDivider()
        for (const a of agents) {
          printAgent(a)
          console.log()
        }
      }
      printDivider()

      // Pagination hints
      if (lastPage > 1) {
        const hints: string[] = []
        if (currentPage < lastPage) hints.push(dim(`iris agents list --page=${currentPage + 1} — next page`))
        if (currentPage > 1) hints.push(dim(`iris agents list --page=${currentPage - 1} — previous page`))
        hints.forEach((h) => console.log(`  ${h}`))
      }

      prompts.outro(
        `${dim("iris agents get <id>")}  ·  ${dim("iris chat --agent=<id> \"hello\"")}`,
      )
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const AgentsGetCommand = cmd({
  command: "get <id>",
  describe: "show agent details",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Agent #${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`)
      const ok = await handleApiError(res, "Get agent")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); process.exitCode = 1; return }

      const data = (await res.json()) as { data?: any }
      const a = data?.data ?? data

      if (!a || !a.id) { if (spinner) spinner.stop("Agent not found", 1); process.exitCode = 1; return }

      if (args.json) {
        console.log(JSON.stringify(a, null, 2))
        return
      }

      spinner!.stop(String(a.name ?? `Agent #${a.id}`))

      printDivider()
      printKV("ID", a.id)
      printKV("Name", a.name)
      printKV("Model", a.model ?? ((a.settings as Record<string, unknown>)?.model as string))
      printKV("Description", a.description)
      printKV("Bloq ID", a.bloq_id)
      printKV("Heartbeat", a.heartbeat_mode)
      printKV("Active", a.active)
      printKV("Created", a.created_at)
      console.log()
      printDivider()

      prompts.outro(
        `${dim("iris chat --agent=" + args.id + ' "hello"')}  Chat with this agent`,
      )
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const AgentsCreateCommand = cmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs) =>
    yargs
      .option("name", { alias: "n", describe: "agent name", type: "string" })
      .option("description", { alias: "d", describe: "agent description", type: "string" })
      .option("prompt", { alias: "p", describe: "system prompt / instructions", type: "string" })
      .option("system-prompt", { describe: "system prompt (alias of --prompt)", type: "string" })
      .option("initial-prompt", { describe: "initial prompt sent on first heartbeat", type: "string" })
      .option("model", { alias: "m", describe: "AI model (e.g. gpt-4o-mini)", type: "string" })
      .option("type", { describe: "agent type (content, chat, assistant, support)", type: "string", default: "content" })
      .option("bloq-id", { alias: "b", describe: "knowledge base bloq ID", type: "number" })
      .option("heartbeat-mode", { describe: "heartbeat mode (autonomous, briefing, disabled)", type: "string", choices: ["autonomous", "briefing", "disabled"] })
      .option("heartbeat-tools", { describe: "comma-separated tool names for heartbeat", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    // Non-interactive mode: skip prompts when --json is set OR all required params provided
    const nonInteractive = !!(args.json || (args.name && (args.prompt || args["system-prompt"])))

    if (!nonInteractive) UI.empty()
    if (!nonInteractive) prompts.intro("◈  Create Agent")

    const token = await requireAuth()
    if (!token) { if (!nonInteractive) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!nonInteractive) prompts.outro("Done"); return }

    let name = args.name
    if (!name && !nonInteractive) {
      name = (await prompts.text({
        message: "Agent name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }
    if (!name) { if (args.json) console.log(JSON.stringify({ error: "--name is required" })); else prompts.log.error("--name is required"); process.exitCode = 1; return }

    let description = args.description
    if (!description && !nonInteractive) {
      description = (await prompts.text({
        message: "Description (optional)",
        placeholder: "e.g. Helps with lead research and follow-ups",
      })) as string
      if (prompts.isCancel(description)) description = ""
    }

    let prompt = args.prompt ?? args["system-prompt"]
    if (!prompt && !nonInteractive) {
      prompt = (await prompts.text({
        message: "System prompt / instructions",
        placeholder: "e.g. You are a helpful assistant that specializes in...",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(prompt)) { prompts.outro("Cancelled"); return }
    }
    if (!prompt) prompt = ""

    const model = args.model ?? "gpt-4.1-nano"

    const spinner = nonInteractive ? null : prompts.spinner()
    if (spinner) spinner.start("Creating agent…")

    try {
      const payload: Record<string, unknown> = { name, description: description ?? "", initial_prompt: prompt, model, type: args.type ?? "content" }
      if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]
      if (args["initial-prompt"]) payload.initial_prompt = args["initial-prompt"]
      if (args["heartbeat-mode"]) payload.heartbeat_mode = args["heartbeat-mode"]
      if (args["heartbeat-tools"]) {
        payload.heartbeat_tools = args["heartbeat-tools"].split(",").map((t: string) => t.trim())
      }

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create agent")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); process.exitCode = 1; return }

      const data = (await res.json()) as { data?: any }
      const a = data?.data ?? data

      if (args.json) {
        console.log(JSON.stringify(a, null, 2))
        return
      }

      if (spinner) spinner.stop(`${success("✓")} Agent created: ${bold(String(a.name ?? a.id))}`)

      printDivider()
      printKV("ID", a.id)
      printKV("Name", a.name)
      printKV("Model", a.model)
      if (a.bloq_id) printKV("Bloq", a.bloq_id)
      if (args["heartbeat-mode"]) printKV("Heartbeat", args["heartbeat-mode"])
      printDivider()

      if (!nonInteractive) {
        prompts.outro(
          `${dim("iris chat --agent=" + a.id + ' "hello"')}  Start chatting`,
        )
      }
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// `iris agents chat` is a THIN ALIAS over the canonical `iris chat` implementation
// (#137420). Same transport, flags, output, exit codes, and progress UX — it just
// takes the agent id as a positional. All chat behavior lives in executeChat().
const AgentsChatCommand = cmd({
  command: "chat <id> <message>",
  describe: "send a single chat message to an agent (alias of `iris chat -a <id>`)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .positional("message", { describe: "your message", type: "string", demandOption: true })
      .option("bloq", { alias: "b", describe: "bloq ID for context", type: "number" })
      .option("model", { alias: "m", describe: "override model (nano/flash only; keeps cost low)", type: "string" })
      .option("max-iterations", { describe: "cap ReactLoop iterations", type: "number" })
      .option("timeout", { describe: "max seconds to wait for response", type: "number", default: 300 })
      .option("no-rag", { describe: "disable RAG/knowledge base lookup", type: "boolean", default: false })
      .option("json", { describe: "output response as JSON", type: "boolean", default: false }),
  async handler(args) {
    await executeChat({
      message: args.message,
      agent: args.id,
      bloq: args.bloq,
      timeout: args.timeout,
      "no-rag": args["no-rag"],
      json: args.json,
      model: args.model,
      "max-iterations": args["max-iterations"],
    })
  },
})

const AgentsUpdateCommand = cmd({
  command: "update <id>",
  describe: "update an agent's config",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("description", { describe: "new description", type: "string" })
      .option("model", { describe: "new model", type: "string" })
      .option("heartbeat-mode", { describe: "heartbeat mode: off, passive, reactive, autonomous, co-pilot, briefing", type: "string", choices: ["off", "passive", "reactive", "autonomous", "co-pilot", "briefing"] })
      .option("reset-health", { describe: "reset health_status to healthy and clear consecutive_failures", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.description) payload.description = args.description
    if (args.model) payload.model = args.model
    if (args["heartbeat-mode"]) payload.heartbeat_mode = args["heartbeat-mode"]
    if (args["reset-health"]) {
      payload.health_status = "healthy"
      payload.consecutive_failures = 0
    }

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --description, --model, --heartbeat-mode, or --reset-health")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Update agent")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const a = data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(a.name ?? a.id))}`)

      printDivider()
      printKV("ID", a.id)
      printKV("Name", a.name)
      printKV("Model", a.model)
      printDivider()

      prompts.outro(dim(`iris agents get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsPullCommand = cmd({
  command: "pull <id>",
  describe: "download agent JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching agent…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`)
      const ok = await handleApiError(res, "Pull agent")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const agent = data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? agentFilename(agent)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(agent, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Name", agent.name)
      printKV("ID", agent.id)
      printKV("Model", agent.model)
      printKV("Bloq ID", agent.bloq_id)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris agents push ${args.id}  |  iris agents diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsPushCommand = cmd({
  command: "push <id>",
  describe: "upload local agent JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    try {
      const dir = resolveSyncDir()
      let filepath = args.file

      if (!filepath) {
        filepath = findLocalFile(dir, args.id)
      }

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Local file not found. Run: ${highlight(`iris agents pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${require("path").basename(filepath)}…`)

      const agent = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: agent.name,
        description: agent.description,
        model: agent.model,
        initial_prompt: agent.initial_prompt,
        personality_traits: agent.personality_traits,
        config: agent.config,
        settings: agent.settings,
        file_attachments: agent.file_attachments,
        structured_output: agent.structured_output,
      }
      // Strip undefined keys
      for (const k of Object.keys(payload)) {
        if (payload[k] === undefined) delete payload[k]
      }
      if (agent.bloq_id) payload.bloq_id = agent.bloq_id

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Push agent")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data
      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Name", result.name)
      printKV("ID", args.id)
      printKV("Model", result.model)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris agents diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsDiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local agent JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`)
      const ok = await handleApiError(res, "Fetch agent")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Local file not found. Run: ${highlight(`iris agents pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      // Compare key fields
      const fields = ["name", "description", "model", "initial_prompt", "personality_traits", "bloq_id", "active", "is_public"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        const liveVal = JSON.stringify(live[f] ?? null)
        const localVal = JSON.stringify(local[f] ?? null)
        if (liveVal !== localVal) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      // Compare nested objects
      const objFields = ["config", "settings", "file_attachments", "structured_output"]
      for (const f of objFields) {
        const liveVal = JSON.stringify(live[f] ?? null, null, 0)
        const localVal = JSON.stringify(local[f] ?? null, null, 0)
        if (liveVal !== localVal) {
          changes.push({ field: f, live: "(object changed)", local: "(object changed)" })
        }
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Agent", live.name ?? `#${args.id}`)
      printKV("Model (live)", live.model)
      printKV("Model (local)", local.model)
      console.log()

      if (changes.length === 0) {
        console.log(`  ${success("No differences")}`)
      } else {
        for (const c of changes) {
          console.log(`  ${UI.Style.TEXT_WARNING}~ ${c.field}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_DANGER}- live:  ${String(c.live ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_SUCCESS}+ local: ${String(c.local ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
        }
      }
      console.log()
      printDivider()

      if (changes.length > 0) {
        prompts.outro(dim(`iris agents push ${args.id}  — to push local changes live`))
      } else {
        prompts.outro("Done")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsDeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete an agent",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("force", { alias: "f", describe: "skip confirmation", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete agent #${args.id}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`, {
        method: "DELETE",
      })
      const ok = await handleApiError(res, "Delete agent")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Agent #${args.id} deleted`)
      prompts.outro(dim("iris agents list"))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsBulkDeleteCommand = cmd({
  command: "bulk-delete",
  aliases: ["cleanup"],
  describe: "delete multiple agents by filter (with preview)",
  builder: (yargs) =>
    yargs
      .option("ids", { describe: "comma-separated agent IDs", type: "string" })
      .option("bloq", { alias: "b", describe: "delete all agents in this bloq", type: "number" })
      .option("orphaned", { describe: "delete all agents with no bloq", type: "boolean" })
      .option("search", { alias: "s", describe: "delete agents matching search term", type: "string" })
      .option("inactive", { describe: "delete only inactive agents", type: "boolean" })
      .option("dry-run", { describe: "preview what would be deleted without deleting", type: "boolean", default: false })
      .option("force", { alias: "f", describe: "skip confirmation prompt", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .check((argv) => {
        if (!argv.ids && !argv.bloq && !argv.orphaned && !argv.search) {
          throw new Error("Specify at least one filter: --ids, --bloq, --orphaned, or --search")
        }
        return true
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Bulk Delete Agents")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Finding agents…")

    try {
      // If --ids provided, use those directly
      let targetIds: number[] = []

      if (args.ids) {
        targetIds = args.ids.split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n))
      } else {
        // Fetch agents and filter
        const params = new URLSearchParams({ per_page: "500" })
        if (args.search) params.set("search", args.search)
        const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?${params}`)
        const ok = await handleApiError(res, "List agents")
        if (!ok) { spinner.stop("Failed", 1); return }

        const raw = (await res.json()) as Record<string, any>
        let agents: any[] = raw?.data ?? []

        if (args.bloq) agents = agents.filter((a: any) => a.bloq_id === args.bloq)
        if (args.orphaned) agents = agents.filter((a: any) => !a.bloq_id)
        if (args.inactive) agents = agents.filter((a: any) => !a.active)

        targetIds = agents.map((a: any) => a.id)

        // Show preview
        spinner.stop(`${agents.length} agent(s) matched`)
        if (agents.length === 0) {
          prompts.log.warn("No agents match the filter")
          prompts.outro("Done")
          return
        }

        printDivider()
        for (const a of agents.slice(0, 20)) {
          console.log(`  ${dim(`#${a.id}`)}  ${bold(String(a.name))}  ${dim(a.bloq_id ? `bloq:${a.bloq_id}` : "(no bloq)")}`)
        }
        if (agents.length > 20) console.log(`  ${dim(`... and ${agents.length - 20} more`)}`)
        printDivider()
      }

      if (args["dry-run"]) {
        console.log(`\n  ${dim("Dry run — no agents deleted.")} Would delete ${targetIds.length} agent(s): ${targetIds.join(", ")}`)
        prompts.outro("Done")
        return
      }

      if (!args.force) {
        const confirmed = await prompts.confirm({
          message: `Delete ${targetIds.length} agent(s)? This cannot be undone.`,
        })
        if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
      }

      // Delete in parallel (batches of 5)
      const deleteSpinner = prompts.spinner()
      deleteSpinner.start(`Deleting ${targetIds.length} agents…`)
      let deleted = 0
      let failed = 0

      for (let i = 0; i < targetIds.length; i += 5) {
        const batch = targetIds.slice(i, i + 5)
        const results = await Promise.allSettled(
          batch.map((id) =>
            irisFetch(`/api/v1/users/${userId}/bloqs/agents/${id}`, { method: "DELETE" })
          ),
        )
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.ok) deleted++
          else failed++
        }
      }

      deleteSpinner.stop(`${success("✓")} Deleted ${deleted}${failed > 0 ? `, ${failed} failed` : ""}`)
      prompts.outro(dim("iris agents list"))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

const AgentsAssignCommand = cmd({
  command: "assign <agent-id>",
  describe: "assign an agent to a bloq, task, or lead task",
  builder: (yargs) =>
    yargs
      .positional("agent-id", { type: "number", demandOption: true, describe: "agent ID to assign" })
      .option("bloq", { type: "number", describe: "set as heartbeat agent on bloq" })
      .option("task", { type: "number", describe: "assign to a BloqItemTask by ID" })
      .option("lead-task", { type: "number", describe: "assign to a LeadTask by ID (requires --lead-id)" })
      .option("lead-id", { type: "number", describe: "lead ID (required with --lead-task)" })
      .check((argv) => {
        if (!argv.bloq && !argv.task && !argv["lead-task"]) {
          throw new Error("Specify at least one target: --bloq, --task, or --lead-task")
        }
        if (argv["lead-task"] && !argv["lead-id"]) {
          throw new Error("--lead-task requires --lead-id")
        }
        return true
      }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }
    const spinner = prompts.spinner()
    const agentId = args["agent-id"] as number

    // Assign to bloq (set heartbeat_agent_id)
    if (args.bloq) {
      spinner.start(`Assigning agent #${agentId} to bloq #${args.bloq}…`)
      try {
        const res = await irisFetch(`/api/v1/user/bloqs/${args.bloq}`, {
          method: "PUT",
          body: JSON.stringify({ heartbeat_agent_id: agentId }),
        })
        const ok = await handleApiError(res, "Assign to bloq")
        if (ok) {
          spinner.stop(success(`✓ Agent #${agentId} set as heartbeat agent on bloq #${args.bloq}`))
        } else {
          spinner.stop("Failed", 1)
        }
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
    }

    // Assign to BloqItemTask
    if (args.task) {
      spinner.start(`Assigning agent #${agentId} to task #${args.task}…`)
      try {
        // BloqItemTask doesn't have a direct update-by-id endpoint,
        // so we use the iris-api proxy or fall back to lead task endpoint
        const res = await irisFetch(`/api/v6/workspace/heartbeat/tasks/${args.task}/approve`, {
          method: "POST",
          body: JSON.stringify({ agent_id: agentId }),
        })
        // If approve doesn't work for just assignment, try direct update
        if (!res.ok) {
          prompts.log.warn("Direct task assignment not yet supported via API — use iris leads tasks assign instead")
        } else {
          spinner.stop(success(`✓ Agent #${agentId} assigned to task #${args.task}`))
        }
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
    }

    // Assign to LeadTask
    if (args["lead-task"]) {
      const leadId = args["lead-id"] as number
      const taskId = args["lead-task"] as number
      spinner.start(`Assigning agent #${agentId} to lead task #${taskId}…`)
      try {
        const res = await irisFetch(`/api/v1/leads/${leadId}/tasks/${taskId}`, {
          method: "PUT",
          body: JSON.stringify({ agent_id: agentId }),
        })
        const ok = await handleApiError(res, "Assign to lead task")
        if (ok) {
          spinner.stop(success(`✓ Agent #${agentId} assigned to lead #${leadId} task #${taskId}`))
        } else {
          spinner.stop("Failed", 1)
        }
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
    }

    prompts.outro("Done")
  },
})

export const PlatformAgentsCommand = cmd({
  command: "agents",
  describe: "manage IRIS platform agents — pull, push, diff, CRUD, assign",
  builder: (yargs) =>
    yargs
      .command(AgentsListCommand)
      .command(AgentsGetCommand)
      .command(AgentsCreateCommand)
      .command(AgentsUpdateCommand)
      .command(AgentsPullCommand)
      .command(AgentsPushCommand)
      .command(AgentsDiffCommand)
      .command(AgentsDeleteCommand)
      .command(AgentsBulkDeleteCommand)
      .command(AgentsChatCommand)
      .command(AgentsAssignCommand)
      .demandCommand(),
  async handler() {},
})
