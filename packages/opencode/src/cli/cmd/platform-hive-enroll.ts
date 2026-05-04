import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, highlight } from "./iris-api"
import { spawnSync } from "child_process"
import { join } from "path"
import { homedir } from "os"
import { readFileSync, existsSync } from "fs"

// ============================================================================
// iris hive enroll <ip>
//
// SSH into a remote machine, auto-discover its iris install state,
// run the install one-liner if needed, then wait for the node to register.
// ============================================================================

const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"
const INSTALL_URL = process.env.IRIS_INSTALL_URL ?? "https://heyiris.io/install-code"

async function hiveFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

// Read SDK env to inject into the remote install for non-interactive auth.
function readLocalSdkEnv(): { token: string | null; userId: string | null } {
  const envPath = join(homedir(), ".iris", "sdk", ".env")
  if (!existsSync(envPath)) return { token: null, userId: null }
  let token: string | null = null
  let userId: string | null = null
  try {
    const text = readFileSync(envPath, "utf8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq < 0) continue
      const k = trimmed.slice(0, eq).trim()
      const v = trimmed.slice(eq + 1).trim()
      if (k === "IRIS_API_KEY") token = v
      if (k === "IRIS_USER_ID") userId = v
    }
  } catch {}
  return { token, userId }
}

interface DiscoverResult {
  reachable: boolean
  auth_failed: boolean
  ssh_user: string | null
  os_uname: string | null
  iris_path: string | null
  iris_version: string | null
  daemon_running: boolean
  has_node_key: boolean
  registered_user_id: string | null
  recommendation: "install" | "upgrade" | "start-daemon" | "reconfigure" | "skip" | "needs-key"
  reason: string
}

function compareVersion(local: string, remote: string): "same" | "remote-older" | "remote-newer" | "unknown" {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10))
  const l = parse(local)
  const r = parse(remote)
  if (l.some(isNaN) || r.some(isNaN)) return "unknown"
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (r[i] ?? 0)) return "remote-older"
    if ((l[i] ?? 0) < (r[i] ?? 0)) return "remote-newer"
  }
  return "same"
}

function readLocalIrisVersion(): string | null {
  // packages/opencode/package.json — bundled at compile time. Best-effort.
  try {
    const pkg = JSON.parse(readFileSync(join(homedir(), ".iris", "version.json"), "utf8"))
    return pkg.version ?? null
  } catch {}
  // Fallback: ask the locally installed iris itself
  const r = spawnSync("iris", ["--version"], { encoding: "utf8", timeout: 3000 })
  if (r.status === 0) {
    const m = r.stdout.match(/(\d+\.\d+\.\d+)/)
    if (m) return m[1]
  }
  return null
}

function sshExec(target: string, remoteCmd: string, timeoutSec = 15): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    "ssh",
    [
      "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
      target,
      remoteCmd,
    ],
    { encoding: "utf8", timeout: (timeoutSec + 2) * 1000 },
  )
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

// ── SSH key bootstrap ───────────────────────────────────────────────────────

function isAuthError(stderr: string): boolean {
  return /permission denied|no supported authentication|publickey|keyboard-interactive/i.test(
    stderr,
  )
}

function isUnreachable(stderr: string): boolean {
  return /connection refused|no route|network is unreachable|operation timed out|host is down/i.test(
    stderr,
  )
}

function findLocalPubkey(): string | null {
  for (const name of ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"]) {
    const p = join(homedir(), ".ssh", name)
    if (existsSync(p)) return p
  }
  return null
}

function generateKeyIfNeeded(): string | null {
  const existing = findLocalPubkey()
  if (existing) return existing
  console.log(`${dim("→")} no SSH key found, generating ed25519 keypair...`)
  const r = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", join(homedir(), ".ssh", "id_ed25519")],
    { stdio: "inherit" },
  )
  if (r.status !== 0) {
    console.error("ssh-keygen failed")
    return null
  }
  return findLocalPubkey()
}

function sshCopyId(target: string, pubkey: string): boolean {
  // ssh-copy-id is interactive — it prompts for the target's password.
  // Inherit stdio so the prompt is visible.
  const r = spawnSync(
    "ssh-copy-id",
    ["-i", pubkey, "-o", "StrictHostKeyChecking=no", target],
    { stdio: "inherit" },
  )
  return r.status === 0
}

