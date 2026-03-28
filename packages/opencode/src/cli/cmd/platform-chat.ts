import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, FL_API } from "./iris-api"

// ============================================================================
// Polling helper
// ============================================================================

interface WorkflowRun {
  status: string
  summary?: string
  response?: string
  output?: string
  error?: string
  requires_approval?: boolean
  iteration_count?: number
}

async function pollWorkflow(workflowId: string, timeoutSecs = 300): Promise<WorkflowRun> {
  const start = Date.now()
  let dots = 0
  while (true) {
    if ((Date.now() - start) / 1000 > timeoutSecs) {
      throw new Error(`Timed out after ${timeoutSecs}s. Workflow ID: ${workflowId}`)
    }
    const res = await irisFetch(`/api/workflows/${workflowId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} polling workflow`)
    const run = (await res.json()) as WorkflowRun

    if (run.status === "completed") return run
    if (run.status === "failed") {
      throw new Error(run.error ?? run.summary ?? "Workflow failed")
    }
    if (run.status === "paused" && run.requires_approval) return run

    // Animate spinner manually via process.stdout (no clack spinner inside clack intro)
    dots = (dots + 1) % 4
    process.stderr.write(`\r  ${UI.Style.TEXT_DIM}${"◌◎◉●"[dots]} thinking…${UI.Style.TEXT_NORMAL}   `)
    await Bun.sleep(600)
  }
}

// ============================================================================
// Chat command
// ============================================================================

export const PlatformChatCommand = cmd({
  command: "chat <message>",
  aliases: ["c"],
  describe: "chat with an IRIS agent",
  builder: (yargs) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        demandOption: true,
      })
      .option("agent", {
        alias: "a",
        describe: "agent ID",
        type: "number",
      })
      .option("bloq", {
        alias: "b",
        describe: "knowledge base (bloq) ID",
        type: "number",
      })
      .option("user-id", {
        describe: "your IRIS user ID (or set IRIS_USER_ID env var)",
        type: "number",
      })
      .option("timeout", {
        describe: "max seconds to wait for response",
        type: "number",
        default: 300,
      })
      .option("no-rag", {
        describe: "disable RAG/knowledge base lookup",
        type: "boolean",
        default: false,
      }),

  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Chat")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    // Resolve agent ID if not provided
    let agentId = args.agent
    if (!agentId) {
      // List agents and let user pick
      const spinner = prompts.spinner()
      spinner.start("Loading agents…")
      try {
        const res = await irisFetch("/api/v1/bloqs/agents?per_page=20")
        if (res.ok) {
          const data = (await res.json()) as { data?: any[] }
          const agents: any[] = data?.data ?? []
          spinner.stop(`${agents.length} agent(s) found`)
          if (agents.length > 0) {
            const selected = await prompts.select({
              message: "Select an agent",
              options: agents.slice(0, 15).map((a: any) => ({
                label: a.name ?? `Agent #${a.id}`,
                value: String(a.id),
                hint: a.description ? String(a.description).slice(0, 60) : "",
              })),
            })
            if (prompts.isCancel(selected)) {
              prompts.outro("Cancelled")
              return
            }
            agentId = parseInt(selected as string, 10)
          }
        } else {
          spinner.stop("Could not load agents", 1)
        }
      } catch (err) {
        spinner.stop("Error loading agents", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
        return
      }
    }

    if (!agentId) {
      prompts.log.warn("No agent selected. Use --agent <id>")
      prompts.log.info(`Try: ${dim("iris agents list")} to see available agents`)
      prompts.outro("Done")
      return
    }

    const envUserId = parseInt(process.env.IRIS_USER_ID ?? "", 10)
    const userId = args["user-id"] ?? (isNaN(envUserId) ? undefined : envUserId)

    prompts.log.info(
      `Sending to ${bold(`Agent #${agentId}`)}${args.bloq ? `  ${dim(`bloq:${args.bloq}`)}` : ""}`,
    )

    const spinner = prompts.spinner()
    spinner.start("Waiting for response…")

    try {
      const payload: Record<string, unknown> = {
        query: args.message,
        agentId,
        conversationHistory: [{ role: "user", content: args.message }],
        enableRAG: !args["no-rag"],
        contextPayload: { source: "iris-cli" },
      }
      if (userId) payload.userId = userId
      if (args.bloq) payload.bloqId = String(args.bloq)

      const startRes = await irisFetch("/api/chat/start", {
        method: "POST",
        body: JSON.stringify(payload),
      })

      const ok = await handleApiError(startRes, "Chat")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

      const { workflow_id } = (await startRes.json()) as { workflow_id?: string }
      if (!workflow_id) {
        spinner.stop("No workflow ID returned", 1)
        prompts.outro("Done")
        return
      }

      spinner.stop(`Workflow ${dim(workflow_id)}`)

      // Poll for completion
      const run = await pollWorkflow(workflow_id, args.timeout)
      process.stderr.write("\r" + " ".repeat(40) + "\r") // clear spinner line

      const response = run.summary ?? run.response ?? run.output ?? "(no response)"

      printDivider()
      console.log()
      console.log(`  ${bold("Agent:")} ${response.split("\n").join("\n  ")}`)
      console.log()
      printDivider()

      if (run.status === "paused") {
        prompts.log.warn("Workflow paused — requires approval")
      }

      prompts.outro(
        `${dim("iris chat --agent=" + agentId + ' "follow up"')}  Continue conversation`,
      )
    } catch (err) {
      process.stderr.write("\r" + " ".repeat(40) + "\r")
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})
