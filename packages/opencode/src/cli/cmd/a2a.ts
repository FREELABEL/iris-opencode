/**
 * `iris a2a` — A2A (Agent2Agent) protocol support, alongside MCP (`iris mcp serve`) and
 * ACP (`iris acp`). #186514.
 *
 * SPEC PIN: A2A v1.0.1 — github.com/a2aproject/A2A, tag v1.0.1 (2026-05-28), JSON-RPC
 * binding, wire version "1.0". Protocol logic lives in src/a2a/ (server.ts, client.ts);
 * this file is only the CLI surface.
 *
 *   iris a2a serve --agent <id>     expose an IRIS platform agent as an A2A agent
 *   iris a2a call <url> <text>      send a task to any A2A v1.0 agent and print the answer
 */
import { cmd } from "./cmd"
import { Installation } from "../../installation"
import { A2A_PROTOCOL_VERSION, A2A_SPEC_PIN, createA2AHandler, type AgentCard, type Execute } from "../../a2a/server"
import { a2aCall, A2AError } from "../../a2a/client"
import { irisAgentExecutor } from "../../a2a/iris-agent"
import { IRIS_BIN, MCP_CHILD_ENV } from "./mcp-serve"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"])

async function agentName(agentId: number): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([IRIS_BIN, "agents", "get", String(agentId), "--json"], {
      env: { ...process.env, ...MCP_CHILD_ENV },
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => proc.kill(), 20_000)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    const name = JSON.parse(out)?.name
    return typeof name === "string" && name ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * NOT a production executor. Answers "echo: <text>" in two chunks without touching the
 * platform, so the A2A wire exchange can be proven where no IRIS agent is reachable.
 * Reached only through the hidden --unsafe-echo-for-tests flag, and the card says so.
 */
const echoExecutor: Execute = async function* ({ text, signal }) {
  const delay = Number(process.env.IRIS_A2A_ECHO_DELAY_MS) || 0
  for (const chunk of ["echo: ", text]) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    if (signal.aborted) return
    yield chunk
  }
}

export function buildAgentCard(input: {
  rpcUrl: string
  agentId: number
  agentName?: string
  echo?: boolean
}): AgentCard {
  const label = input.agentName ? `${input.agentName} (IRIS agent #${input.agentId})` : `IRIS agent #${input.agentId}`
  return {
    name: input.echo ? "ECHO TEST SERVER — no IRIS agent behind it" : label,
    description:
      (input.echo
        ? "TEST MODE: every task is answered with 'echo: <your text>'. No IRIS agent is consulted. "
        : `Ask ${label}, a standing agent on the IRIS platform. Each task is one question; the answer is returned as a text artifact. Tasks sharing a contextId share one conversation thread. `) +
      "Authentication: the JSON-RPC endpoint requires 'Authorization: Bearer <token>' (the token is printed by `iris a2a serve` at startup); this card is public.",
    version: Installation.VERSION,
    supportedInterfaces: [{ url: input.rpcUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "IRIS", url: "https://heyiris.io" },
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: input.echo ? "echo" : `ask-agent-${input.agentId}`,
        name: input.echo ? "Echo (test)" : `Ask ${input.agentName ?? `agent #${input.agentId}`}`,
        description: input.echo
          ? "Returns the input text prefixed with 'echo: '. Test mode only."
          : `Put a question to ${label} and get its answer. The agent can use the tools and knowledge configured for it on IRIS.`,
        tags: input.echo ? ["test"] : ["iris", "agent", "ask"],
        examples: input.echo ? ["hello"] : ["What changed in my pipeline this week?"],
      },
    ],
  }
}

