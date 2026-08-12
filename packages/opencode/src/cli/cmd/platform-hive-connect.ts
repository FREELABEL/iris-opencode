import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, bold, success, highlight, requireAuth, resolveUserId } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { join } from "path"
import { homedir, hostname, platform, arch, cpus, totalmem } from "os"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { execSync } from "child_process"
import { createHash } from "crypto"

// ============================================================================
// iris hive connect  —  enroll THIS machine, outbound, in one command
//
// The counterpart to `iris hive enroll`, and deliberately the opposite direction.
//
//   hive enroll <user@ip>   you SSH INTO the box.   Needs a routable address,
//                           an SSH user and key auth. Inbound.
//   hive connect            you run it ON the box.  Needs nothing but egress.
//
// That difference is the whole point. `enroll` cannot onboard a machine you
// cannot already reach — behind NAT, CGNAT, a corporate firewall, or a laptop
// that moves networks. `hive vpn` solves that by putting Tailscale underneath,
// which is excellent but is its own account, install, login and (as of Aug 2026,
// the hard way) its own paid plan that can lapse and silently log a host out.
//
// `hive connect` needs none of it. The daemon already dials OUT — it authenticates
// to iris-api and subscribes to Pusher on private-node.{nodeId} — so a firewall-
// friendly control plane already exists. This command is the missing bootstrap
// over machinery that already works:
//
//   curl -fsSL https://heyiris.io/install-code | bash   # if iris isn't here yet
//   iris hive connect                                   # ← this
//
// Register outbound, persist the node key, start the daemon, confirm it came
// online. No SSH. No VPN. No open ports.
// ============================================================================

const CONFIG_DIR = join(homedir(), ".iris")
const CONFIG_PATH = join(CONFIG_DIR, "config.json")

/**
 * A stable id for THIS physical machine, hashed. (#179932)
 *
 * Node identity on the server was the api_key, and a reinstall throws the api_key away — so
 * re-registering produced a SECOND node for the same computer and orphaned the first. Eight
 * rows for two machines in production, two of them sharing a name, and no way to answer
 * "which node am I".
 *
 * Hostname cannot fix it: on macOS os.hostname() returns LocalHostName, which the OS
 * INCREMENTS on every mDNS collision, so one laptop reported three different names in a
 * single run. The value has to come from the hardware, not the network.
 *
 * ALWAYS HASHED. The raw values below are real hardware/install identifiers, and a hardware
 * UUID is the kind of thing that should never leave a machine in the clear or end up in a
 * log. sha256 keeps it stable and comparable while making it useless as an identifier
 * anywhere else. The server only ever needs equality.
 *
 * Returns undefined when nothing stable is available, and that is a supported outcome — the
 * server treats a missing fingerprint as "create a new node", i.e. exactly today's behaviour.
 * A GUESSED fingerprint would be far worse than none: two machines colliding on a weak value
 * would silently share one node row.
 */
function machineFingerprint(): string | undefined {
  const read = (cmd: string): string | undefined => {
    try {
      const out = execSync(cmd, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim()
      return out || undefined
    } catch {
      return undefined
    }
  }

  let raw: string | undefined
  const os = platform()

  if (os === "darwin") {
    // IOPlatformUUID — burned into the hardware, survives OS reinstalls.
    raw = read(`ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}'`)
  } else if (os === "linux") {
    // machine-id is per-INSTALL rather than per-hardware, which is the right granularity
    // here: a reimaged box genuinely is a new node.
    raw = read("cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null")
  } else if (os === "win32") {
    raw = read(
      'powershell -NoProfile -Command "(Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid"',
    )
  }

  if (!raw) return undefined

  // Salted with the platform so the same string on two OSes cannot collide, and so the
  // digest is not a plain hash of a value someone else could also compute and assert.
  return createHash("sha256").update(`iris-node:${os}:${raw}`).digest("hex")
}

interface IrisConfig {
  /** Which node this machine IS. Read by hive-local-node.ts to answer "(you)" with
   *  certainty rather than guessing from a hostname that mutates. */
  node_id?: string
  node_api_key?: string
  local_api_key?: string
  user_id?: number
  [k: string]: unknown
}

function readConfig(): IrisConfig {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as IrisConfig
  } catch {
    // A corrupt config must not read as "no config" — that would silently mint a
    // duplicate node and orphan whatever key is already in the file.
    throw new Error(`${CONFIG_PATH} exists but is not valid JSON — fix or move it, then re-run.`)
  }
}

