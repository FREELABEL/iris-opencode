import { cmd } from "./cmd"
import { UI } from "../ui"
import { dim, bold, success } from "./iris-api"

/** iris-api exports dim/bold/success/highlight but no warning; a partial install needs to be loud. */
function warning(s: string): string {
  return `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}`
}
import { existsSync, mkdirSync, rmSync, readdirSync, renameSync, writeFileSync } from "fs"
import { homedir, tmpdir, platform } from "os"
import { join } from "path"
import { execFileSync, spawnSync } from "child_process"

// ============================================================================
// `iris node` — make THIS machine a Hive compute node, from the CLI you already have.
//
// WHY THIS EXISTS. When the daemon was missing, `iris hive connect` said:
//
//     Daemon binary not found. Install it: curl -fsSL https://heyiris.io/install-code | bash
//
// That is the web installer — the same one that had just skipped the daemon, and it
// would skip it again for the same reason. Nothing in the circle ever named the
// missing prerequisite. A client lost about two hours inside it (#184597).
//
// The CLI is a self-contained compiled binary, so it can do the whole job itself:
// fetch the daemon (no Git — see below), install its dependencies, register
// autostart, start it. And when a step cannot run, say WHICH step and WHY, rather
// than pointing back at the installer.
//
// NO GIT. The daemon is fetched as an HTTPS archive. Git was only ever `clone` on
// install and `pull` on update; nothing read the history. Git IS still needed at
// RUNTIME for reference-repo indexing and exchange/bounty tasks — that is a
// different dependency with a different message, and it is not this command's job
// to demand it up front for a capability most machines never use.
//
// NODE IS STILL REQUIRED, and this says so plainly instead of skipping quietly. The
// daemon is Node source with 15 dependencies. EPIC #184602 (ship the daemon as a
// compiled binary) is what removes that; until it lands, honest beats convenient.
// ============================================================================

const IRIS_DIR = () => process.env.IRIS_HOME || join(homedir(), ".iris")
const BRIDGE_DIR = () => join(IRIS_DIR(), "bridge")
const ARCHIVE_URL =
  process.env.IRIS_DAEMON_ARCHIVE_URL || "https://github.com/FREELABEL/iris-daemon/archive/refs/heads/main.tar.gz"

/** Machine state that an update must not eat. Measured on a real install. */
export const PRESERVE = ["node_modules", "daemon.log", "bridge.log", "test-results", ".git", ".env"]

export type StepResult = { ok: boolean; detail?: string }

/**
 * Fetch the daemon source into `dest` over HTTPS.
 *
 * Stages into a temp directory and only then swaps, so a failed download leaves an
 * existing install exactly as it was — the old shell path `rm -rf`'d first and
 * re-cloned, which turned a network blip into a wiped node_modules.
 */