function verifyKeyAuth(target: string): boolean {
  const r = spawnSync(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=no",
      "-o", "PreferredAuthentications=publickey",
      target,
      "echo OK",
    ],
    { encoding: "utf8", timeout: 8000 },
  )
  return r.status === 0 && r.stdout.includes("OK")
}

async function runSshSetup(target: string): Promise<boolean> {
  if (verifyKeyAuth(target)) {
    console.log(`${success("✓")} key auth already works for ${bold(target)}`)
    return true
  }
  const pubkey = generateKeyIfNeeded()
  if (!pubkey) return false
  console.log(`${dim("→")} pushing ${dim(pubkey)} to ${bold(target)}`)
  console.log(dim("  (you will be prompted for the remote password once)"))
  const ok = sshCopyId(target, pubkey)
  if (!ok) {
    console.error(`${dim("✗")} ssh-copy-id failed`)
    return false
  }
  if (verifyKeyAuth(target)) {
    console.log(`${success("✓")} key auth verified for ${bold(target)}`)
    return true
  }
  console.error(`${dim("✗")} key was copied but verification still fails`)
  return false
}

function discover(target: string): DiscoverResult {
  const result: DiscoverResult = {
    reachable: false,
    auth_failed: false,
    ssh_user: target.includes("@") ? target.split("@")[0] : null,
    os_uname: null,
    iris_path: null,
    iris_version: null,
    daemon_running: false,
    has_node_key: false,
    registered_user_id: null,
    recommendation: "install",
    reason: "",
  }

  // Single SSH session that emits a parseable report.
  const probe = `
echo "UNAME=$(uname -srm 2>/dev/null)";
IRIS_BIN=$(command -v iris 2>/dev/null || ls -1 "$HOME/.iris/bin/iris" 2>/dev/null);
echo "IRIS_PATH=$IRIS_BIN";
if [ -n "$IRIS_BIN" ]; then
  VER=$("$IRIS_BIN" --version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -1);
  echo "IRIS_VERSION=$VER";
fi;
if pgrep -f "iris-daemon|coding-agent-bridge/daemon" >/dev/null 2>&1; then
  echo "DAEMON=running";
else
  echo "DAEMON=stopped";
fi;
if [ -f "$HOME/.iris/config.json" ]; then
  KEY=$(grep -oE "node_live_[a-zA-Z0-9]+" "$HOME/.iris/config.json" | head -1);
  echo "NODE_KEY=$KEY";
fi;
if [ -f "$HOME/.iris/sdk/.env" ]; then
  UID_VAL=$(grep "^IRIS_USER_ID=" "$HOME/.iris/sdk/.env" | cut -d= -f2);
  echo "USER_ID=$UID_VAL";
fi;
`
  const r = sshExec(target, probe, 15)
  if (!r.ok) {
    if (isAuthError(r.stderr)) {
      result.auth_failed = true
      result.recommendation = "needs-key"
      result.reason = "SSH reachable but no key auth — run: iris hive ssh-setup " + target
    } else if (isUnreachable(r.stderr)) {
      result.reason = "SSH not reachable: " + r.stderr.trim().split("\n")[0].slice(0, 160)
    } else {
      result.reason = r.stderr.trim().slice(0, 200) || "ssh failed"
    }
    return result
  }
  result.reachable = true
  for (const line of r.stdout.split("\n")) {
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1).trim()
    if (k === "UNAME") result.os_uname = v
    else if (k === "IRIS_PATH") result.iris_path = v || null
    else if (k === "IRIS_VERSION") result.iris_version = v || null
    else if (k === "DAEMON") result.daemon_running = v === "running"
    else if (k === "NODE_KEY") result.has_node_key = !!v
    else if (k === "USER_ID") result.registered_user_id = v || null
  }

  // Decide recommendation
  const localVer = readLocalIrisVersion()
  if (!result.iris_path) {
    result.recommendation = "install"
    result.reason = "iris not installed"
  } else if (localVer && result.iris_version) {
    const cmp = compareVersion(localVer, result.iris_version)
    if (cmp === "remote-older") {
      result.recommendation = "upgrade"
      result.reason = `installed ${result.iris_version}, you're on ${localVer}`
    } else if (!result.has_node_key) {
      result.recommendation = "reconfigure"
      result.reason = "iris present but not registered as a Hive node"
    } else if (!result.daemon_running) {
      result.recommendation = "start-daemon"
      result.reason = "registered, but daemon is not running"
    } else {
      result.recommendation = "skip"
      result.reason = `up to date (${result.iris_version}), daemon running, registered`
    }
  } else if (!result.has_node_key) {
    result.recommendation = "reconfigure"
    result.reason = "iris present (version unknown) but not registered"
  } else if (!result.daemon_running) {
    result.recommendation = "start-daemon"
    result.reason = "registered, but daemon is not running"
  } else {
    result.recommendation = "skip"
    result.reason = "appears healthy (version unknown)"
  }

  return result
}