// MERGE, never overwrite. The file also carries local_api_key, pusher config and
// the paused flag; clobbering it would break a working bridge to fix an unrelated thing.
function writeConfig(patch: IrisConfig): void {
  const merged = { ...readConfig(), ...patch }
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
}

function daemonCtl(): string | null {
  const p = join(CONFIG_DIR, "bin", `iris-daemon${platform() === "win32" ? ".cmd" : ""}`)
  return existsSync(p) ? p : null
}

function installHint(): string {
  return platform() === "win32"
    ? "irm https://heyiris.io/install-code.ps1 | iex"
    : "curl -fsSL https://heyiris.io/install-code | bash"
}

function detectCapabilities(): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    os: platform(),
    arch: arch(),
    cpus: cpus().length,
    memory_gb: Math.round(totalmem() / 1024 ** 3),
  }
  // Report which coding agents are actually present. The whole reason to connect a
  // box is to drive one of these remotely, so a node advertising none is a useful
  // signal rather than a silent surprise at dispatch time.
  const agents = ["claude", "codex", "opencode", "iris"].filter((bin) => {
    try {
      execSync(platform() === "win32" ? `where ${bin}` : `command -v ${bin}`, {
        stdio: "ignore",
        timeout: 3000,
      })
      return true
    } catch {
      return false
    }
  })
  caps.agents = agents
  caps.docker = (() => {
    try {
      execSync("docker info", { stdio: "ignore", timeout: 5000 })
      return true
    } catch {
      return false
    }
  })()
  return caps
}