export function fetchDaemon(dest: string, url = ARCHIVE_URL): StepResult {
  const stage = join(tmpdir(), `iris-daemon-${Date.now()}`)
  try {
    mkdirSync(stage, { recursive: true })
    const tgz = join(stage, "daemon.tar.gz")
    const dl = spawnSync("curl", ["-fsSL", "--max-time", "180", url, "-o", tgz], { stdio: "pipe" })
    if (dl.status !== 0) return { ok: false, detail: `could not download ${url}` }
    const ex = spawnSync("tar", ["-xzf", tgz, "-C", stage], { stdio: "pipe" })
    if (ex.status !== 0) return { ok: false, detail: "the downloaded archive could not be extracted" }

    // GitHub wraps the tree in one <repo>-<branch> directory.
    const root = readdirSync(stage, { withFileTypes: true }).find((e) => e.isDirectory())
    if (!root) return { ok: false, detail: "the archive contained no directory" }
    const src = join(stage, root.name)

    // A 200 that serves an error page is still a 200. Refuse anything that is not the
    // daemon rather than copying it over a working install.
    if (!existsSync(join(src, "daemon.js")))
      return { ok: false, detail: "that archive has no daemon.js — refusing to overwrite the install" }

    mkdirSync(dest, { recursive: true })
    for (const entry of existsSync(dest) ? readdirSync(dest) : []) {
      if (PRESERVE.includes(entry)) continue
      rmSync(join(dest, entry), { recursive: true, force: true })
    }
    // cp -R rather than rename: dest may be on a different filesystem, and rename
    // across devices fails with EXDEV.
    const cp = spawnSync("cp", ["-R", `${src}/.`, `${dest}/`], { stdio: "pipe" })
    if (cp.status !== 0) return { ok: false, detail: `could not copy the daemon into ${dest}` }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Is a usable `node` on PATH? Returns its version, or null. */
export function nodeVersion(): string | null {
  try {
    return execFileSync("node", ["--version"], { stdio: "pipe" }).toString().trim()
  } catch {
    return null
  }
}

/**
 * Register the daemon to start at login.
 *
 * macOS gets a LaunchAgent (RunAtLoad + KeepAlive), mirroring what the daemon's own
 * installer writes. Windows autostart is registered by install.ps1's scheduled task;
 * from here we report rather than duplicate it, because a second registration
 * mechanism competing with the installer's is worse than one that is honest about
 * its scope.
 */
export function registerAutostart(bridgeDir: string): StepResult {
  if (platform() !== "darwin")
    return { ok: false, detail: `autostart on ${platform()} is registered by the installer, not by this command` }
  try {
    const label = "io.heyiris.daemon.cli"
    const agents = join(homedir(), "Library", "LaunchAgents")
    mkdirSync(agents, { recursive: true })
    const plist = join(agents, `${label}.plist`)
    const node = spawnSync("which", ["node"], { stdio: "pipe" }).stdout?.toString().trim()
    if (!node) return { ok: false, detail: "node is not on PATH, so there is nothing to launch" }
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${join(bridgeDir, "daemon.js")}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${bridgeDir}</string>
  <key>StandardOutPath</key><string>${join(bridgeDir, "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(bridgeDir, "daemon.log")}</string>
</dict>
</plist>
`,
      "utf8",
    )
    // bootout first so a re-run replaces rather than duplicating.
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${label}`], { stdio: "pipe" })
    const boot = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plist], { stdio: "pipe" })
    if (boot.status !== 0)
      return { ok: false, detail: (boot.stderr?.toString() || "launchctl bootstrap failed").trim() }
    return { ok: true, detail: plist }
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) }
  }
}

// ── commands ────────────────────────────────────────────────────────────────