function printDiscover(d: DiscoverResult) {
  console.log()
  console.log(bold("Discovery"))
  console.log(`  ${dim("reachable:")}      ${d.reachable ? success("yes") : "no"}`)
  if (d.os_uname) console.log(`  ${dim("os:")}             ${d.os_uname}`)
  console.log(`  ${dim("iris:")}           ${d.iris_path ? `${d.iris_path}${d.iris_version ? `  (v${d.iris_version})` : ""}` : dim("not installed")}`)
  console.log(`  ${dim("daemon:")}         ${d.daemon_running ? success("running") : dim("stopped")}`)
  console.log(`  ${dim("registered:")}     ${d.has_node_key ? success("yes") : dim("no")}`)
  if (d.registered_user_id) console.log(`  ${dim("user_id:")}        ${d.registered_user_id}`)
  console.log()
  console.log(bold("Recommendation"))
  const map: Record<DiscoverResult["recommendation"], string> = {
    install: highlight("→ fresh install"),
    upgrade: highlight("→ upgrade in place"),
    "start-daemon": highlight("→ start daemon (already installed + registered)"),
    reconfigure: highlight("→ run iris-login to register as a node"),
    "needs-key": highlight("→ set up SSH key auth first"),
    skip: success("→ skip — looks healthy"),
  }
  console.log(`  ${map[d.recommendation]}`)
  console.log(`  ${dim(d.reason)}`)
}

// ============================================================================
// discover (read-only)
// ============================================================================

const HiveDiscoverCommand = cmd({
  command: "discover <target>",
  describe: "SSH-probe a host to see if iris is installed, current, and registered",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "user@ip (or just ip with default user)", type: "string", demandOption: true })
      .option("user", { describe: "ssh user if target is bare ip", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    let target = String(argv.target)
    if (!target.includes("@") && argv.user) target = `${argv.user}@${target}`

    const d = discover(target)

    if (argv.json) {
      console.log(JSON.stringify(d, null, 2))
      return
    }

    if (!d.reachable) {
      console.log(`${dim("✗")} could not reach ${target}: ${d.reason}`)
      process.exit(1)
    }
    printDiscover(d)
  },
})

// ============================================================================
// enroll
// ============================================================================

