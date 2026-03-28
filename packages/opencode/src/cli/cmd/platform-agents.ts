import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success } from "./iris-api"

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
      .option("search", { alias: "s", describe: "search query", type: "string" })
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Agents")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading agents…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args.search) params.set("search", args.search)

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?${params}`)
      const ok = await handleApiError(res, "List agents")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[]; total?: number }
      const agents: any[] = data?.data ?? []
      spinner.stop(`${agents.length} agent(s)`)

      if (agents.length === 0) {
        prompts.log.warn("No agents found")
        prompts.outro(`Create one: ${dim("iris agents create")}`)
        return
      }

      printDivider()
      for (const a of agents) {
        printAgent(a)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${dim("iris agents get <id>")}  ·  ${dim("iris chat --agent=<id> \"hello\"")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsGetCommand = cmd({
  command: "get <id>",
  describe: "show agent details",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`)
      const ok = await handleApiError(res, "Get agent")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const a = data?.data ?? data
      spinner.stop(String(a.name ?? `Agent #${a.id}`))

      printDivider()
      printKV("ID", a.id)
      printKV("Name", a.name)
      printKV("Model", a.model)
      printKV("Description", a.description)
      printKV("Bloq ID", a.bloq_id)
      printKV("Created", a.created_at)
      console.log()
      printDivider()

      prompts.outro(
        `${dim("iris chat --agent=" + args.id + ' "hello"')}  Chat with this agent`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsCreateCommand = cmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "agent name", type: "string" })
      .option("description", { describe: "agent description", type: "string" })
      .option("model", { describe: "AI model (e.g. gpt-4o-mini)", type: "string" })
      .option("bloq-id", { describe: "knowledge base bloq ID", type: "number" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Agent")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      name = (await prompts.text({
        message: "Agent name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    let description = args.description
    if (!description) {
      description = (await prompts.text({
        message: "Description (optional)",
        placeholder: "e.g. Helps with lead research and follow-ups",
      })) as string
      if (prompts.isCancel(description)) description = ""
    }

    const model = args.model ?? "gpt-4.1-nano"

    const spinner = prompts.spinner()
    spinner.start("Creating agent…")

    try {
      const payload: Record<string, unknown> = { name, description, model }
      if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create agent")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const a = data?.data ?? data
      spinner.stop(`${success("✓")} Agent created: ${bold(String(a.name ?? a.id))}`)

      printDivider()
      printKV("ID", a.id)
      printKV("Name", a.name)
      printKV("Model", a.model)
      printDivider()

      prompts.outro(
        `${dim("iris chat --agent=" + a.id + ' "hello"')}  Start chatting`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AgentsChatCommand = cmd({
  command: "chat <id> <message>",
  describe: "send a single chat message to an agent",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .positional("message", { describe: "your message", type: "string", demandOption: true })
      .option("bloq", { alias: "b", describe: "bloq ID for context", type: "number" }),
  async handler(args) {
    // Delegate to iris chat --agent=<id> <message>
    UI.empty()
    prompts.intro(`◈  Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {
      query: args.message,
      agentId: args.id,
      conversationHistory: [{ role: "user", content: args.message }],
      enableRAG: true,
      contextPayload: { source: "iris-cli" },
    }
    if (args.bloq) payload.bloqId = String(args.bloq)

    prompts.log.info(`Sending: ${dim(String(args.message).slice(0, 80))}`)
    const spinner = prompts.spinner()
    spinner.start("Waiting…")

    try {
      const startRes = await irisFetch("/api/chat/start", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(startRes, "Chat")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const { workflow_id } = (await startRes.json()) as { workflow_id?: string }
      if (!workflow_id) { spinner.stop("No workflow ID", 1); prompts.outro("Done"); return }

      // Poll
      const maxSecs = 180
      const start = Date.now()
      let run: { status: string; summary?: string; response?: string; output?: string; error?: string } = { status: "pending" }
      while (true) {
        if ((Date.now() - start) / 1000 > maxSecs) break
        const pollRes = await irisFetch(`/api/workflows/${workflow_id}`)
        if (pollRes.ok) {
          run = (await pollRes.json()) as typeof run
          if (run.status === "completed" || run.status === "failed") break
        }
        await Bun.sleep(800)
      }

      const response = run.summary ?? run.response ?? run.output ?? "(no response)"
      spinner.stop("Done")

      printDivider()
      console.log()
      console.log(`  ${bold("Agent:")} ${response.split("\n").join("\n  ")}`)
      console.log()
      printDivider()

      prompts.outro(dim(`iris chat --agent=${args.id} "follow up"`))
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

export const PlatformAgentsCommand = cmd({
  command: "agents",
  describe: "manage IRIS platform agents",
  builder: (yargs) =>
    yargs
      .command(AgentsListCommand)
      .command(AgentsGetCommand)
      .command(AgentsCreateCommand)
      .command(AgentsChatCommand)
      .demandCommand(),
  async handler() {},
})
