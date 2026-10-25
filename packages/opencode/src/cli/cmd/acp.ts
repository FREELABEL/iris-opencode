import { Log } from "@/util/log"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACP_AGENTS, agentInstalled, resolveAgentCommand, runAcpAgent, type PermissionPolicy } from "@/acp/client"
import * as readline from "node:readline/promises"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server — or drive another agent with `acp run`",
  builder: (yargs) => {
    return withNetworkOptions(yargs)
      .command(AcpRunCommand)
      .command(AcpAgentsCommand)
      .option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const opts = await resolveNetworkOptions(args)
      const server = Server.listen(opts)

      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
      })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          process.stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          process.stdin.on("end", () => controller.close())
          process.stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = await ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        return agent.create(conn, { sdk })
      }, stream)

      log.info("setup connection")
      process.stdin.resume()
      await new Promise((resolve, reject) => {
        process.stdin.on("end", resolve)
        process.stdin.on("error", reject)
      })
    })
  },
})

/**
 * IRIS as the ACP *client* (#191163): start a real coding agent — Claude Code, Codex, Gemini,
 * opencode, IRIS — and drive it over the protocol. `iris acp` (above) is the other direction.
 */
export const AcpRunCommand = cmd({
  command: "run <prompt..>",
  describe: "run a coding agent (claude, codex, gemini, opencode, iris) over ACP: streams its answer, shows its diffs, asks before risky steps",
  builder: (yargs) =>
    yargs
      .positional("prompt", { type: "string", array: true, demandOption: true, describe: "what to ask the agent" })
      .option("agent", {
        alias: "a",
        type: "string",
        default: "auto",
        describe: "claude | codex | gemini | opencode | iris | auto | a raw command line that speaks ACP",
      })
      .option("cwd", { type: "string", default: process.cwd(), describe: "working directory the agent may read and write" })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "allow each permission request once, without asking" })
      .option("no", { type: "boolean", default: false, describe: "deny every permission request (read-only run)" })
      .option("json", { type: "boolean", default: false, describe: "print raw ACP updates as JSON lines" })
      .option("thoughts", { type: "boolean", default: false, describe: "also print the agent's thinking" }),
  handler: async (args) => {
    const { spec, argv, missing } = resolveAgentCommand(String(args.agent), (b) => Bun.which(b))
    if (missing) {
      console.error(`✗ ${spec?.name ?? argv[0]}: \`${missing}\` is not installed.`)
      if (spec) console.error(`  install: ${spec.install}`)
      console.error("  see what is installed: iris acp agents")
      process.exitCode = 1
      return
    }
    const interactive = process.stdin.isTTY && !args.json
    const policy: PermissionPolicy = args.no ? "deny" : args.yes ? "allow" : interactive ? "ask" : "deny"
    if (policy === "deny" && !args.no && !args.json)
      console.error("· not a terminal: permission requests are denied (pass --yes to allow them once)")

    const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stderr }) : undefined
    const abort = new AbortController()
    let interrupts = 0
    const onSigint = () => {
      if (++interrupts > 1) process.exit(130)
      console.error("\n· cancelling (Ctrl-C again to quit)")
      abort.abort()
    }
    process.on("SIGINT", onSigint)
    if (!args.json) console.error(`· ${spec?.name ?? argv.join(" ")} over ACP in ${args.cwd}`)
    try {
      const res = await runAcpAgent({
        argv,
        prompt: (args.prompt as string[]).join(" "),
        cwd: String(args.cwd),
        policy,
        ask: (q) => rl!.question(q),
        write: (t) => process.stdout.write(t),
        json: Boolean(args.json),
        thoughts: Boolean(args.thoughts),
        signal: abort.signal,
      })
      if (!args.json) console.error(`· ${res.agent ?? spec?.name ?? "agent"} stopped: ${res.stopReason}`)
      if (res.stopReason === "refusal") process.exitCode = 1
      if (res.stopReason === "cancelled") process.exitCode = 130
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err)
      console.error(`✗ ${spec?.name ?? argv[0]}: ${msg}`)
      if (/auth/i.test(msg)) console.error(`  sign in to ${spec?.name ?? "the agent"} in its own CLI first, then retry`)
      process.exitCode = 1
    } finally {
      process.off("SIGINT", onSigint)
      rl?.close()
    }
  },
})

export const AcpAgentsCommand = cmd({
  command: "agents",
  describe: "list the coding agents this machine can drive over ACP, and how to install the rest",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  handler: async (args) => {
    const rows = ACP_AGENTS.map((a) => ({ ...a, installed: agentInstalled(a, (b) => Bun.which(b)) }))
    if (args.json) {
      console.log(JSON.stringify(rows.map(({ id, name, command, installed, install }) => ({ id, name, command, installed, install }))))
      return
    }
    for (const r of rows) {
      console.log(`  ${r.installed ? "✓" : "·"} ${r.id.padEnd(9)} ${r.name.padEnd(12)} ${r.installed ? r.command.join(" ") : `not installed — ${r.install}`}`)
      if (r.note) console.log(`    ${" ".repeat(22)}${r.note}`)
    }
    console.log(`\n  run one:  iris acp run --agent <id> "<prompt>"`)
  },
})