const HiveEnrollCommand = cmd({
  command: "enroll <target>",
  describe: "SSH to a host, install iris if needed, register as a Hive node",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "user@ip (or just ip with default user)", type: "string", demandOption: true })
      .option("user", { describe: "ssh user if target is bare ip", type: "string" })
      .option("force", { describe: "reinstall even if already healthy", type: "boolean", default: false })
      .option("dry-run", { describe: "show what would happen without doing it", type: "boolean", default: false })
      .option("user-id", { describe: "iris user id (defaults to your logged-in id)", type: "number" })
      .option("install-version", { describe: "specific iris version to install", type: "string" })
      .option("auto-key", { describe: "auto-run ssh-setup if key auth is missing", type: "boolean", default: true }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    let target = String(argv.target)
    if (!target.includes("@") && argv.user) target = `${argv.user}@${target}`

    console.log(`${dim("→")} probing ${bold(target)}...`)
    let d = discover(target)

    // Auto-run ssh-setup if key auth is the only blocker
    if (d.auth_failed && argv["auto-key"]) {
      console.log()
      console.log(`${highlight("!")} no SSH key auth — setting up now...`)
      const ok = await runSshSetup(target)
      if (!ok) {
        console.error(`${dim("✗")} could not establish key auth — aborting`)
        process.exit(1)
      }
      // Re-probe with key auth in place
      console.log(`${dim("→")} re-probing ${bold(target)}...`)
      d = discover(target)
    }

    if (!d.reachable) {
      console.log(`${dim("✗")} cannot reach ${target}: ${d.reason}`)
      console.log(dim("  Tip: ensure SSH is enabled on the target."))
      console.log(dim("  If key auth fails: iris hive ssh-setup " + target))
      process.exit(1)
    }

    printDiscover(d)

    if (d.recommendation === "skip" && !argv.force) {
      console.log(`${success("✓")} nothing to do (use --force to reinstall)`)
      return
    }

    // Pull SDK token to seed the remote install
    const { token } = readLocalSdkEnv()
    if (!token) {
      console.error("Could not read your IRIS_API_KEY from ~/.iris/sdk/.env. Run: iris auth login")
      process.exit(1)
    }

    // Build install command — non-interactive via --token + --user-id
    const versionFlag = argv["install-version"] ? ` --version ${argv["install-version"]}` : ""
    const installCmd = `curl -fsSL ${INSTALL_URL} | bash -s -- --token ${token} --user-id ${userId}${versionFlag}`

    if (argv["dry-run"]) {
      console.log()
      console.log(bold("Would run on remote:"))
      console.log(`  ${dim(installCmd.replace(token, token.slice(0, 12) + "…"))}`)
      return
    }

    // Snapshot current node IDs so we can detect the new one after registration
    const before = await fetchNodeIds(userId)

    console.log()
    console.log(`${dim("→")} running install on ${bold(target)} (this can take a minute)...`)
    console.log(dim("─".repeat(60)))

    // Stream remote install output. Use spawn (not spawnSync) so user sees progress.
    const { spawn } = await import("child_process")
    const code: number = await new Promise((resolve) => {
      const p = spawn(
        "ssh",
        [
          "-o", "ConnectTimeout=10",
          "-o", "StrictHostKeyChecking=no",
          target,
          installCmd,
        ],
        { stdio: "inherit" },
      )
      p.on("exit", (code) => resolve(code ?? 1))
      p.on("error", () => resolve(1))
    })

    console.log(dim("─".repeat(60)))
    if (code !== 0) {
      console.error(`${dim("✗")} install exited ${code}`)
      process.exit(code)
    }

    // Wait for the new node to register + come online
    console.log()
    console.log(`${dim("→")} waiting for new node to appear (up to 90s)...`)
    const newNode = await waitForNewNode(userId, before, 90_000)
    if (!newNode) {
      console.log(`${dim("!")} install finished but no new node appeared in your registry yet.`)
      console.log(dim("  Run: iris hive nodes list — it may show up in another minute."))
      return
    }
    console.log()
    console.log(`${success("✓")} enrolled ${bold(newNode.name)}`)
    console.log(`  ${dim("id:")}      ${newNode.id}`)
    console.log(`  ${dim("status:")}  ${newNode.connection_status}`)
    console.log()
    console.log(dim(`  Try it:  iris hive run "${newNode.name}" "uname -a"`))
  },
})

async function fetchNodeIds(userId: number): Promise<Set<string>> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}`)
  if (!res.ok) return new Set()
  const data = (await res.json()) as { nodes: Array<{ id: string }> }
  return new Set(data.nodes.map((n) => n.id))
}

async function waitForNewNode(
  userId: number,
  before: Set<string>,
  timeoutMs: number,
): Promise<{ id: string; name: string; connection_status: string } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}`)
    if (!res.ok) continue
    const data = (await res.json()) as {
      nodes: Array<{ id: string; name: string; connection_status: string }>
    }
    const fresh = data.nodes.find((n) => !before.has(n.id))
    if (fresh) return fresh
  }
  return null
}

// ============================================================================
// ssh-setup
// ============================================================================

const HiveSshSetupCommand = cmd({
  command: "ssh-setup <target>",
  describe: "set up passwordless SSH key auth to a host (wraps ssh-copy-id)",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "user@ip", type: "string", demandOption: true })
      .option("user", { describe: "ssh user if target is bare ip", type: "string" }),
  async handler(argv) {
    let target = String(argv.target)
    if (!target.includes("@") && argv.user) target = `${argv.user}@${target}`

    const ok = await runSshSetup(target)
    if (!ok) process.exit(1)
  },
})

export const HiveDiscoverCommandExport = HiveDiscoverCommand
export const HiveEnrollCommandExport = HiveEnrollCommand
export const HiveSshSetupCommandExport = HiveSshSetupCommand
