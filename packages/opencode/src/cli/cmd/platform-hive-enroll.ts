import { cmd } from "./cmd"
import { requireAuth, requireUserId, dim, bold, success, highlight, writeJson } from "./iris-api"
import { spawnSync } from "child_process"
import { join } from "path"
import { homedir } from "os"
import { readFileSync, existsSync } from "fs"
import { fetchNodes } from "./platform-hive-nodes"
import {
  describeSshFailure,
  isSshUnreachable as isUnreachable,
  rememberedUserForHost,
  sshConfigFor,
  sshKeyFound,
  type SshAttempt,
} from "./hive-tailscale"

// ============================================================================
// iris hive enroll <ip>
//
// SSH into a remote machine, auto-discover its iris install state,
// run the install one-liner if needed, then wait for the node to register.
// ============================================================================

const INSTALL_URL = process.env.IRIS_INSTALL_URL ?? "https://heyiris.io/install-code"

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

export interface DiscoverResult {
  reachable: boolean
  auth_failed: boolean
  ssh_user: string | null
  /** Every user an attempt was made as, in order — so a failure names what was and wasn't tried. */
  ssh_users_tried: string[]
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
      "-o", "StrictHostKeyChecking=accept-new",
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
    ["-i", pubkey, "-o", "StrictHostKeyChecking=accept-new", target],
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
      "-o", "StrictHostKeyChecking=accept-new",
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

function bareHost(target: string): string {
  return target.includes("@") ? target.slice(target.indexOf("@") + 1) : target
}

/** Why enrolling would replace the machine's login, or null when it would not. */
export function accountMismatch(registered: string | null | undefined, enrolling: number): string | null {
  if (!registered || registered === "0" || String(registered) === String(enrolling)) return null
  return `this machine is signed in to IRIS account ${registered}; enrolling would replace that login with account ${enrolling}`
}

/** The node id the daemon reports on /health, or null when it has not enrolled (or is not up). */
export function healthNodeId(body: string): string | null {
  try {
    const j = JSON.parse(body)
    const id = j?.node_id ?? j?.daemon?.node_id ?? j?.node?.id
    return typeof id === "string" && id ? id : null
  } catch {
    return /"node_id":"([^"]+)"/.exec(body)?.[1] ?? null
  }
}

