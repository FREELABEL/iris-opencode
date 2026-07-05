import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, FL_API, IRIS_API, resolveUserId, streamAgentChat } from "./iris-api"
import { captureMic, speak, listMics } from "../lib/voice"
import { transcribeLocal, which } from "../lib/transcription"
import { createInterface } from "readline"

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
  model?: string
  tokens_used?: number
  elapsed_ms?: number
}

async function pollWorkflow(workflowId: string, timeoutSecs = 300): Promise<WorkflowRun> {
  const start = Date.now()
  let dots = 0
  while (true) {
    if ((Date.now() - start) / 1000 > timeoutSecs) {
      throw new Error(`Timed out after ${timeoutSecs}s. Workflow ID: ${workflowId}`)
    }
    const res = await irisFetch(`/api/workflows/${workflowId}`, {}, IRIS_API)
    if (!res.ok) throw new Error(`HTTP ${res.status} polling workflow`)
    // The status endpoint wraps the run in { data: {...} }. Unwrap it, else
    // status/summary read as undefined → poll times out + "(no response)".
    const body = (await res.json()) as { data?: WorkflowRun }
    const run = (body.data ?? body) as WorkflowRun

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
// Shared chat execution
// ============================================================================

// Exported so `iris agents chat` can be a thin alias over the SAME path (#137420)
// — one canonical chat implementation, identical transport, flags, and output.
export async function executeChat(args: {
  message: string
  agent?: number
  bloq?: number
  "user-id"?: number
  timeout: number
  "no-rag": boolean
  json?: boolean
  continue?: string
  model?: string
  "max-iterations"?: number
}): Promise<void> {
  const isJson = args.json === true

  if (!isJson) {
    UI.empty()
    prompts.intro("◈  IRIS Chat")
  }

  const token = await requireAuth()
  if (!token) {
    if (!isJson) prompts.outro("Done")
    return
  }

  // If continuing a previous conversation, poll for it
  if (args.continue) {
    if (!isJson) {
      prompts.log.info(`Resuming workflow ${dim(args.continue)}`)
    }
    try {
      const run = await pollWorkflow(args.continue, args.timeout)
      process.stderr.write("\r" + " ".repeat(40) + "\r")
      outputResult(run, args.continue, args.agent, isJson)
    } catch (err) {
      process.stderr.write("\r" + " ".repeat(40) + "\r")
      if (isJson) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      } else {
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
      }
    }
    return
  }

  // Resolve agent ID if not provided
  let agentId = args.agent
  if (!agentId && !isJson) {
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
      if (!isJson) prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!isJson) prompts.outro("Done")
      return
    }
  }

  if (!agentId) {
    if (isJson) {
      console.log(JSON.stringify({ error: "No agent selected. Use --agent <id>" }))
    } else {
      prompts.log.warn("No agent selected. Use --agent <id>")
      prompts.log.info(`Try: ${dim("iris agents list")} to see available agents`)
      prompts.outro("Done")
    }
    return
  }

  const userId = await resolveUserId()

  if (!isJson) {
    prompts.log.info(
      `Sending to ${bold(`Agent #${agentId}`)}${args.bloq ? `  ${dim(`bloq:${args.bloq}`)}` : ""}`,
    )
  }

  const spinner = isJson ? null : prompts.spinner()
  spinner?.start("Thinking…")
  const startTime = Date.now()

  // Elapsed heartbeat so a slow run never looks stuck (#137419). The latest tool
  // event wins the label; otherwise we show "Thinking… (Ns)" ticking every second.
  let lastActivity = "Thinking…"
  const heartbeat = isJson ? null : setInterval(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000)
    spinner?.message(`${lastActivity} (${secs}s)`)
  }, 1000)

  try {
    // Faithful V6 ReactLoop path — same engine + toolset as the Slack channel (#137387).
    // Stateless per call: no resumed server session → no cross-turn poisoning.
    const result = await streamAgentChat({
      agentId,
      message: args.message,
      userId,
      bloqId: args.bloq,
      overrideModel: args.model,
      maxIterations: args["max-iterations"],
      timeoutSecs: args.timeout,
      enableRag: !args["no-rag"],
      onEvent: (evt) => {
        if (isJson) return
        if (evt.type === "tool_call" && evt.tool) lastActivity = `Using ${evt.tool}…`
        else if (evt.type === "tool_result" && evt.tool) lastActivity = `${evt.tool} ✓`
        else if (evt.type === "thinking") lastActivity = "Thinking…"
      },
    })

    if (heartbeat) clearInterval(heartbeat)

    if (!result.ok) {
      // Distinct exit codes so automation can branch (#137418): 2 = timeout, 1 = other failure.
      const elapsed = Math.floor((Date.now() - startTime) / 1000)
      const msg = result.timedOut
        ? `Timed out after ${elapsed}s — the agent didn't respond in time. Try again or raise --timeout.`
        : (result.error ?? "Chat failed — no answer delivered.")
      spinner?.stop(result.timedOut ? "Timed out" : "Failed", 1)
      if (isJson) {
        console.log(JSON.stringify({ status: result.timedOut ? "timeout" : "failed", error: msg }))
      } else {
        prompts.log.error(msg)
        prompts.outro("Done")
      }
      process.exitCode = result.timedOut ? 2 : 1
      return
    }

    spinner?.stop("Done")

    const run: WorkflowRun = {
      status: "completed",
      summary: result.content,
      iteration_count: result.iterations,
      elapsed_ms: Date.now() - startTime,
    }

    // No server-side workflow id in the sync stream path → pass "" (suppresses --continue).
    outputResult(run, "", agentId, isJson, result.toolsUsed)
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat)
    process.stderr.write("\r" + " ".repeat(40) + "\r")
    const msg = err instanceof Error ? err.message : String(err)
    if (isJson) {
      console.log(JSON.stringify({ status: "failed", error: msg }))
    } else {
      prompts.log.error(msg)
      prompts.outro("Done")
    }
    process.exitCode = 1
  }
}

