import { cmd } from "./cmd"
import { homedir, hostname, userInfo } from "os"
import { readFileSync, rmSync } from "fs"
import { join } from "path"
import { spawn } from "child_process"
import { dispatchTaskAndWait } from "./platform-hive-nodes"
import { fromHiveTask } from "./hive-script-result"
import { prepareRelayRunner } from "./platform-hive-tunnel"
import { parseRunnerLine } from "./platform-hive-relay"
import { shq } from "./hive-tailscale"
import {
  GATE_IDLE_MS,
  gateDir,
  gateStatePath,
  gateTunnelName,
  issueTicket,
  lastTicketAt,
  parseGateOffer,
  proxyConnect,
  readGateState,
  spawnGate,
  startGate,
  writeGateState,
  type GateOffer,
  type GateState,
} from "./hive-relay-ssh"

/**
 * `iris hive ssh-gate` — the plumbing under `iris hive ssh` over the Hive relay (#191650).
 * Not for people: `issue` and `serve` run on the node, `connect` is ssh's ProxyCommand.
 * See hive-relay-ssh.ts for the design and the security model.
 */

const OFFER = "HIVE-GATE-OFFER"
const say = (o: object) => console.log(`${OFFER} ${JSON.stringify(o)}`)

const Serve = cmd({
  command: "serve",
  describe: "run this machine's ssh gate and its relay tunnel until idle",
  builder: (y) => y.option("name", { type: "string" }),
  async handler(argv) {
    const home = homedir()
    const name = String(argv.name || gateTunnelName(hostname()))
    const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`)
    let last = Date.now()
    const gate = await startGate({ home, name, onActivity: () => (last = Date.now()), log })
    const state: GateState = { pid: process.pid, name, host: null, gate_port: gate.port, ready: false, started_at: new Date().toISOString() }
    const fail = (error: string) => {
      writeGateState(home, { ...state, error })
      log(`error: ${error}`)
      process.exit(1)
    }
    const prep = await prepareRelayRunner(name, gate.port)
    if (!prep.ok) return fail(prep.error)
    state.host = new URL(prep.url).host
    writeGateState(home, state)
    const child = spawn(prep.node, ["--no-warnings", ...prep.args], { env: prep.env, stdio: ["ignore", "pipe", "pipe"] })
    let buf = ""
    child.stdout.on("data", (d) => {
      buf += String(d)
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const ev = parseRunnerLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (!ev) continue
        log(`runner ${JSON.stringify(ev)}`)
        if ((ev.event === "ready" && ev.certificate === "saved") || ev.event === "cert") {
          state.ready = true
          writeGateState(home, state)
        } else if (ev.event === "error" && ev.final) {
          child.kill()
          fail(ev.message)
        }
      }
    })
    child.stderr.on("data", (d) => log(`runner stderr: ${String(d).trim()}`))
    const stop = (why: string) => {
      log(`stopping: ${why}`)
      child.kill("SIGTERM")
      gate.close()
      rmSync(gateStatePath(home, name), { force: true })
      process.exit(0)
    }
    child.on("exit", (code) => stop(`relay runner exited (${code})`))
    process.on("SIGTERM", () => stop("SIGTERM"))
    process.on("SIGINT", () => stop("SIGINT"))
    setInterval(() => {
      if (gate.active() === 0 && Date.now() - Math.max(last, lastTicketAt(home, name)) > GATE_IDLE_MS) stop("idle")
    }, 30_000)
    await new Promise(() => {})
  },
})

function gateError(home: string, name: string): string | null {
  try {
    const s = JSON.parse(readFileSync(gateStatePath(home, name), "utf8")) as GateState
    if (s.error) return s.error
  } catch {}
  try {
    const tail = readFileSync(join(gateDir(home, name), "gate.log"), "utf8").trim().split("\n").slice(-3).join(" | ")
    return tail ? `the gate stopped: ${tail}` : null
  } catch {
    return null
  }
}

const Issue = cmd({
  command: "issue",
  describe: "start the gate if needed and print a single-use ticket for it",
  builder: (y) => y.option("wait", { type: "number", default: 120, describe: "seconds to wait for the relay tunnel" }),
  async handler(argv) {
    const home = homedir()
    const name = gateTunnelName(hostname())
    let st = readGateState(home, name)
    let spawnedAt = 0
    if (!st) {
      rmSync(gateStatePath(home, name), { force: true })
      spawnGate(home, name)
      spawnedAt = Date.now()
    }
    const deadline = Date.now() + Number(argv.wait) * 1000
    while (!(st && st.ready && st.host)) {
      if (Date.now() > deadline) {
        say({ error: `the relay tunnel for ${name} was not ready after ${argv.wait}s (${gateError(home, name) ?? "no log"})` })
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 500))
      st = readGateState(home, name)
      if (!st && spawnedAt && Date.now() - spawnedAt > 5000) {
        say({ error: gateError(home, name) ?? "the gate did not start" })
        process.exit(1)
      }
    }
    say({ v: 1, name, host: st.host, ticket: issueTicket(home, name), user: userInfo().username })
  },
})

const Connect = cmd({
  command: "connect <host>",
  describe: "ssh ProxyCommand: TLS to the node's gate through the relay, ticket from IRIS_HIVE_GATE_TICKET",
  builder: (y) => y.positional("host", { type: "string", demandOption: true }),
  async handler(argv) {
    const ticket = process.env.IRIS_HIVE_GATE_TICKET
    if (!ticket) {
      process.stderr.write("iris hive ssh-gate connect: no IRIS_HIVE_GATE_TICKET (run it through `iris hive ssh`)\n")
      process.exit(2)
    }
    process.exit(await proxyConnect({ host: String(argv.host), ticket, relayAddr: process.env.HIVE_RELAY_ADDR }))
  },
})

export const HiveSshGateCommand = cmd({
  command: "ssh-gate",
  describe: false as unknown as string, // plumbing for `iris hive ssh` over the relay
  builder: (y) => y.command(Serve).command(Issue).command(Connect).demandCommand(1),
  handler() {},
})

/**
 * On A: ask node B for a gate ticket, as a Hive task (the platform only dispatches it for B's
 * owner and attached users — that is the membership check). B's CLI must have `ssh-gate`.
 */
export async function requestGateOffer(userId: number, nodeId: string): Promise<GateOffer | { error: string }> {
  const remote = process.env.IRIS_HIVE_REMOTE_CLI
  const bin = remote ? shq(remote) : '"$HOME/.iris/bin/iris"'
  const script = [
    "#!/bin/bash",
    `IRIS_BIN=${bin}`,
    '[ -x "$IRIS_BIN" ] || IRIS_BIN="$(command -v iris)"',
    '"$IRIS_BIN" hive ssh-gate issue',
  ].join("\n")
  const { taskId, final } = await dispatchTaskAndWait(userId, {
    user_id: userId,
    title: "iris hive ssh: open the relay gate",
    type: "sandbox_execute",
    node_id: nodeId,
    prompt: script,
    config: { timeout_seconds: 150 },
    timeout_seconds: 150,
  })
  if (!final) return { error: `the node did not answer in time (task ${taskId})` }
  const out = fromHiveTask(final as any)
  const offer = parseGateOffer(`${out.stdout ?? ""}\n${out.stderr ?? ""}`)
  if (offer) return offer
  return { error: `the node's iris CLI has no ssh gate — update it (iris hive rollout), then retry (task ${taskId})` }
}
