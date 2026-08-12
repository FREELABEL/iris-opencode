import { cmd } from "./cmd"
import { dim, bold, success, highlight } from "./iris-api"
import { spawnSync, spawn } from "child_process"
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
      console.log(dim("  Or let me do it: iris hive vpn install   then  iris hive vpn up"))
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

// ── vpn install  (install Tailscale on THIS machine) ─────────────────────────

const VpnInstallCommand = cmd({
  command: "install",
  describe: "install Tailscale on THIS machine (auto-detects OS)",
  builder: (y) => y,
  async handler() {
    if (tailscaleBin()) {
      console.log(`${success("✓")} Tailscale already installed  ${dim(tailscaleBin()!)}`)
      console.log(dim("  Next: iris hive vpn up"))
      return
    }
    const plat = process.platform
    let installer: string[] | null = null
    if (plat === "darwin") installer = ["brew", "install", "--cask", "tailscale-app"]
    else if (plat === "win32") installer = ["winget", "install", "--id", "tailscale.tailscale", "-e"]
    else if (plat === "linux") installer = ["sh", "-c", "curl -fsSL https://tailscale.com/install.sh | sh"]

    if (!installer) {
      console.log(`${highlight("!")} unsupported platform (${plat}). See https://tailscale.com/download`)
      process.exit(1)
    }
    console.log(`${dim("→")} installing Tailscale (${plat}) — follow any password prompt...`)
    const r = spawnSync(installer[0], installer.slice(1), { stdio: "inherit" })
    if (r.status !== 0 || !tailscaleBin()) {
      console.log()
      console.log(`${highlight("!")} couldn't finish automatically. Install manually:`)
      console.log(`  ${dim("macOS:")}    brew install --cask tailscale-app   ${dim("(or the Mac App Store)")}`)
      console.log(`  ${dim("Windows:")}  https://tailscale.com/download/windows`)
      console.log(`  ${dim("Linux:")}    curl -fsSL https://tailscale.com/install.sh | sh`)
      process.exit(r.status ?? 1)
    }
    console.log()
    console.log(`${success("✓")} Tailscale installed. Next: ${bold("iris hive vpn up")}`)
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

// ── host resolver (name → tailnet node) ──────────────────────────────────────

function resolveHost(name: string): TsNode | null {
  const s = readStatus()
  const all = [s.self, ...s.peers].filter(Boolean) as TsNode[]
  const q = name.toLowerCase()
  return (
    all.find((n) => n.name.toLowerCase() === q || n.dnsName.toLowerCase() === q) ||
    all.find((n) => n.name.toLowerCase().includes(q) || n.dnsName.toLowerCase().includes(q)) ||
    null
  )
}

// ── vpn host  (show connection details for one host) ─────────────────────────

const VpnHostCommand = cmd({
  command: "host <name>",
  describe: "show connection details for a host on the tailnet (IP, RDP, how to connect)",
  builder: (y) =>
    y
      .positional("name", { describe: "host name, e.g. qb-host", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const s = readStatus()
    if (!s.installed) {
      console.log(`${highlight("!")} Tailscale not installed — run: ${bold("iris hive vpn install")}`)
      process.exit(1)
    }
    if (!s.loggedIn) {
      console.log(`${highlight("!")} not on the tailnet — run: ${bold("iris hive vpn up")}`)
      process.exit(1)
    }
    const node = resolveHost(String(argv.name))
    if (!node) {
      console.log(`${highlight("!")} no machine matching ${bold(String(argv.name))} — run: ${bold("iris hive vpn status")}`)
      process.exit(1)
    }
    if (argv.json) {
      console.log(JSON.stringify(node, null, 2))
      return
    }
    console.log()
    console.log(bold(`Host ${node.name}`) + (node.online ? success("  ● online") : dim("  ○ offline")))
    console.log(`  ${dim("tailnet IP:")}   ${bold(node.tailscaleIP)}`)
    console.log(`  ${dim("OS:")}           ${node.os}`)
    console.log(`  ${dim("RDP address:")}  ${bold(node.tailscaleIP + ":3389")}`)
    console.log()
    console.log(bold("Connect (remote desktop):"))
    console.log(`  ${dim("Windows:")}  Remote Desktop → PC = ${bold(node.tailscaleIP)}`)
    console.log(`  ${dim("Mac:")}      Windows App → Add PC → ${bold(node.tailscaleIP)}`)
    console.log(`  ${dim("one-liner:")} ${bold("iris hive vpn connect " + node.name)}`)
    console.log()
    console.log(dim("  Log in with the Windows account we set up for you (never the owner's login)."))
    console.log()
  },
})

// ── vpn connect  (one command → launch remote desktop to a host) ─────────────

const VpnConnectCommand = cmd({
  command: "connect <name>",
  describe: "launch a remote-desktop session to a host on the tailnet (one command)",
  builder: (y) =>
    y
      .positional("name", { describe: "host name, e.g. qb-host", type: "string", demandOption: true })
      .option("user", { describe: "windows username to prefill", type: "string" }),
  async handler(argv) {
    const s = readStatus()
    if (!s.installed) {
      console.log(`${highlight("!")} Tailscale not installed — run: ${bold("iris hive vpn install")}`)
      process.exit(1)
    }
    if (!s.loggedIn) {
      console.log(`${highlight("!")} not on the tailnet — run: ${bold("iris hive vpn up")}`)
      process.exit(1)
    }
    const node = resolveHost(String(argv.name))
    if (!node) {
      console.log(`${highlight("!")} no machine matching ${bold(String(argv.name))} — run: ${bold("iris hive vpn status")}`)
      process.exit(1)
    }
    if (!node.online) console.log(`${highlight("!")} ${node.name} looks offline — trying anyway...`)
    const ip = node.tailscaleIP
    const user = argv.user ? String(argv.user) : null
    console.log(`${dim("→")} opening remote desktop to ${bold(node.name)} ${dim(ip)}...`)
    const plat = process.platform
    if (plat === "win32") {
      const args = [`/v:${ip}`]
      if (user) args.push(`/u:${user}`)
      spawn("mstsc", args, { detached: true, stdio: "ignore" }).unref()
    } else if (plat === "darwin") {
      // write a minimal .rdp and open it with the default RDP client (Windows App)
      const rdp = [`full address:s:${ip}`, user ? `username:s:${user}` : "", "screen mode id:i:2"]
        .filter(Boolean)
        .join("\n")
      const out = join(homedir(), ".iris", `connect-${node.name}.rdp`)
      writeFileSync(out, rdp + "\n")
      spawn("open", [out], { detached: true, stdio: "ignore" }).unref()
    } else {
      const r = spawnSync("xfreerdp", [`/v:${ip}`], { stdio: "inherit" })
      if (r.error) {
        console.log(dim(`  No RDP client found — point yours at ${ip}:3389`))
        process.exit(1)
      }
    }
    console.log(`${success("✓")} launched. Log in with the Windows account we set up for you.`)
  },
})

// ── vpn doctor  (health-check the whole secure-access setup) ─────────────────

const VpnDoctorCommand = cmd({
  command: "doctor",
  describe: "health-check the secure-access setup (install, login, peers, host reachability)",
  builder: (y) =>
    y
      .option("host", { describe: "also probe a specific host by name", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const s = readStatus()
    const checks: { label: string; ok: boolean; detail: string }[] = []
    checks.push({ label: "Tailscale installed", ok: s.installed, detail: s.installed ? tailscaleBin()! : "run: iris hive vpn install" })
    checks.push({ label: "On the tailnet", ok: s.loggedIn, detail: s.loggedIn ? (s.tailnet ?? "connected") : "run: iris hive vpn up" })
    const onlinePeers = s.peers.filter((p) => p.online).length
    checks.push({ label: "Peers reachable", ok: s.loggedIn ? s.peers.length > 0 : false, detail: `${onlinePeers}/${s.peers.length} online` })

    let hostNode: TsNode | null = null
    if (argv.host && s.loggedIn) {
      hostNode = resolveHost(String(argv.host))
      checks.push({ label: `Host '${argv.host}' found`, ok: !!hostNode, detail: hostNode ? hostNode.tailscaleIP : "not on the tailnet" })
      if (hostNode) checks.push({ label: `Host '${argv.host}' online`, ok: hostNode.online, detail: hostNode.online ? "online" : "offline — is it powered on?" })
    }

    if (argv.json) {
      console.log(JSON.stringify({ tailnet: s.tailnet, checks }, null, 2))
      return
    }
    console.log()
    console.log(bold("Secure-access health check"))
    for (const c of checks) {
      console.log(`  ${c.ok ? success("✓") : highlight("✗")} ${c.label.padEnd(24)} ${dim(c.detail)}`)
    }
    const failed = checks.filter((c) => !c.ok).length
    console.log()
    console.log(failed === 0 ? success("  all healthy") : highlight(`  ${failed} issue(s) — fix the ✗ rows above`))
    console.log()
    if (failed > 0) process.exit(1)
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
    const membersProvided = Boolean(argv.members)
    const members = membersProvided
      ? String(argv.members).split(",").map((m) => m.trim()).filter(Boolean)
      : ["first@example.com", "second@example.com"]

    // A COMPLETE policy, not a fragment — and that distinction is a lockout bug, not a
    // preference. A Tailscale policy is default-deny the moment `acls` is non-empty, and
    // the tailnet ships with a single allow-all rule. Emitting only the scoped rule and
    // telling someone to paste it into Access Controls therefore revokes their access to
    // every machine they own, including the one they are trying to protect. The earlier
    // version of this command did exactly that.
    //
    // So the policy below keeps two doors open on purpose and says why:
    //   1. members reach their OWN devices          — laptop to phone, unchanged
    //   2. admins reach the tagged host on any port — a tagged device has no owner, so
    //      without this the person applying the ACL loses the host to the group
    //   3. the group reaches the host on ONE port   — the rule you actually asked for
    const policy = {
      groups: { [`group:${group}`]: members },
      tagOwners: { [`tag:${tag}`]: ["autogroup:admin"] },
      acls: [
        { action: "accept", src: ["autogroup:member"], dst: ["autogroup:self:*"] },
        { action: "accept", src: ["autogroup:admin"], dst: [`tag:${tag}:*`] },
        { action: "accept", src: [`group:${group}`], dst: [`tag:${tag}:${port}`] },
      ],
      // ssh: scoped session logging can be added here for the audit trail
    }
    const blob = JSON.stringify(policy, null, 2)
    console.log()
    console.log(bold(`Tailscale ACL — ${group} → tag:${tag} on port ${port}`))
    console.log()
    console.log(`${highlight("!")} ${bold("This REPLACES your whole policy, it is not an addition.")}`)
    console.log(dim("  A tailnet ships allow-all; a policy is default-deny as soon as acls is set."))
    console.log(dim("  Anything not listed below stops working the moment you save."))
    console.log()
    console.log(dim("  Before saving: Tailscale admin → Access Controls → Preview, and check a device"))
    console.log(dim("  you own can still reach what it needs. Tag the host first, or rule 2 matches nothing."))
    console.log()
    console.log(blob)
    if (argv.write) {
      if (!membersProvided) {
        console.log()
        console.log(`${highlight("!")} refusing to write an ACL with placeholder members — pass --members "a@x.com,b@x.com"`)
        process.exit(1)
      }
      const out = join(homedir(), ".iris", "tailscale-acl.json")
      writeFileSync(out, blob + "\n")
      console.log()
      console.log(`${success("✓")} wrote ${bold(out)}`)
    }
    if (!membersProvided) {
      console.log()
      console.log(dim(`  Members are placeholders — pass --members "a@x.com,b@x.com" or sync from the Google Group.`))
    }
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
      process.exit(1)
    }
    const target = `${argv.user}@${ip}`
    console.log(`${dim("→")} enrolling ${bold(target)} over the tailnet...`)
    console.log(dim("  This reuses the existing SSH enroll path — the tunnel just makes the host reachable."))
    // Hand off to the already-built enroll command for the real work.
    const r = spawnSync("iris", ["hive", "enroll", target], { stdio: "inherit" })
    process.exit(r.status ?? 0)
  },
})

// ── vpn serve  (publish a LOCAL port to the tailnet — not to every interface) ──
//
// The gap this closes. To read a local dashboard from your phone the advice was
// `--hostname 0.0.0.0`, which serves it to the tailnet AND to whatever network the
// machine is sitting on — the café wifi, the client's guest VLAN, the conference
// centre. That is a much larger door than the one you meant to open, and it is
// opened by a flag people copy without reading.
//
// `tailscale serve` proxies a loopback port onto the tailnet only, over HTTPS with
// a real certificate, while the service stays bound to 127.0.0.1. Same outcome,
// no exposure, and the URL is stable.

const VpnServeCommand = cmd({
  command: "serve <port>",
  describe: "publish a LOCAL port to the tailnet over HTTPS (safer than binding 0.0.0.0)",
  builder: (y) =>
    y
      .positional("port", { describe: "the local port to publish, e.g. 4096", type: "number", demandOption: true })
      .option("path", { describe: "mount under a path instead of the root, e.g. /iris", type: "string" })
      .option("off", { describe: "stop publishing this port", type: "boolean", default: false })
      .option("status", { describe: "show what this machine is currently publishing", type: "boolean", default: false }),
  async handler(argv) {
    if (!tailscaleBin()) {
      console.log()
      console.log(`${highlight("!")} Tailscale is not installed — run ${bold("iris hive vpn install")}`)
      process.exit(1)
    }

    if (argv.status) {
      const st = ts(["serve", "status"])
      console.log()
      console.log(bold("Published to the tailnet from this machine"))
      console.log(st.stdout.trim() || dim("  nothing — this machine publishes no local ports"))
      return
    }

    const port = Number(argv.port)
    const path = argv.path ? String(argv.path) : undefined

    // PRECONDITION, checked before we run anything. Found by stress-testing this command
    // against a real tailnet that had never enabled HTTPS: `tailscale serve` does not
    // fail in that state, it BLOCKS — apparently waiting on the certificate decision —
    // so the wrapper's timeout fired and reported "failed" with an empty stderr. A hang
    // reported as a failure with no reason is worse than either honest outcome.
    //
    // CertDomains is populated only once HTTPS Certificates is on for the tailnet, so it
    // is a cheap, reliable read of exactly the thing that would otherwise hang us.
    if (!argv.off) {
      const probe = ts(["status", "--json"], 10)
      if (probe.ok) {
        try {
          const st = JSON.parse(probe.stdout) as { CertDomains?: string[] | null; MagicDNSSuffix?: string }
          if (!st.CertDomains || st.CertDomains.length === 0) {
            console.log()
            console.log(`${highlight("!")} ${bold("HTTPS certificates are not enabled for this tailnet.")}`)
            console.log(dim("  `tailscale serve` needs them, and without them it hangs rather than erroring."))
            console.log()
            console.log("  Enable once, in the Tailscale admin console:")
            console.log(dim("    DNS  ->  enable MagicDNS"))
            console.log(dim("    DNS  ->  enable HTTPS Certificates"))
            if (st.MagicDNSSuffix) {
              console.log()
              console.log(dim(`  This machine will then publish under *.${st.MagicDNSSuffix}`))
            }
            console.log()
            console.log(dim("  Re-run this command afterwards. Nothing was changed."))
            process.exit(1)
          }
        } catch {
          // Unparseable status is not a reason to block the command — fall through and
          // let serve speak for itself.
        }
      }
    }

    if (argv.off) {
      const args = path ? ["serve", "--https=443", `--set-path=${path}`, "off"] : ["serve", "--https=443", "off"]
      const r = ts(args)
      console.log()
      console.log(r.ok ? `${success("✓")} stopped publishing port ${port}` : `${highlight("!")} ${r.stderr.trim() || "failed"}`)
      return
    }

    // --bg so the proxy outlives this process. Without it the mapping dies with the
    // command and the URL 502s a second later, which reads as "it doesn't work".
    const args = ["serve", "--bg", "--https=443"]
    if (path) args.push(`--set-path=${path}`)
    args.push(String(port))

    const r = ts(args, 30)
    console.log()
    if (!r.ok) {
      const err = r.stderr.trim()
      // Distinguish "it said no" from "it never answered". The empty-stderr case is a
      // timeout, and reporting that as a failure sends you looking for a config error
      // that does not exist.
      if (!err) {
        console.log(`${highlight("!")} ${bold("tailscale serve did not respond within 30s.")}`)
        console.log(dim("  It is blocked on something, most likely waiting on input rather than refusing."))
        console.log(dim("  Run it directly to see what it wants:  tailscale serve --bg --https=443 " + port))
        process.exit(1)
      }
      console.log(`${highlight("!")} ${err}`)
      // The two failures worth naming, because the raw message explains neither.
      if (/HTTPS|cert/i.test(err)) {
        console.log(dim("  HTTPS certificates must be enabled once for the tailnet:"))
        console.log(dim("  Tailscale admin → DNS → enable MagicDNS, then enable HTTPS Certificates."))
      }
      if (/not.*logged|NeedsLogin/i.test(err)) {
        console.log(dim("  This machine is not on the tailnet yet — run: iris hive vpn up"))
      }
      process.exit(1)
    }

    console.log(`${success("✓")} localhost:${port} is now published to the tailnet`)
    console.log(r.stdout.trim())
    console.log()
    console.log(dim("  Reachable by tailnet devices only. The service stays bound to 127.0.0.1;"))
    console.log(dim("  nothing is exposed to the network this machine is physically on."))
    console.log()
    console.log(dim(`  Stop with:  iris hive vpn serve ${port} --off`))
    console.log(dim(`  Inventory:  iris hive vpn serve ${port} --status`))
    console.log()
    console.log(
      `${highlight("!")} ${bold("serve")} is tailnet-only. ${dim("Tailscale `funnel` would publish to the public internet — do not.")}`,
    )
  },
})

// ── group command ─────────────────────────────────────────────────────────────

export const HiveVpnCommandExport = cmd({
  command: "vpn <subcommand>",
  describe: "secure mesh (Tailscale/WireGuard) transport for Hive nodes — no open ports",
  builder: (y) =>
    y
      .command(VpnCheckCommand)
      .command(VpnInstallCommand)
      .command(VpnUpCommand)
      .command(VpnStatusCommand)
      .command(VpnHostCommand)
      .command(VpnConnectCommand)
      .command(VpnDoctorCommand)
      .command(VpnGrantCommand)
      .command(VpnServeCommand)
      .command(VpnEnrollCommand)
      .demandCommand(1, "Run: iris hive vpn check"),
  handler() {},
})