// ============================================================================
// Voice chat — local, free, real-time conversation loop.
//
// mic (ffmpeg) → transcribeLocal (whisper.cpp) → streamAgentChat → speak (say).
// Push-to-talk turn-taking; multi-turn via conversation_history (no server
// session, so no cross-turn poisoning — same guarantee as text chat). All STT
// + TTS runs on-device; only the agent call leaves the machine. (#158044/#158045)
// ============================================================================

export async function runVoiceChat(args: {
  agent?: number
  bloq?: number
  timeout: number
  "no-rag": boolean
  model?: string
  "max-iterations"?: number
  mic?: string
  tts?: string
  "tts-voice"?: string
}): Promise<void> {
  UI.empty()
  prompts.intro("◈  IRIS Voice Chat")

  const token = await requireAuth()
  if (!token) { prompts.outro("Done"); return }

  const agentId = args.agent
  if (!agentId) {
    prompts.log.warn("Voice chat needs an explicit agent. Use --agent <id>.")
    prompts.log.info(`Try: ${dim("iris agents list")} to find one (e.g. --agent 642 for TOBI)`)
    prompts.outro("Done")
    return
  }

  if (!which("ffmpeg") || (!which("whisper-cli") && !which("whisper-cpp"))) {
    prompts.log.error("Local voice needs ffmpeg + whisper-cpp.")
    prompts.log.info(`Install: ${dim("brew install ffmpeg whisper-cpp")}`)
    prompts.outro("Done")
    return
  }

  const userId = await resolveUserId()
  const mics = listMics()
  const micLabel = args.mic
    ? mics.find((m) => m.index === args.mic)?.name ?? `device :${args.mic}`
    : "system default"
  const ttsLabel = args.tts ?? (process.platform === "darwin" ? "say" : "piper")

  prompts.log.info(`${bold(`Agent #${agentId}`)}  ${dim(`· mic: ${micLabel} · tts: ${ttsLabel}`)}`)
  prompts.log.info(dim("ENTER = start talking · pause (or ENTER) sends it · q + ENTER = quit"))

  // One readline for the whole session. The old manual `stdin.once('data')` +
  // pause/resume juggling fought the prompt lib's raw-mode TTY and hung on the
  // second read — readline handles the terminal correctly across every turn. No
  // clack spinner here either (it flips stdin to raw mode); status = plain stderr.
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve))
  const clearLine = () => process.stderr.write("\r" + " ".repeat(56) + "\r")

  const history: Array<{ role: string; content: string }> = []

  try {
    while (true) {
      const key = (await ask(`\n  ${dim("▶︎ ENTER to talk (q to quit): ")}`)).trim()
      if (key.toLowerCase() === "q") break

      // Capture + transcribe — both on-device. Stops on silence OR a manual ENTER
      // (rl.once('line'), removed after so no read leaks into the next turn).
      let text = ""
      try {
        process.stderr.write(`  ${dim("🎧 speak now… (pause to send, or press ENTER)")}`)
        let onEnter: () => void = () => {}
        const stopSignal = new Promise<void>((res) => { onEnter = () => res() })
        rl.once("line", onEnter)
        const wav = await captureMic({
          mic: args.mic,
          stopSignal,
          onSpeech: () => process.stderr.write(`\r  ${dim("🔴 recording… (pause or ENTER to send)")}   `),
        })
        rl.removeListener("line", onEnter)
        clearLine()
        process.stderr.write(`  ${dim("📝 transcribing…")}`)
        text = await transcribeLocal(wav)
        clearLine()
      } catch (err) {
        clearLine()
        console.log(`  ${dim("⚠ " + (err instanceof Error ? err.message : String(err)))}`)
        continue
      }
      // Drop empties / stray blips (whisper emits "[BLANK_AUDIO]" etc. on silence).
      if (!text || text.replace(/[^a-z0-9]/gi, "").length < 2 || /^\[.*\]$/.test(text)) {
        console.log(`  ${dim("(didn't catch that — try again)")}`)
        continue
      }
      console.log(`  ${bold("You:")} ${text}`)

      // Ask the agent (same faithful V6 ReactLoop path as text chat).
      history.push({ role: "user", content: text })
      const startTime = Date.now()
      let lastActivity = "thinking…"
      const heartbeat = setInterval(() => {
        process.stderr.write(`\r  ${dim(`🤖 ${lastActivity} (${Math.floor((Date.now() - startTime) / 1000)}s)`)}   `)
      }, 1000)

      try {
        const result = await streamAgentChat({
          agentId,
          message: text,
          userId,
          bloqId: args.bloq,
          overrideModel: args.model,
          maxIterations: args["max-iterations"],
          timeoutSecs: args.timeout,
          enableRag: !args["no-rag"],
          conversationHistory: history.slice(0, -1),
          onEvent: (evt) => {
            if (evt.type === "tool_call" && evt.tool) lastActivity = `using ${evt.tool}…`
            else if (evt.type === "tool_result" && evt.tool) lastActivity = `${evt.tool} ✓`
            else if (evt.type === "thinking") lastActivity = "thinking…"
          },
        })
        clearInterval(heartbeat)
        clearLine()

        if (!result.ok) {
          console.log(`  ${dim("⚠ " + (result.error ?? (result.timedOut ? "timed out" : "no answer delivered")))}`)
          history.pop() // drop the unanswered turn so history stays consistent
          continue
        }

        const reply = result.content || "(no response)"
        history.push({ role: "assistant", content: reply })
        console.log(`  ${bold("Agent:")} ${reply.split("\n").join("\n  ")}`)
        console.log(`  ${dim(`${result.iterations ?? 0} iter · ${((Date.now() - startTime) / 1000).toFixed(1)}s`)}`)
        await speak(reply, { tts: args.tts, voice: args["tts-voice"] })
      } catch (err) {
        clearInterval(heartbeat)
        clearLine()
        console.log(`  ${dim("⚠ " + (err instanceof Error ? err.message : String(err)))}`)
        history.pop()
      }
    }
  } finally {
    rl.close()
  }

  prompts.outro("Voice chat ended 👋")
}