const NodeInstallCommand = cmd({
  command: "install",
  describe: "make this machine a Hive compute node (fetch the daemon, install deps, autostart, start)",
  builder: (y) =>
    y
      .option("no-start", { type: "boolean", default: false, describe: "install but do not start it" })
      .option("no-autostart", { type: "boolean", default: false, describe: "skip registering it to start at login" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const bridge = BRIDGE_DIR()
    const out: Record<string, any> = { bridge_dir: bridge, steps: {} }
    const say = (s: string) => {
      if (!args.json) process.stdout.write(s + "\n")
    }

    say("")
    say(bold("  Installing the IRIS Hive node"))
    say(dim(`  ${bridge}`))
    say("")

    // 1. Node — named, not skipped. This is the prerequisite that cost two hours.
    const nv = nodeVersion()
    out.steps.node = { ok: !!nv, detail: nv ?? "not found" }
    if (!nv) {
      say(warning("  ✗ Node.js is not installed — the daemon is Node source and cannot run without it."))
      say(dim("    Install it from https://nodejs.org, then re-run: iris node install"))
      say(dim("    (Git is NOT required. It used to be; it no longer is.)"))
      if (args.json) process.stdout.write(JSON.stringify({ ...out, ok: false }, null, 2) + "\n")
      process.exitCode = 1
      return
    }
    say(`  ✓ Node.js ${nv}`)

    // 2. Fetch — no git.
    const updating = existsSync(join(bridge, "daemon.js"))
    const fetched = fetchDaemon(bridge)
    out.steps.fetch = fetched
    if (!fetched.ok) {
      say(warning(`  ✗ could not fetch the daemon — ${fetched.detail}`))
      say(dim(updating ? "    Your existing install was left untouched." : "    Nothing was installed."))
      if (args.json) process.stdout.write(JSON.stringify({ ...out, ok: false }, null, 2) + "\n")
      process.exitCode = 1
      return
    }
    say(`  ✓ daemon ${updating ? "updated" : "downloaded"} ${dim("(over HTTPS — no Git needed)")}`)

    // 3. Dependencies.
    const npm = spawnSync("npm", ["install", "--production", "--silent"], { cwd: bridge, stdio: "pipe" })
    const depsOk = npm.status === 0 || existsSync(join(bridge, "node_modules", "dotenv"))
    out.steps.deps = {
      ok: depsOk,
      detail: depsOk ? undefined : (npm.stderr?.toString() || "npm install failed").slice(0, 200),
    }
    say(
      depsOk
        ? "  ✓ dependencies installed"
        : warning("  ✗ dependencies incomplete — run: cd ~/.iris/bridge && npm install"),
    )

    // 4. Autostart.
    let auto: StepResult = { ok: false, detail: "skipped (--no-autostart)" }
    if (!args["no-autostart"]) auto = registerAutostart(bridge)
    out.steps.autostart = auto
    say(auto.ok ? "  ✓ registered to start at login" : dim(`  · autostart: ${auto.detail}`))

    // 5. Start.
    let started: StepResult = { ok: false, detail: "skipped (--no-start)" }
    if (!args["no-start"] && depsOk) {
      const r = spawnSync("node", [join(bridge, "daemon.js"), "--status"], { stdio: "pipe" })
      started = { ok: r.status === 0, detail: r.status === 0 ? "already running" : "not running yet" }
      if (!started.ok && !auto.ok) {
        say(dim("  · start it with: iris-daemon start"))
      }
    }
    out.steps.start = started

    const ok = fetched.ok && depsOk
    out.ok = ok
    if (args.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n")
      return
    }
    say("")
    say(ok ? success("  This machine is a Hive node.") : warning("  Installed with problems — see above."))
    say(dim("  iris hive nodes list     see it in the fleet"))
    say("")
    if (!ok) process.exitCode = 1
  },
})

const NodeStatusCommand = cmd({
  command: "status",
  describe: "is this machine set up as a Hive node, and is it running?",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const bridge = BRIDGE_DIR()
    const installed = existsSync(join(bridge, "daemon.js"))
    const nv = nodeVersion()
    const deps = existsSync(join(bridge, "node_modules", "dotenv"))
    let running = false
    if (installed && nv)
      running = spawnSync("node", [join(bridge, "daemon.js"), "--status"], { stdio: "pipe" }).status === 0

    if (args.json) {
      process.stdout.write(JSON.stringify({ bridge_dir: bridge, installed, node: nv, deps, running }, null, 2) + "\n")
      return
    }
    process.stdout.write(
      "\n" +
        bold("  Hive node") +
        "\n" +
        `  ${installed ? "✓" : "✗"} daemon installed   ${dim(bridge)}\n` +
        `  ${nv ? "✓" : "✗"} Node.js            ${dim(nv ?? "not found — https://nodejs.org")}\n` +
        `  ${deps ? "✓" : "✗"} dependencies\n` +
        `  ${running ? "✓" : "·"} running\n` +
        (installed ? "" : dim("\n  Set it up with: iris node install\n")) +
        "\n",
    )
  },
})

export const PlatformNodeCommand = cmd({
  command: "node <subcommand>",
  describe: "make this machine a Hive compute node — install, status",
  builder: (y) => y.command(NodeInstallCommand).command(NodeStatusCommand).demandCommand(),
  handler: () => {},
})
