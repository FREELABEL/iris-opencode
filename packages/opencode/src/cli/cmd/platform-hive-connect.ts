import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, bold, success, highlight, requireAuth } from "./iris-api"
import { join } from "path"
import { homedir, platform } from "os"
import { existsSync } from "fs"
import { execSync } from "child_process"
import { ensureNodeOnPath } from "../lib/node-path"
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
const BRIDGE_DIR = join(CONFIG_DIR, "bridge")

// ONE WRITER (#185896). This command used to register the machine and write the node key itself —
// one of ELEVEN places across two repos that minted node keys, through two endpoints, most with no
// machine fingerprint. A client ended up holding a key the hub had never issued, and every sign-in
// surface said "authenticated" while Hive 401'd. The daemon now owns enrollment: on start, with no
// key or a rejected one, it registers from the signed-in account. So "connect" means: be signed in,
// have a daemon that can enroll itself, and (re)start it. Nothing here touches the node key.

/** Does the installed daemon enroll itself? Older copies cannot, and must be updated first. */
function daemonSelfEnrolls(): boolean {
  return existsSync(join(BRIDGE_DIR, "daemon", "node-key-heal.js"))
}

async function localNodeId(): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const h = (await res.json()) as any
    return typeof h?.node_id === "string" && h.node_id ? h.node_id : null
  } catch {
    return null
  }
}

function irisBin(): string {
  const installed = join(CONFIG_DIR, "bin", `iris${platform() === "win32" ? ".exe" : ""}`)
  return existsSync(installed) ? installed : process.execPath
}

/**
 * Bring this machine online in Hive. Used by `hive connect` and by sign-in (`iris auth login`).
 * Never mints a key. Returns the node id once online, or null.
 */
export async function wakeHiveNode(opts: { quiet?: boolean; restart?: boolean } = {}): Promise<string | null> {
  ensureNodeOnPath() // the desktop app runs this with a GUI PATH that has no node
  const say = (m: string) => {
    if (!opts.quiet) prompts.log.info(m)
  }
  if (!opts.restart) {
    const id = await localNodeId()
    if (id) return id
  }
  if (!daemonSelfEnrolls()) {
    say("Updating the Hive daemon on this machine…")
    try {
      execSync(`"${irisBin()}" node install`, { env: process.env, stdio: opts.quiet ? "ignore" : "inherit", timeout: 600000 })
    } catch {
      /* fall through — the start below reports what is still wrong */
    }
  }
  const ctl = daemonCtl()
  if (!ctl) return null
  try {
    if (platform() === "win32") {
      execSync(`"${ctl}" stop`, { env: process.env, stdio: "ignore", timeout: 30000 })
      execSync(`"${ctl}" start`, { env: process.env, stdio: "ignore", timeout: 30000 })
    } else {
      execSync(`"${ctl}" restart`, { env: process.env, stdio: "ignore", timeout: 30000 })
    }
  } catch {
    /* the wait below is the real check */
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const id = await localNodeId()
    if (id) return id
  }
  return null
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

const HiveConnectCommand = cmd({
  command: "connect",
  describe: "bring THIS machine online as a Hive node — outbound, no SSH or VPN required",
  builder: (yargs) =>
    yargs
      .option("force", { describe: "restart the daemon even if this machine is already online", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const token = await requireAuth()
    if (!token) return
    ensureNodeOnPath()

    if (!daemonCtl() && !daemonSelfEnrolls()) {
      // #184597 — say WHY the daemon is missing, or this advice is a LOOP.
      //
      // On Windows the installer skips the bridge when Node.js is absent, then prints success;
      // pointing back at the installer sends the user round the same circle. Name Node.js.
      let hasNode = true
      try {
        execSync(platform() === "win32" ? "where node" : "command -v node", { env: process.env, stdio: "ignore", timeout: 3000 })
      } catch {
        hasNode = false
      }
      if (!hasNode) {
        prompts.log.error("Node.js is not installed, so the Hive daemon cannot run on this machine.")
        prompts.log.info(`Install it: ${dim("https://nodejs.org")}  ·  then re-run: ${dim("iris hive connect")}`)
        prompts.outro("Done")
        return
      }
    }

    const sp = prompts.spinner()
    sp.start("Connecting this machine…")
    const nodeId = await wakeHiveNode({ quiet: true, restart: !!args.force })
    if (args.json) {
      sp.stop(nodeId ? "Online" : "Not online", nodeId ? 0 : 1)
      console.log(JSON.stringify({ node_id: nodeId, online: !!nodeId }))
      return
    }
    if (!nodeId) {
      sp.stop("This machine did not come online", 1)
      prompts.log.info(`Diagnose: ${dim("iris hive doctor")}  ·  log: ${dim("~/.iris/bridge/bridge.log")}`)
      if (!daemonCtl()) prompts.log.info(`Daemon not installed: ${dim(installHint())}`)
      prompts.outro("Done")
      return
    }
    sp.stop(success(`Online  ${dim(`(${nodeId})`)}`))
    console.log()
    console.log(`  ${bold("This machine is now controllable from anywhere.")}`)
    console.log(`  ${dim("See the fleet:")}   ${highlight("iris hive board")}`)
    console.log(`  ${dim("Send it work:")}    ${highlight("iris hive tasks")}`)
    prompts.outro("Done")
  },
})

export const HiveConnectCommandExport = HiveConnectCommand