function outputResult(run: WorkflowRun, workflowId: string, agentId: number | undefined, isJson: boolean, toolsUsed: string[] = []): void {
  const response = run.summary ?? run.response ?? run.output ?? "(no response)"

  if (isJson) {
    console.log(JSON.stringify({
      workflow_id: workflowId || undefined,
      status: run.status,
      response,
      model: run.model,
      tokens: run.tokens_used,
      iterations: run.iteration_count,
      tools_used: toolsUsed,
      elapsed_ms: run.elapsed_ms,
      requires_approval: run.requires_approval ?? false,
    }))
    return
  }

  printDivider()
  console.log()
  console.log(`  ${bold("Agent:")} ${response.split("\n").join("\n  ")}`)
  console.log()

  // Surface the real toolset that ran — proof the harness is faithful (#137387).
  if (toolsUsed.length > 0) {
    console.log(`  ${dim(`tools used: ${toolsUsed.join(", ")}`)}`)
    console.log()
  }

  // Metrics
  const metrics: string[] = []
  if (run.model) metrics.push(`model: ${run.model}`)
  if (run.tokens_used) metrics.push(`tokens: ${run.tokens_used}`)
  if (run.iteration_count) metrics.push(`iterations: ${run.iteration_count}`)
  if (run.elapsed_ms) metrics.push(`time: ${(run.elapsed_ms / 1000).toFixed(1)}s`)
  if (metrics.length > 0) {
    console.log(`  ${dim(metrics.join("  ·  "))}`)
    console.log()
  }

  printDivider()

  if (run.status === "paused" && run.requires_approval) {
    prompts.log.warn("Workflow paused — requires approval")
    prompts.log.info(`Approve: ${dim(`iris chat approve ${workflowId}`)}`)
  }

  // --continue resumes a legacy workflow; only offer it when we have a workflow id.
  const followUp = `${dim("iris chat --agent=" + (agentId ?? "?") + ' "follow up"')}`
  prompts.outro(
    workflowId ? `${followUp}  ·  ${dim(`iris chat --continue ${workflowId}`)}` : followUp,
  )
}

// ============================================================================
// Approve subcommand
// ============================================================================

