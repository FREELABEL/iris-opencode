import { cmd } from "./cmd"
import { dim, bold, success, highlight } from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ============================================================================
// iris hive vpn  —  Tailscale (WireGuard) transport layer for the Hive
//
// The Hive's enroll/run commands already talk to nodes over SSH. The missing
// piece is a SECURE TRANSPORT so a machine that isn't on your LAN (a home
// desktop, an office mini-PC, a cloud VM) becomes reachable WITHOUT opening
// ports to the internet. Tailscale gives every joined machine a stable
// 100.x tailnet IP; the existing `iris hive enroll <tailnet-ip>` then works
// over that encrypted tunnel.
//
//   Layer 1  Tailscale (this file)  → encrypted mesh, no public ports
//   Layer 2  Google Workspace Group → who is allowed (ACL src)
//   Layer 3  IRIS HIVE node         → enroll/run/audit over the tailnet
//
// First use case: VPN IRIS HIVE bloq #531 — Drex accounting team reaches a
// QuickBooks Desktop host over RDP, scoped to the `drex-accounting` group.
// ============================================================================

// ── Tailscale CLI locator ────────────────────────────────────────────────────

// Common install locations, in preference order. The Windows path matters:
// the first-class use case (#531) is a Windows QuickBooks host, where Tailscale
// installs outside PATH and `command -v` doesn't exist.
const KNOWN_BINS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale", // macOS app bundle
  "/usr/local/bin/tailscale", // macOS (brew) / Linux
  "/usr/bin/tailscale", // Linux
  "C:\\Program Files\\Tailscale\\tailscale.exe", // Windows
]

function tailscaleBin(): string | null {
  // 1. PATH lookup — `where` on Windows, `command -v` on POSIX.
  const [locator, ...locatorArgs] =
    process.platform === "win32" ? ["where", "tailscale"] : ["command", "-v", "tailscale"]
  const which = spawnSync(locator, locatorArgs, { shell: true, encoding: "utf8" })
  if (which.status === 0 && which.stdout.trim()) {
    // `where` can return multiple lines; take the first hit.
    return which.stdout.trim().split(/\r?\n/)[0].trim()
  }
  // 2. Known install paths (covers Tailscale.app on macOS + the Windows .exe).
  for (const p of KNOWN_BINS) if (existsSync(p)) return p
  return null
}

function ts(args: string[], timeoutSec = 20): { ok: boolean; stdout: string; stderr: string } {
  const bin = tailscaleBin()
  if (!bin) return { ok: false, stdout: "", stderr: "tailscale-not-installed" }
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutSec * 1000 })
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

interface TsNode {
  name: string
  dnsName: string
  os: string
  tailscaleIP: string
  online: boolean
  self: boolean
}

interface TsStatus {
  installed: boolean
  loggedIn: boolean
  tailnet: string | null
  self: TsNode | null
  peers: TsNode[]
}

function toNode(raw: any, self: boolean): TsNode {
  return {
    name: raw?.HostName ?? raw?.DNSName ?? "unknown",
    dnsName: (raw?.DNSName ?? "").replace(/\.$/, ""),
    os: raw?.OS ?? "?",
    tailscaleIP: Array.isArray(raw?.TailscaleIPs) ? raw.TailscaleIPs[0] : "",
    online: !!raw?.Online,
    self,
  }
}

function readStatus(): TsStatus {
  const out: TsStatus = { installed: false, loggedIn: false, tailnet: null, self: null, peers: [] }
  const bin = tailscaleBin()
  if (!bin) return out
  out.installed = true
  const r = ts(["status", "--json"])
  if (!r.ok || !r.stdout.trim()) {
    // BackendState=NeedsLogin still returns JSON on most versions; fall through
    if (/NeedsLogin|Logged out|logged out/i.test(r.stderr + r.stdout)) out.loggedIn = false
    return out
  }
  try {
    const j = JSON.parse(r.stdout)
    out.loggedIn = j?.BackendState === "Running"
    out.tailnet = j?.CurrentTailnet?.Name ?? j?.MagicDNSSuffix ?? null
    if (j?.Self) out.self = toNode(j.Self, true)
    if (j?.Peer && typeof j.Peer === "object") {
      out.peers = Object.values(j.Peer).map((p) => toNode(p, false))
    }
  } catch {
    /* leave defaults */
  }
  return out
}

// ── vpn check  (preflight — run this BEFORE buying anything) ──────────────────