export function discover(
  target: string,
  opts: {
    /** --user: when given, the ONLY user tried — a probe must not report success as someone else. */
    user?: string
    /** From ~/.iris/hive-ssh.json: the user an earlier fs/doctor run logged in as at this address. */
    rememberedUser?: string | null
    exec?: (target: string, remoteCmd: string, timeoutSec?: number) => { ok: boolean; stdout: string; stderr: string }
    sshContext?: (host: string) => { defaultUser: string | null; keyFound: boolean }
  } = {},
): DiscoverResult {
  const explicit = target.includes("@") ? target.slice(0, target.indexOf("@")) : opts.user || null
  const host = bareHost(target)
  // Without a user, try the remembered one first, then whatever ssh defaults to (ssh_config User,
  // else the local login). The old single attempt as the ssh default is what reported "no key
  // auth" against a host whose key worked fine for a different account (#187954).
  const candidates: (string | null)[] = explicit ? [explicit] : [...new Set([opts.rememberedUser || null, null])]

  const result: DiscoverResult = {
    reachable: false,
    auth_failed: false,
    ssh_user: explicit,
    ssh_users_tried: [],
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
echo "WHOAMI=$(id -un 2>/dev/null)";
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
  const attempts: SshAttempt[] = []
  let r: { ok: boolean; stdout: string; stderr: string } | null = null
  for (const user of candidates) {
    r = (opts.exec ?? sshExec)(user ? `${user}@${host}` : host, probe, 15)
    if (r.ok) {
      result.ssh_user = user
      break
    }
    attempts.push({ user, stderr: r.stderr })
    if (!isAuthError(r.stderr)) break // a route or other failure will not change with the username
  }
  const sshContext =
    opts.sshContext ??
    ((h: string) => {
      const config = sshConfigFor(h)
      return { defaultUser: config.user, keyFound: sshKeyFound(config) }
    })
  const ctx = attempts.length ? sshContext(host) : null
  result.ssh_users_tried = attempts.map((a) => a.user ?? (ctx?.defaultUser ? `${ctx.defaultUser} (ssh default)` : "(ssh default)"))
  if (!r?.ok) {
    if (attempts.some((a) => isAuthError(a.stderr)) && !attempts.some((a) => isUnreachable(a.stderr))) {
      result.auth_failed = true
      result.recommendation = "needs-key"
    }
    result.reason = describeSshFailure(host, attempts, ctx!)
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
    else if (k === "WHOAMI" && v) result.ssh_user = v
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
      .positional("target", { describe: "tailnet ip, or user@ip", type: "string", demandOption: true })
      .option("user", {
        describe: "login name ON the node, usually not your IRIS account. Omitted: a user remembered for this address, then the ssh default",
        type: "string",
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .epilog("Read-only. Needs SSH key login to the node — see: iris how-to hive-tailscale (Step 6b)."),
  async handler(argv) {
    const target = String(argv.target)
    const d = discover(target, {
      user: argv.user as string | undefined,
      rememberedUser: await rememberedUserForHost(bareHost(target)),
    })

    if (argv.json) {
      await writeJson(d)
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
      .positional("target", { describe: "tailnet ip, or user@ip", type: "string", demandOption: true })
      .option("user", { describe: "login name ON the node, usually not your IRIS account", type: "string" })
      .option("force", { describe: "reinstall even if already healthy", type: "boolean", default: false })
      .option("dry-run", { describe: "show what would happen without doing it", type: "boolean", default: false })
      .option("user-id", { describe: "iris user id (defaults to your logged-in id)", type: "number" })
      .option("install-version", { describe: "specific iris version to install", type: "string" })
      .option("replace-login", {
        describe: "the machine is signed in to a DIFFERENT IRIS account: replace that login with yours (it is backed up first)",
        type: "boolean",
        default: false,
      })
      .option("auto-key", {
        describe: "run ssh-setup when key login is refused — only for a known username (--user, user@ip, or remembered)",
        type: "boolean",
        default: true,
      }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    let target = String(argv.target)
    if (!target.includes("@") && argv.user) target = `${argv.user}@${target}`
    const host = bareHost(target)
    const remembered = await rememberedUserForHost(host)

    console.log(`${dim("→")} probing ${bold(target)}...`)
    let d = discover(target, { rememberedUser: remembered })

    // Auto-run ssh-setup only for an account someone actually named (or one that has worked here
    // before). ssh-setup wraps ssh-copy-id: against a GUESSED username it asks for a password the
    // person may not have, to install a key that may already be installed for the right user (#187954).
    if (d.auth_failed && argv["auto-key"]) {
      const setupUser = target.includes("@") ? target.slice(0, target.indexOf("@")) : remembered
      if (!setupUser) {
        console.error(`${dim("✗")} ${d.reason}`)
        console.error(
          dim(`  Not running ssh-setup: no remote username was given. Re-run with --user <remote-user> (or user@${host}).`),
        )
        process.exit(1)
      }
      const setupTarget = `${setupUser}@${host}`
      console.log()
      console.log(`${highlight("!")} ${setupTarget} refused key login — setting up key auth now...`)
      const ok = await runSshSetup(setupTarget)
      if (!ok) {
        console.error(`${dim("✗")} could not establish key auth — aborting`)
        process.exit(1)
      }
      // Re-probe with key auth in place
      console.log(`${dim("→")} re-probing ${bold(setupTarget)}...`)
      d = discover(setupTarget)
    }

    if (!d.reachable) {
      console.log(`${dim("✗")} cannot reach ${target}: ${d.reason}`)
      process.exit(1)
    }

    // Install as the account the probe actually got in as, not the one that was typed or guessed.
    if (d.ssh_user) target = `${d.ssh_user}@${host}`

    printDiscover(d)

    if (d.recommendation === "skip" && !argv.force) {
      console.log(`${success("✓")} nothing to do (use --force to reinstall)`)
      return
    }

    // The install signs the machine in as YOU (your API key is written to its ~/.iris/sdk/.env)
    // and registers the node under your account. If it is signed in as someone else — another of
    // your accounts, or a teammate — that login is replaced. It used to happen silently (#191477).
    const mismatch = accountMismatch(d.registered_user_id, userId)
    if (mismatch && !argv["replace-login"]) {
      console.error(`${dim("✗")} ${mismatch}`)
      console.error(dim(`  Enroll from a machine signed in as ${d.registered_user_id} to keep that account, or pass --replace-login.`))
      process.exit(1)
    }
    console.log(dim(`  The node will belong to account ${userId}${mismatch ? ` (replacing the login for ${d.registered_user_id})` : ""}.`))

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

    // Keep the machine's current login, whatever it is: the install overwrites it.
    sshExec(target, `[ -f "$HOME/.iris/sdk/.env" ] && cp -p "$HOME/.iris/sdk/.env" "$HOME/.iris/sdk/.env.bak-$(date +%Y%m%d%H%M%S)" || true`, 10)

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
          "-o", "StrictHostKeyChecking=accept-new",
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

    // Ask the machine's OWN daemon whether it enrolled, rather than waiting for a new id to show
    // up in the registry. That wait said "it may show up in another minute" while the daemon was
    // crash-looping (#191476), and could never succeed for a machine re-enrolled under its old id.
    console.log()
    console.log(`${dim("→")} waiting for the daemon on ${bold(host)} to enroll (up to 90s)...`)
    let nodeId: string | null = null
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const h = sshExec(target, "curl -s --max-time 3 http://127.0.0.1:3200/health", 10)
      nodeId = healthNodeId(h.stdout)
      if (nodeId) break
      await new Promise((r) => setTimeout(r, 5000))
    }
    if (!nodeId) {
      const log = sshExec(
        target,
        'tail -n 6 "$HOME/.iris/logs/daemon.stderr.log" "$HOME/.iris/bridge/daemon.log" 2>/dev/null | grep -v "^$" | tail -n 8',
        10,
      )
      console.error(`${dim("✗")} the install finished, but the daemon on ${host} has not enrolled — it is not running or not answering.`)
      if (log.stdout.trim()) {
        console.error(dim("  Its log ends with:"))
        for (const line of log.stdout.trim().split("\n")) console.error(dim(`    ${line}`))
      }
      console.error(dim(`  On that machine: iris hive connect`))
      process.exit(1)
    }
    const node = (await fetchNodes(userId).catch(() => [])).find((n) => n.id === nodeId)
    console.log()
    console.log(`${success("✓")} enrolled ${bold(node?.name ?? host)}`)
    console.log(`  ${dim("id:")}      ${nodeId}`)
    console.log(`  ${dim("status:")}  ${node?.connection_status ?? "registering"}`)
    console.log()
    console.log(dim(`  Try it:  iris hive run ${nodeId} "uname -a"`))
  },
})

// ============================================================================
// ssh-setup
// ============================================================================

const HiveSshSetupCommand = cmd({
  command: "ssh-setup <target>",
  describe: "set up passwordless SSH key auth to a host (wraps ssh-copy-id)",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "user@ip — the node's own login name, usually not your IRIS account", type: "string", demandOption: true })
      .option("user", { describe: "ssh user if target is a bare ip", type: "string" })
      .epilog("Creates ~/.ssh/id_ed25519 if this machine has no key, then asks for that account's password once."),
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