export const A2aServeCommand = cmd({
  command: "serve",
  describe: "expose an IRIS agent as an A2A v1.0 agent (JSON-RPC over HTTP)",
  builder: (yargs) =>
    yargs
      .option("agent", { type: "number", describe: "IRIS platform agent id to answer tasks (see `iris agents list`)" })
      .option("port", { type: "number", default: 3211, describe: "port to listen on" })
      .option("host", { type: "string", default: "127.0.0.1", describe: "interface to bind (loopback by default)" })
      .option("token", { type: "string", describe: "bearer token clients must send (default: $IRIS_A2A_TOKEN, else random, printed once)" })
      .option("timeout", { type: "number", default: 120, describe: "seconds an agent may take per task (10-600)" })
      .option("public-url", { type: "string", describe: "base URL advertised in the agent card, when reached through a proxy or tunnel" })
      .option("unsafe-echo-for-tests", { type: "boolean", default: false, hidden: true })
      .epilogue(
        [
          `Speaks ${A2A_SPEC_PIN}, JSON-RPC binding.`,
          "",
          "  GET  /.well-known/agent-card.json   agent card (public)",
          "  POST /a2a                           JSON-RPC: SendMessage, SendStreamingMessage,",
          "                                      GetTask, ListTasks, CancelTask, SubscribeToTask",
          "",
          "Every request to /a2a needs 'Authorization: Bearer <token>' and 'A2A-Version: 1.0'.",
          "Tasks live in memory and are gone when the server stops.",
        ].join("\n"),
      ),
  async handler(argv) {
    const echo = argv["unsafe-echo-for-tests"] === true
    const agentId = argv.agent as number | undefined
    if (!echo && (typeof agentId !== "number" || !Number.isInteger(agentId) || agentId <= 0)) {
      console.error("Error: --agent <id> is required (a positive IRIS agent id — see `iris agents list`).")
      process.exitCode = 1
      return
    }
    const host = argv.host as string
    const port = argv.port as number
    const token = (argv.token as string) || process.env.IRIS_A2A_TOKEN || crypto.randomUUID()
    const timeoutSecs = Math.min(Math.max(Number(argv.timeout) || 120, 10), 600)
    const displayHost = host.includes(":") ? `[${host}]` : host
    const base = ((argv["public-url"] as string) || `http://${displayHost}:${port}`).replace(/\/+$/, "")
    const loopback = LOOPBACK.has(host)
    if (!loopback) {
      console.error(`Warning: binding ${host} — this agent is reachable beyond this machine. The bearer token is the only gate.`)
    }

    const name = echo ? undefined : await agentName(agentId!)
    const card = buildAgentCard({ rpcUrl: `${base}/a2a`, agentId: agentId ?? 0, agentName: name, echo })
    const execute = echo ? echoExecutor : irisAgentExecutor({ agentId: agentId!, timeoutSecs })
    const handler = createA2AHandler({
      card,
      execute,
      token,
      rpcPath: "/a2a",
      // DNS-rebinding guard, as `mcp serve --http` does: on loopback only our own Host names.
      allowedHosts:
        loopback && !argv["public-url"]
          ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
          : undefined,
    })
    const server = Bun.serve({ hostname: host, port, idleTimeout: 0, fetch: handler.fetch })

    console.log(`IRIS A2A agent on ${base}  (${A2A_SPEC_PIN})`)
    console.log(`Agent card: ${base}/.well-known/agent-card.json`)
    console.log(`JSON-RPC:   ${base}/a2a`)
    console.log(`Authorization: Bearer ${token}`)
    console.log(echo ? "Executor: ECHO TEST MODE — no IRIS agent is consulted" : `Executor: ${card.name}`)

    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve)
      process.on("SIGTERM", resolve)
    })
    server.stop(true)
  },
})

export const A2aCallCommand = cmd({
  command: "call <url> <text>",
  describe: "send a task to an A2A v1.0 agent and print its answer",
  builder: (yargs) =>
    yargs
      .positional("url", { type: "string", demandOption: true, describe: "agent base URL, or the URL of its agent-card.json" })
      .positional("text", { type: "string", demandOption: true, describe: "the message to send" })
      .option("token", { type: "string", describe: "bearer token (default: $IRIS_A2A_TOKEN)" })
      .option("stream", { type: "boolean", default: false, describe: "use SendStreamingMessage and print chunks as they arrive" })
      .option("context", { type: "string", describe: "contextId to continue a conversation" })
      .option("json", { type: "boolean", default: false, describe: "print the raw Task (or Message) as JSON" }),
  async handler(argv) {
    const asJson = argv.json === true
    const stream = argv.stream === true
    let streamedText = false
    try {
      const result = await a2aCall({
        url: argv.url as string,
        text: argv.text as string,
        token: (argv.token as string) || process.env.IRIS_A2A_TOKEN || undefined,
        stream,
        contextId: argv.context as string | undefined,
        onEvent: (ev) => {
          if (asJson || !ev.artifactUpdate) return
          for (const p of ev.artifactUpdate.artifact?.parts ?? []) {
            if (typeof p.text === "string" && p.text) {
              process.stdout.write(p.text)
              streamedText = true
            }
          }
        },
      })
      if (asJson) console.log(JSON.stringify(result.task ?? result.message, null, 2))
      else if (streamedText) process.stdout.write("\n")
      else console.log(result.text)
      const state = result.task?.status?.state
      if (state && state !== "TASK_STATE_COMPLETED") {
        if (!asJson) console.error(`Task ended ${state}`)
        process.exitCode = 1
      }
    } catch (e) {
      const msg = e instanceof A2AError || e instanceof Error ? e.message : String(e)
      console.error(`Error: ${msg}`)
      process.exitCode = 1
    }
  },
})

export const A2aCommand = cmd({
  command: "a2a",
  describe: "A2A (Agent2Agent) protocol — serve an IRIS agent, or call another agent",
  builder: (yargs) => yargs.command(A2aServeCommand).command(A2aCallCommand).demandCommand(),
  async handler() {},
})