const ChatApproveCommand = cmd({
  command: "approve <workflow-id>",
  describe: "approve a paused workflow (human-in-the-loop)",
  builder: (yargs) =>
    yargs
      .positional("workflow-id", {
        describe: "workflow ID to approve",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      })
      .option("timeout", {
        describe: "max seconds to wait after approval",
        type: "number",
        default: 300,
      }),
  async handler(args) {
    const isJson = args.json === true
    if (!isJson) {
      UI.empty()
      prompts.intro("◈  IRIS Chat — Approve")
    }

    const token = await requireAuth()
    if (!token) {
      if (!isJson) prompts.outro("Done")
      return
    }

    const workflowId = args["workflow-id"]

    if (!isJson) {
      const spinner = prompts.spinner()
      spinner.start("Sending approval…")

      try {
        const res = await irisFetch(`/api/chat/resume`, {
          method: "POST",
          body: JSON.stringify({ workflow_id: workflowId, action: "approve" }),
        }, IRIS_API)
        const ok = await handleApiError(res, "Approve")
        if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
        spinner.stop("Approved — waiting for completion…")
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
        return
      }
    } else {
      const res = await irisFetch(`/api/chat/resume`, {
        method: "POST",
        body: JSON.stringify({ workflow_id: workflowId, action: "approve" }),
      }, IRIS_API)
      const ok = await handleApiError(res, "Approve")
      if (!ok) {
        console.log(JSON.stringify({ error: "Failed to approve workflow" }))
        return
      }
    }

    // Poll for final result
    try {
      const run = await pollWorkflow(workflowId, args.timeout)
      process.stderr.write("\r" + " ".repeat(40) + "\r")
      outputResult(run, workflowId, undefined, isJson)
    } catch (err) {
      process.stderr.write("\r" + " ".repeat(40) + "\r")
      if (isJson) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      } else {
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
      }
    }
  },
})

// ============================================================================
// Chat command (root)
// ============================================================================

export const PlatformChatCommand = cmd({
  command: "chat [message]",
  aliases: ["c"],
  describe: "chat with an IRIS agent",
  builder: (yargs) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
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
      })
      .option("json", {
        describe: "output response as JSON",
        type: "boolean",
        default: false,
      })
      .option("continue", {
        describe: "resume a previous workflow by ID (legacy V5.5 workflow engine)",
        type: "string",
      })
      .option("model", {
        alias: "m",
        describe: "override model (nano/flash only; keeps cost low)",
        type: "string",
      })
      .option("max-iterations", {
        describe: "cap ReactLoop iterations",
        type: "number",
      })
      .option("voice", {
        describe: "voice mode — talk to the agent via mic + local speech (free, on-device)",
        type: "boolean",
        default: false,
      })
      .option("mic", {
        describe: "input device (macOS index from --list-mics, or ALSA name); default = system mic",
        type: "string",
      })
      .option("tts", {
        describe: "speech backend for replies: say | piper | none",
        type: "string",
        choices: ["say", "piper", "none"],
      })
      .option("tts-voice", {
        describe: "TTS voice name (e.g. macOS `say -v` voice)",
        type: "string",
      })
      .option("list-mics", {
        describe: "list available input devices and exit",
        type: "boolean",
        default: false,
      })
      .command(ChatApproveCommand),

  async handler(args) {
    if (args["list-mics"]) {
      UI.empty()
      prompts.intro("◈  IRIS Voice — Input Devices")
      const mics = listMics()
      if (mics.length === 0) {
        prompts.log.info("No devices enumerated (device listing is macOS-only; on Linux pass --mic <alsa-name>).")
      } else {
        for (const m of mics) console.log(`  ${bold(`:${m.index}`)}  ${m.name}`)
      }
      prompts.outro(`Use: ${dim("iris chat --voice --agent <id> --mic <index>")}`)
      return
    }

    if (args.voice) {
      await runVoiceChat({
        agent: args.agent,
        bloq: args.bloq,
        timeout: args.timeout,
        "no-rag": args["no-rag"],
        model: args.model,
        "max-iterations": args["max-iterations"],
        mic: args.mic,
        tts: args.tts,
        "tts-voice": args["tts-voice"],
      })
      return
    }

    if (!args.message && !args.continue) {
      UI.empty()
      prompts.intro("◈  IRIS Chat")
      prompts.log.warn("No message provided.")
      prompts.log.info(`Usage: ${dim('iris chat "your message"')}`)
      prompts.log.info(`       ${dim("iris chat approve <workflow-id>")}`)
      prompts.log.info(`       ${dim("iris chat --continue <workflow-id>")}`)
      prompts.outro("Done")
      return
    }

    await executeChat({
      message: args.message ?? "",
      agent: args.agent,
      bloq: args.bloq,
      "user-id": args["user-id"],
      timeout: args.timeout,
      "no-rag": args["no-rag"],
      json: args.json,
      continue: args.continue,
      model: args.model,
      "max-iterations": args["max-iterations"],
    })
  },
})