const HiveConnectCommand = cmd({
  command: "connect",
  describe: "enroll THIS machine as a Hive node — outbound, no SSH or VPN required",
  builder: (y) =>
    y
      .option("name", { describe: "node name (defaults to this machine's hostname)", type: "string" })
      .option("max-concurrent", { describe: "max simultaneous tasks (1-20)", type: "number", default: 2 })
      .option("no-daemon", { describe: "register only; don't start the daemon", type: "boolean", default: false })
      .option("force", { describe: "register again even if this machine already has a node key", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve your IRIS user id. Run: iris auth login")
      return
    }

    let config: IrisConfig
    try {
      config = readConfig()
    } catch (e: any) {
      prompts.log.error(e.message)
      return
    }

    if (config.node_api_key && !args.force) {
      prompts.log.warn("This machine already has a node key in ~/.iris/config.json.")
      prompts.log.info(`Check it:      ${dim("iris hive nodes")}`)
      prompts.log.info(`Daemon state:  ${dim("iris daemon status")}`)
      prompts.log.info(`Register anew: ${dim("iris hive connect --force")}`)
      return
    }

    const name = args.name || hostname()
    const capabilities = detectCapabilities()

    const sp = prompts.spinner()
    sp.start(`Registering ${bold(name)}…`)

    const res = await hiveFetch("/api/v6/nodes", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        name,
        // Lets the server reclaim this machine's existing row instead of minting a ghost
        // on every reinstall (#179932). Omitted entirely when unavailable.
        ...(machineFingerprint() ? { machine_fingerprint: machineFingerprint() } : {}),
        // THE TRANSITION CASE, and it is not hypothetical — it cost one ghost node per
        // machine when the fingerprint first shipped. A node registered BEFORE fingerprints
        // existed has a null one stored, and a null never matches, so the first
        // fingerprint-aware registration could only create a new row and abandon the old.
        //
        // The key we currently hold is proof we ARE that node — it is the node's own bearer
        // credential — so sending it lets the server adopt that row and stamp the
        // fingerprint onto it. After one registration every machine is self-identifying and
        // this field stops mattering.
        ...(config.node_api_key ? { previous_node_api_key: config.node_api_key } : {}),
        capabilities,
        max_concurrent: Math.max(1, Math.min(20, Math.round(args["max-concurrent"] ?? 2))),
      }),
    })

    if (!res.ok) {
      sp.stop("Registration failed", 1)
      const body = await res.text().catch(() => "")
      prompts.log.error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`)
      return
    }

    const data = (await res.json()) as any
    const apiKey: string | undefined = data?.credentials?.api_key
    const nodeId: string | undefined = data?.node?.id

    if (!apiKey) {
      sp.stop("Registered, but no key returned", 1)
      prompts.log.error("The API did not return credentials.api_key — cannot start the daemon without it.")
      return
    }

    // Persist BEFORE starting the daemon. The key is returned exactly once; if we
    // crashed between here and the daemon start it would be unrecoverable.
    //
    // On --force there is an existing key for a still-registered node. Overwriting it
    // outright would strand that node — it stays in the account but nothing on this
    // machine can authenticate as it again, and the running daemon breaks on restart.
    // Keep the old one so it can be put back.
    const previousKey = config.node_api_key
    writeConfig({
      node_api_key: apiKey,
      user_id: userId,
      // Persist WHICH node this machine is, not just how it authenticates.
      //
      // hive-local-node.ts reads `node_id` from this file as its second-most-authoritative
      // source, and its header note says "if anything ever writes it" — nothing did. So
      // whenever the daemon was not running to answer /health, resolution fell through to
      // matching os.hostname(), which on macOS is LocalHostName and gets INCREMENTED by the
      // OS on every mDNS collision. That is why the node list printed "(you?)" with a
      // question mark instead of "(you)".
      //
      // The value was already in hand — the registration response returns node.id and it was
      // simply dropped on the floor. Writing it makes local-node identity certain even with
      // the daemon down, which is exactly when someone is most likely to be debugging.
      ...(nodeId ? { node_id: nodeId } : {}),
      ...(previousKey && previousKey !== apiKey ? { node_api_key_previous: previousKey } : {}),
    })
    sp.stop(success(`Registered ${bold(name)}`))

    if (args.json) {
      console.log(JSON.stringify({ node_id: nodeId, name, capabilities, daemon_started: !args["no-daemon"] }))
      return
    }

    console.log(`  ${dim("Node:")}          ${name}${nodeId ? dim(`  (${nodeId})`) : ""}`)
    console.log(`  ${dim("OS / arch:")}     ${capabilities.os} / ${capabilities.arch}`)
    const agents = capabilities.agents as string[]
    console.log(`  ${dim("Agents found:")}  ${agents.length ? agents.join(", ") : dim("none — install one to run coding tasks here")}`)
    console.log(`  ${dim("Key saved to:")}  ${CONFIG_PATH}`)
    if (previousKey && previousKey !== apiKey) {
      prompts.log.warn(
        `Replaced this machine's existing node key. The previous node is still registered but can no longer authenticate from here — remove it with ${dim("iris hive nodes")}, or restore the old key from ${dim("node_api_key_previous")} in ${CONFIG_PATH}.`,
      )
    }

    if (args["no-daemon"]) {
      prompts.log.info(`Registered only. Start it when ready: ${dim("iris daemon start")}`)
      prompts.outro("Done")
      return
    }

    const ctl = daemonCtl()
    if (!ctl) {
      prompts.log.warn(`Daemon binary not found. Install it: ${dim(installHint())}`)
      prompts.log.info(`Then run: ${dim("iris daemon start")}`)
      prompts.outro("Done")
      return
    }

    const sp2 = prompts.spinner()
    sp2.start("Starting daemon…")
    try {
      execSync(`${ctl} start 2>&1`, { timeout: 20000 })
    } catch {
      // Non-fatal: registration already succeeded, so the useful state is saved.
      sp2.stop("Daemon did not start", 1)
      prompts.log.warn(`Start it manually: ${dim("iris daemon start")}  ·  diagnose: ${dim("iris hive doctor")}`)
      prompts.outro("Done")
      return
    }

    // Confirm the node actually reached the cloud, rather than trusting that a
    // process launched. "Started" and "connected" are different claims.
    sp2.message("Waiting for the node to come online…")
    let online = false
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const check = await hiveFetch(`/api/v6/nodes/?user_id=${userId}`)
      if (check.ok) {
        const list = (await check.json()) as any
        const nodes = list?.nodes ?? list?.data ?? []
        const me = nodes.find((n: any) => n.id === nodeId || n.name === name)
        if (me && (me.connection_status === "online" || me.status === "online")) {
          online = true
          break
        }
      }
    }

    if (online) {
      sp2.stop(success("Node is online"))
    } else {
      sp2.stop("Daemon started, but the node hasn't reported in yet", 1)
      prompts.log.info(`Give it a moment, then: ${dim("iris hive nodes")}  ·  ${dim("iris hive doctor")}`)
    }

    console.log()
    console.log(`  ${bold("This machine is now controllable from anywhere.")}`)
    console.log(`  ${dim("Run a command:")}   ${highlight(`iris hive run ${name} "ls ~"`)}`)
    console.log(`  ${dim("See the fleet:")}   ${highlight("iris hive board")}`)
    console.log(`  ${dim("Send it work:")}    ${highlight("iris hive tasks")}`)
    prompts.outro("Done")
  },
})

export const HiveConnectCommandExport = HiveConnectCommand