const VpnCheckCommand = cmd({
  command: "check",
  describe: "preflight the secure-mesh prerequisites on THIS machine (install, login, node IP)",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const s = readStatus()
    if (argv.json) {
      console.log(JSON.stringify(s, null, 2))
      return
    }
    console.log()
    console.log(bold("Secure-mesh preflight (this machine)"))
    console.log(`  ${dim("tailscale installed:")}  ${s.installed ? success("yes") : highlight("NO — install it first")}`)
    if (!s.installed) {
      console.log()
      console.log(bold("To install Tailscale:"))
      console.log(`  ${dim("macOS:")}    brew install --cask tailscale   ${dim("(or App Store)")}`)
      console.log(`  ${dim("Windows:")}  https://tailscale.com/download/windows`)
      console.log(`  ${dim("Linux:")}    curl -fsSL https://tailscale.com/install.sh | sh`)
      console.log()
      console.log(dim("  Then: iris hive vpn up   to join the tailnet."))
      return
    }
    console.log(`  ${dim("logged in:")}            ${s.loggedIn ? success("yes") : highlight("no — run: iris hive vpn up")}`)
    if (s.tailnet) console.log(`  ${dim("tailnet:")}              ${s.tailnet}`)
    if (s.self) {
      console.log(`  ${dim("this node:")}            ${bold(s.self.name)}  ${dim(s.self.tailscaleIP)}  (${s.self.os})`)
    }
    console.log(`  ${dim("peers visible:")}        ${s.peers.length}`)
    console.log()
    console.log(bold("Checklist for the Drex / QuickBooks host (#531):"))
    console.log(`  ${s.loggedIn ? success("✓") : dim("•")} 1. Host machine is Windows 10/11 ${bold("Pro")} (Home cannot host RDP)`)
    console.log(`  ${dim("•")} 2. Tailscale installed + logged in on the host  ${dim("(iris hive vpn up)")}`)
    console.log(`  ${dim("•")} 3. Tailscale installed on each Drex machine`)
    console.log(`  ${dim("•")} 4. ACL grants drex-accounting RDP to ONLY the host  ${dim("(iris hive vpn grant)")}`)
    console.log(`  ${dim("•")} 5. Host registered as a Hive node  ${dim("(iris hive vpn enroll)")}`)
    console.log()
  },
})

// ── vpn up  (join this machine to the tailnet) ────────────────────────────────

const VpnUpCommand = cmd({
  command: "up",
  describe: "bring THIS machine onto the tailnet (prints a login URL on first run)",
  builder: (y) =>
    y
      .option("hostname", { describe: "name this node shows as on the tailnet", type: "string" })
      .option("ssh", { describe: "enable Tailscale SSH on this node", type: "boolean", default: false })
      .option("tag", { describe: "apply an ACL tag, e.g. tag:qb-host", type: "string" }),
  async handler(argv) {
    if (!tailscaleBin()) {
      console.log(`${highlight("!")} Tailscale isn't installed. Run: ${bold("iris hive vpn check")}`)
      process.exit(1)
    }
    const args = ["up"]
    if (argv.hostname) args.push(`--hostname=${argv.hostname}`)
    if (argv.ssh) args.push("--ssh")
    if (argv.tag) args.push(`--advertise-tags=${argv.tag}`)
    console.log(`${dim("→")} ${bold("tailscale " + args.join(" "))}`)
    console.log(dim("  (follow the login URL if prompted — sign in with the Google Workspace account)"))
    // inherit stdio so the auth URL + browser prompt are visible
    const r = spawnSync(tailscaleBin()!, args, { stdio: "inherit" })
    if (r.status !== 0) process.exit(r.status ?? 1)
    const s = readStatus()
    if (s.self) {
      console.log()
      console.log(`${success("✓")} on the tailnet as ${bold(s.self.name)} ${dim(s.self.tailscaleIP)}`)
      console.log(dim(`  Next: iris hive vpn status   to see peers.`))
    }
  },
})

// ── vpn status  (map every machine on the tailnet) ────────────────────────────

const VpnStatusCommand = cmd({
  command: "status",
  describe: "list every machine on the tailnet (name, OS, tailnet IP, online)",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const s = readStatus()
    if (argv.json) {
      console.log(JSON.stringify(s, null, 2))
      return
    }
    if (!s.installed) {
      console.log(`${highlight("!")} Tailscale not installed — run: ${bold("iris hive vpn check")}`)
      process.exit(1)
    }
    if (!s.loggedIn) {
      console.log(`${highlight("!")} not logged in — run: ${bold("iris hive vpn up")}`)
      process.exit(1)
    }
    const all = [s.self, ...s.peers].filter(Boolean) as TsNode[]
    console.log()
    console.log(bold(`Tailnet ${s.tailnet ?? ""}`.trim()) + dim(`  (${all.length} machines)`))
    for (const n of all) {
      const dot = n.online ? success("●") : dim("○")
      const who = n.self ? bold(n.name) + dim(" (this)") : n.name
      console.log(`  ${dot} ${who.padEnd(28)} ${dim(n.tailscaleIP.padEnd(16))} ${dim(n.os)}`)
    }
    console.log()
    console.log(dim(`  Enroll one as a Hive node:  iris hive vpn enroll <tailnet-ip>`))
  },
})

