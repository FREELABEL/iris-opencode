import { Log } from "@/util/log"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACP_AGENTS, AcpSession, agentInstalled, resolveAgentCommand, type PermissionPolicy } from "@/acp/client"
import { listHolders, startHolder, type Holder } from "@/acp/holder"
import * as readline from "node:readline/promises"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server — or drive another agent with `acp run`",
  builder: (yargs) => {
    return withNetworkOptions(yargs)
      .command(AcpRunCommand)
      .command(AcpAgentsCommand)
      .command(AcpSessionsCommand)
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
 * With --keep the session stays up and is reachable from Hive (#191170).
 */
export const AcpRunCommand = cmd({
  command: "run [prompt..]",
  describe: "run a coding agent (claude, codex, gemini, opencode, iris) over ACP: streams its answer, shows its diffs, asks before risky steps",
  builder: (yargs) =>
    yargs
      .positional("prompt", { type: "string", array: true, describe: "what to ask the agent (optional with --keep)" })
      .option("agent", {
        alias: "a",
        type: "string",
        default: "auto",
        describe: "claude | codex | gemini | opencode | iris | auto | a raw command line that speaks ACP",
      })
      .option("cwd", { type: "string", default: process.cwd(), describe: "working directory the agent may read and write" })
      .option("keep", {
        alias: "k",
        type: "boolean",
        default: false,
        describe: "keep the session open after the first turn: type follow-ups here, and reach it from any machine with iris hive send-input / ask / answer",
      })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "allow each permission request once, without asking" })
      .option("no", { type: "boolean", default: false, describe: "deny every permission request (read-only run)" })
      .option("json", { type: "boolean", default: false, describe: "print raw ACP updates as JSON lines" })
      .option("thoughts", { type: "boolean", default: false, describe: "also print the agent's thinking" })
      .example('$0 acp run --agent claude "add a test for the parser"', "Claude Code under your own login; asks before each edit")
      .example('$0 acp run --agent codex --no "explain src/server.ts"', "read-only: every permission request is denied")
      .example('$0 acp run --agent gemini --json "…"', "raw ACP updates as JSON lines, for scripts")
      .example('$0 acp run --keep --agent claude "fix the flaky test"', "stays open: type follow-ups, or steer it from any machine with iris hive ask / answer")
      .example("$0 acp agents", "which agents are installed, and how to install the rest"),
  handler: async (args) => {
    const prompt = ((args.prompt as string[] | undefined) ?? []).join(" ").trim()
    const keep = Boolean(args.keep)
    if (!prompt && !keep) {
      console.error('✗ nothing to ask. iris acp run --agent claude "<prompt>"   (or --keep to open a session)')
      process.exitCode = 1
      return
    }
    const { spec, argv, missing } = resolveAgentCommand(String(args.agent), (b) => Bun.which(b))
    if (missing) {
      console.error(`✗ ${spec?.name ?? argv[0]}: \`${missing}\` is not installed.`)
      if (spec) console.error(`  install: ${spec.install}`)
      console.error("  see what is installed: iris acp agents")
      process.exitCode = 1
      return
    }
    const tty = Boolean(process.stdin.isTTY) && !args.json
    // A kept session with no terminal still asks: the question waits for `iris hive answer`.
    const policy: PermissionPolicy = args.no ? "deny" : args.yes ? "allow" : tty || keep ? "ask" : "deny"
    if (policy === "deny" && !args.no && !args.json)
      console.error("· not a terminal: permission requests are denied (pass --yes to allow them once)")

    const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stderr }) : undefined
    const label = spec?.name ?? argv.join(" ")
    const session = new AcpSession({
      argv,
      cwd: String(args.cwd),
      policy,
      write: (t) => process.stdout.write(t),
      ask: rl ? (q, signal) => rl.question(q, { signal }) : undefined,
      json: Boolean(args.json),
      thoughts: Boolean(args.thoughts),
    })

    let holder: Holder | undefined
    let closing = false
    let idleAbort: AbortController | undefined
    let interrupts = 0
    const finish = async (code?: number) => {
      if (closing) return
      closing = true
      idleAbort?.abort()
      holder?.stop()
      rl?.close()
      await session.close()
      if (code !== undefined) process.exitCode = code
    }
    const onSigint = () => {
      if (session.busy && interrupts++ === 0) {
        console.error("\n· cancelling the turn (Ctrl-C again to quit)")
        session.cancel()
        return
      }
      void finish(130).then(() => process.exit(130))
    }
    const onSigterm = () => void finish(143).then(() => process.exit(143))
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)
    session.onTurnStart(() => {
      interrupts = 0
      idleAbort?.abort()
    })

    if (!args.json) console.error(`· ${label} over ACP in ${args.cwd}`)
    try {
      await session.start()
      if (keep) {
        holder = startHolder(session, { agent: spec?.id ?? argv[0], cwd: String(args.cwd) })
        if (!args.json) {
          console.error(`· session ${session.sessionId} is open — reachable from Hive:`)
          console.error(`    iris hive ask ${session.sessionId.slice(-8)} "<message>"   ·   iris hive answer ${session.sessionId.slice(-8)} <choice>`)
          console.error(tty ? "· type a follow-up below; Ctrl-D closes the session" : "· no terminal: running until stopped (SIGTERM)")
        }
      }
      let lastStop = ""
      if (prompt) lastStop = await session.prompt(prompt)
      if (!keep) {
        if (!args.json) console.error(`· ${session.agentName ?? label} stopped: ${lastStop}`)
        if (lastStop === "refusal") process.exitCode = 1
        if (lastStop === "cancelled") process.exitCode = 130
        return
      }
      if (!rl) {
        await new Promise<void>(() => {}) // until a signal ends it
        return
      }
      let eof = false
      rl.on("close", () => {
        eof = true
        idleAbort?.abort()
      })
      while (!closing && !eof) {
        await session.idle()
        if (session.status === "waiting") {
          await new Promise((r) => setTimeout(r, 200))
          continue
        }
        idleAbort = new AbortController()
        let line: string
        try {
          line = await rl.question("› ", { signal: idleAbort.signal })
        } catch {
          continue // a turn started from Hive, or the terminal closed
        }
        if (!line.trim()) continue
        try {
          await session.prompt(line)
        } catch (err) {
          console.error(`✗ ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err)
      console.error(`✗ ${label}: ${msg}`)
      if (/auth/i.test(msg)) console.error(`  sign in to ${label} in its own CLI first, then retry`)
      process.exitCode = 1
    } finally {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      await finish()
    }
  },
})

export const AcpSessionsCommand = cmd({
  command: "sessions",
  describe: "list ACP sessions kept open on this machine (iris acp run --keep)",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .example("$0 acp sessions", "what is open here; across all your machines: iris hive sessions"),
  handler: async (args) => {
    const rows = listHolders().map(({ token: _t, port: _p, ...r }) => r)
    if (args.json) return void console.log(JSON.stringify(rows))
    if (!rows.length) return void console.log('  no open ACP sessions. Start one: iris acp run --keep --agent claude "<prompt>"')
    for (const r of rows)
      console.log(
        `  ${r.status === "waiting" ? "?" : r.status === "working" ? "▸" : "·"} ${r.session_id.padEnd(38)} ${String(r.agent_name ?? r.agent).padEnd(14)} ${r.status.padEnd(8)} ${r.name}`,
      )
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