// ── vpn grant  (emit the Tailscale ACL: a Google Group → one node, RDP only) ──

const VpnGrantCommand = cmd({
  command: "grant <group> <node-tag>",
  describe: "scaffold a least-privilege Tailscale ACL (group → node, one port) and print it",
  builder: (y) =>
    y
      .positional("group", { describe: "google group, e.g. drex-accounting", type: "string", demandOption: true })
      .positional("node-tag", { describe: "destination tag, e.g. qb-host", type: "string", demandOption: true })
      .option("port", { describe: "port to allow (RDP=3389)", type: "number", default: 3389 })
      .option("members", { describe: "comma-separated emails for the group", type: "string" })
      .option("write", { describe: "write the policy to ~/.iris/tailscale-acl.json", type: "boolean", default: false }),
  async handler(argv) {
    const group = String(argv.group).replace(/^group:/, "")
    const tag = String(argv["node-tag"]).replace(/^tag:/, "")
    const port = Number(argv.port)
    const members = argv.members
      ? String(argv.members).split(",").map((m) => m.trim()).filter(Boolean)
      : ["haroon@example.com", "mohammed@example.com"]

    // Least-privilege ACL: only `group:<group>` may reach `tag:<tag>` on `port`,
    // nothing else on the mesh. Groups should be SSO-synced from Google Workspace.
    const policy = {
      groups: { [`group:${group}`]: members },
      tagOwners: { [`tag:${tag}`]: ["autogroup:admin"] },
      acls: [
        {
          action: "accept",
          src: [`group:${group}`],
          dst: [`tag:${tag}:${port}`],
        },
      ],
      // ssh: scoped session logging can be added here for the audit trail
    }
    const blob = JSON.stringify(policy, null, 2)
    console.log()
    console.log(bold(`Tailscale ACL — ${group} → tag:${tag} on port ${port} (RDP)`))
    console.log(dim("  Paste into the Tailscale admin → Access Controls, or `tailscale set` via API."))
    console.log()
    console.log(blob)
    if (argv.write) {
      const out = join(homedir(), ".iris", "tailscale-acl.json")
      writeFileSync(out, blob + "\n")
      console.log()
      console.log(`${success("✓")} wrote ${bold(out)}`)
    }
    console.log()
    console.log(dim(`  Members default to placeholders — pass --members "a@x.com,b@x.com" or sync from the Google Group.`))
  },
})

// ── vpn enroll  (bridge: register a tailnet peer as a Hive node over the tunnel)

const VpnEnrollCommand = cmd({
  command: "enroll <tailnet-ip>",
  describe: "register a tailnet machine as a Hive node over the secure tunnel (wraps `hive enroll`)",
  builder: (y) =>
    y
      .positional("tailnet-ip", { describe: "the peer's 100.x tailnet IP (see: iris hive vpn status)", type: "string", demandOption: true })
      .option("user", { describe: "ssh user on the host", type: "string", default: "iris" }),
  async handler(argv) {
    const ip = String(argv["tailnet-ip"])
    if (!/^100\./.test(ip)) {
      console.log(`${highlight("!")} ${ip} is not a tailnet IP (expected 100.x). Run: ${bold("iris hive vpn status")}`)
    }
    const target = `${argv.user}@${ip}`
    console.log(`${dim("→")} enrolling ${bold(target)} over the tailnet...`)
    console.log(dim("  This reuses the existing SSH enroll path — the tunnel just makes the host reachable."))
    // Hand off to the already-built enroll command for the real work.
    const r = spawnSync("iris", ["hive", "enroll", target], { stdio: "inherit" })
    process.exit(r.status ?? 0)
  },
})

// ── group command ─────────────────────────────────────────────────────────────

export const HiveVpnCommandExport = cmd({
  command: "vpn <subcommand>",
  describe: "secure mesh (Tailscale/WireGuard) transport for Hive nodes — no open ports",
  builder: (y) =>
    y
      .command(VpnCheckCommand)
      .command(VpnUpCommand)
      .command(VpnStatusCommand)
      .command(VpnGrantCommand)
      .command(VpnEnrollCommand)
      .demandCommand(1, "Run: iris hive vpn check"),
  handler() {},
})
