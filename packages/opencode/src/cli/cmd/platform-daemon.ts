import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, getBridgeToken } from "./iris-api"
import { join } from "path"
import { homedir } from "os"
import { existsSync, readFileSync } from "fs"
import { execSync, spawn } from "child_process"

function printDivider() {
  console.log(`  ${dim("─".repeat(56))}`)
}

function printKV(k: string, v: unknown) {
  if (v === null || v === undefined || v === "") return
  console.log(`  ${dim(k + ":")}  ${String(v)}`)
}

function getDaemonCtl(): string | null {
  const ext = process.platform === "win32" ? ".cmd" : ""
  const p = join(homedir(), ".iris", "bin", `iris-daemon${ext}`)
  return existsSync(p) ? p : null
}

function getBridgeCtl(): string | null {
  const ext = process.platform === "win32" ? ".cmd" : ""
  const p = join(homedir(), ".iris", "bin", `iris-bridge${ext}`)
  return existsSync(p) ? p : null
}

function getInstallHint(): string {
  // `iris daemon install`, NOT the CLI installer. This used to return the install-code
  // one-liner, which installs the CLI and does nothing for the daemon — so every
  // "Daemon not installed" message named a fix that could not fix it.
  return "iris daemon install"
}

function runCtl(ctl: string, action: string): string {
  try {
    return execSync(`${ctl} ${action} 2>&1`, { timeout: 10000 }).toString().trim()
  } catch (e: any) {
    return e.stdout?.toString?.() || e.stderr?.toString?.() || e.message
  }
}

const DaemonStartCommand = cmd({
  command: "start",
  describe: "start the Hive daemon",
  async handler() {
    const ctl = getDaemonCtl()
    if (!ctl) {
      prompts.log.error(`Daemon not installed. Run: ${getInstallHint()}`)
      return
    }
    prompts.log.info("Starting daemon...")
    const out = runCtl(ctl, "start")
    if (out) console.log(out)
  },
})

const DaemonStopCommand = cmd({
  command: "stop",
  describe: "stop the Hive daemon",
  async handler() {
    const ctl = getDaemonCtl()
    if (!ctl) { prompts.log.error("Daemon not installed"); return }
    const out = runCtl(ctl, "stop")
    if (out) console.log(out)
  },
})

const DaemonStatusCommand = cmd({
  command: "status",
  describe: "show daemon and bridge status",
  async handler() {
    UI.empty()
    prompts.intro("◈  IRIS Daemon")

    // Check daemon health
    let daemonUp = false
    try {
      const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        daemonUp = true
        const data = await res.json() as Record<string, any>
        printDivider()
        printKV("Status", success("online"))
        printKV("Node", data.node_name ?? data.hostname)
        printKV("Tasks", data.active_tasks ?? 0)
        printKV("Schedules", data.schedules ?? 0)
        printKV("CPU", data.cpu_percent ? `${data.cpu_percent}%` : null)
        printKV("Memory", data.memory_free ? `${data.memory_free} free` : null)
        printKV("API", data.api_url)
        printDivider()
      }
    } catch {}

    // Read status.json for cloud + heartbeat health (written by daemon)
    const statusPath = join(homedir(), ".iris", "status.json")
    if (existsSync(statusPath)) {
      try {
        const st = JSON.parse(readFileSync(statusPath, "utf-8"))
        if (daemonUp) {
          printKV("Cloud", st.status === "active" ? success("connected") : `OFFLINE — ${st.error || "unknown"}`)
          if (st.heartbeat) {
            const hbState = st.heartbeat.state === "closed"
              ? success(`healthy (${st.heartbeat.fail_count} failures)`)
              : `${st.heartbeat.state} (${st.heartbeat.fail_count} failures)`
            printKV("Heartbeat", hbState)
          }
          printKV("Node ID", st.node_id || "not registered")
          if (st.running_tasks !== undefined) printKV("Tasks", `${st.running_tasks} active`)
          if (st.uptime_s) printKV("Uptime", `${Math.floor(st.uptime_s / 60)}m`)
          printDivider()
        }
      } catch {}
    }

    if (!daemonUp) {
      printDivider()
      printKV("Status", "offline")
      // Show last error from status.json if available
      if (existsSync(statusPath)) {
        try {
          const st = JSON.parse(readFileSync(statusPath, "utf-8"))
          if (st.error) printKV("Last error", st.error)
        } catch {}
      }
      printDivider()
      prompts.log.info(dim("Fix: iris daemon restart"))
      prompts.log.info(dim("Or:  curl -fsSL https://heyiris.io/install-code | bash"))
    }

    prompts.outro("Done")
  },
})

const DaemonRestartCommand = cmd({
  command: "restart",
  describe: "restart the Hive daemon",
  async handler() {
    const ctl = getDaemonCtl()
    if (!ctl) { prompts.log.error("Daemon not installed"); return }
    prompts.log.info("Restarting daemon...")
    const out = runCtl(ctl, "restart")
    if (out) console.log(out)
  },
})

const DaemonLogsCommand = cmd({
  command: "logs [lines]",
  describe: "show daemon logs (default: last 100 lines + follow)",
  builder: (yargs) =>
    yargs
      .positional("lines", { describe: "number of lines to show", type: "number", default: 100 })
      .option("no-follow", { alias: "n", describe: "don't follow (just print and exit)", type: "boolean", default: false }),
  async handler(args) {
    const ctl = getDaemonCtl()
    if (!ctl) { prompts.log.error("Daemon not installed"); return }
    const logFile = join(homedir(), ".iris", "bridge", "daemon.log")
    if (!existsSync(logFile)) { prompts.log.error("No log file found"); return }
    const lines = (args as any).lines ?? 100
    const noFollow = (args as any).noFollow ?? false
    if (process.platform === "win32") {
      // Windows: use PowerShell for tail-like behavior
      if (noFollow) {
        const out = execSync(`powershell -Command "Get-Content '${logFile}' -Tail ${lines}"`, { timeout: 5000 }).toString()
        if (out) console.log(out)
      } else {
        const child = spawn("powershell", ["-Command", `Get-Content '${logFile}' -Tail ${lines} -Wait`], { stdio: "inherit" })
        process.on("SIGINT", () => { child.kill(); process.exit(0) })
      }
    } else {
      if (noFollow) {
        const out = execSync(`tail -n ${lines} "${logFile}"`, { timeout: 5000 }).toString()
        if (out) console.log(out)
      } else {
        const child = spawn("tail", ["-n", String(lines), "-F", logFile], { stdio: "inherit" })
        process.on("SIGINT", () => { child.kill(); process.exit(0) })
      }
    }
  },
})

const DaemonRunsCommand = cmd({
  command: "runs",
  aliases: ["schedules"],
  describe: "show scheduled script runs, output, and source code",
  builder: (yargs) =>
    yargs
      .option("output", { alias: "o", describe: "show last run stdout", type: "boolean", default: false })
      .option("code", { alias: "c", describe: "show script source code", type: "boolean", default: false })
      .option("all", { alias: "a", describe: "show everything (output + code)", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Bridge Schedules")

    const showOutput = args.all || args.output
    const showCode = args.all || args.code

    try {
      const _dh: Record<string, string> = { Accept: "application/json" }
      const _dt = getBridgeToken(); if (_dt) _dh["X-Bridge-Key"] = _dt
      const res = await fetch("http://localhost:3200/daemon/schedules", { signal: AbortSignal.timeout(3000), headers: _dh })
      if (!res.ok) { prompts.log.error(`HTTP ${res.status}`); prompts.outro("Done"); return }
      const data = await res.json() as { schedules?: any[] }
      const schedules = data.schedules ?? []

      if (schedules.length === 0) {
        prompts.log.warn("No schedules. Create one with: iris hive schedule add <script> --cron \"...\"")
        prompts.outro("Done")
        return
      }

      console.log(`  ${dim("─".repeat(60))}`)
      for (const s of schedules) {
        const status = s.running
          ? `${UI.Style.TEXT_HIGHLIGHT}● running${UI.Style.TEXT_NORMAL}`
          : s.last_status === "completed"
            ? `${UI.Style.TEXT_SUCCESS}● completed${UI.Style.TEXT_NORMAL}`
            : s.last_status === "failed"
              ? `${UI.Style.TEXT_DANGER}● failed${UI.Style.TEXT_NORMAL}`
              : dim("○ pending")

        console.log(`  ${bold(s.filename)}  ${dim(s.cron)}  ${status}`)
        console.log(`    ${dim("Runs:")} ${s.run_count}  ${dim("Last:")} ${s.last_run ? new Date(s.last_run).toLocaleString() : "never"}  ${dim("Duration:")} ${s.last_duration_ms ? `${s.last_duration_ms}ms` : "—"}`)
        if (s.last_exit_code !== undefined && s.last_exit_code !== null) {
          console.log(`    ${dim("Exit:")} ${s.last_exit_code === 0 ? "0" : `${UI.Style.TEXT_DANGER}${s.last_exit_code}${UI.Style.TEXT_NORMAL}`}`)
        }
        console.log(`    ${dim("ID:")} ${dim(s.id)}`)

        // Show last stdout
        if (showOutput && s.last_stdout) {
          console.log()
          console.log(`    ${dim("── Last Output ──────────────────────────────────")}`)
          for (const line of s.last_stdout.trim().split("\n").slice(-20)) {
            console.log(`    ${line}`)
          }
          if (s.last_stderr) {
            console.log(`    ${dim("── Stderr ──")}`)
            for (const line of s.last_stderr.trim().split("\n").slice(-5)) {
              console.log(`    ${UI.Style.TEXT_DANGER}${line}${UI.Style.TEXT_NORMAL}`)
            }
          }
        }

        // Show script source code
        if (showCode) {
          const { existsSync, readFileSync } = await import("fs")
          const { join: pathJoin } = await import("path")
          const { homedir: osHome } = await import("os")
          // Check multiple script locations (data/scripts from daemon, scripts/ from user)
          const candidates = [
            pathJoin(osHome(), ".iris", "data", "scripts", s.filename),
            pathJoin(osHome(), ".iris", "scripts", s.filename),
            pathJoin(osHome(), ".iris", "bridge", "scripts", s.filename),
          ]
          const scriptPath = candidates.find(p => existsSync(p)) ?? candidates[0]
          if (existsSync(scriptPath)) {
            const code = readFileSync(scriptPath, "utf-8")
            console.log()
            console.log(`    ${dim("── Source (" + s.filename + ") ──────────────────────")}`)
            for (const line of code.split("\n")) {
              console.log(`    ${dim(line)}`)
            }
          }
        }

        console.log()
      }
      console.log(`  ${dim("─".repeat(60))}`)
      if (!showOutput && !showCode) {
        prompts.log.info(dim("iris bridge runs -o     show last output"))
        prompts.log.info(dim("iris bridge runs -c     show script code"))
        prompts.log.info(dim("iris bridge runs -a     show everything"))
      }
      prompts.outro("Done")
    } catch (err) {
      prompts.log.error("Daemon not reachable on :3200. Is it running?")
      prompts.log.info(dim("Start with: iris bridge start"))
      prompts.outro("Done")
    }
  },
})

const DaemonRegisterCommand = cmd({
  command: "register",
  describe: "register this machine as a Hive compute node",
  async handler() {
    const ctl = getDaemonCtl()
    if (!ctl) { prompts.log.error("Daemon not installed"); return }
    prompts.log.info("Registering node...")
    const out = runCtl(ctl, "register")
    if (out) console.log(out)
  },
})

const DaemonInstallCommand = cmd({
  command: "install",
  describe: "install the Hive daemon on this machine",
  builder: (y) =>
    y.option("key", { type: "string", describe: "node key (otherwise registered interactively later)" }),
  async handler(args) {
    // This verb did not exist, and its absence was load-bearing.
    //
    // `iris daemon start/status/register` all reported "Daemon not installed" and pointed at
    // getInstallHint() — which returns the CLI installer. That does NOT install the daemon;
    // the daemon has its own installer at /install-daemon. So the error named a fix that
    // could not work, and a client spent 2026-08-31 discovering the real one by hand.
    //
    // Non-interactive on purpose: the desktop app spawns commands with NO TTY, so anything
    // that prompts fails silently there. That is the same constraint that makes `auth login`
    // impossible to shell out to from the app.
    if (getDaemonCtl()) {
      prompts.log.info("Daemon already installed. Use `iris daemon status` to check it.")
      return
    }

    const url = "https://heyiris.io/install-daemon"
    prompts.log.info(`Installing the Hive daemon from ${url}`)
    const keyArg = args.key ? ` --key ${String(args.key).replace(/[^A-Za-z0-9_-]/g, "")}` : ""

    try {
      // Pipe to bash rather than downloading to a temp file: matches the documented one-liner,
      // and keeps the daemon installer the single source of truth for its own steps.
      const out = execSync(`curl -fsSL ${url} | bash -s --${keyArg} 2>&1`, {
        timeout: 300000,
        maxBuffer: 32 * 1024 * 1024,
      })
        .toString()
        .trim()
      if (out) console.log(out)
    } catch (e: any) {
      const detail = (e?.stdout?.toString() || e?.stderr?.toString() || e?.message || "").trim()
      prompts.log.error("Daemon install failed.")
      if (detail) console.log(detail.split("\n").slice(-20).join("\n"))
      return
    }

    // Installed is not working — verify, the way a human would.
    if (!getDaemonCtl()) {
      prompts.log.error("Install reported success but the daemon control script is still missing.")
      return
    }
    prompts.log.info(`${success("✓")} Daemon installed. Next: ${bold("iris daemon register")}`)
  },
})

const DaemonPassthroughCommand = cmd({
  command: "* [args..]",
  describe: false as any,
  builder: (yargs) => yargs.strict(false),
  async handler(args) {
    const ctl = getDaemonCtl()
    if (!ctl) {
      prompts.log.error(`Daemon not installed. Run: ${getInstallHint()}`)
      return
    }
    // Forward all unrecognized args to daemonctl
    const rawArgs = (args._ as string[]).slice(1) // strip "bridge"/"daemon" prefix
    const extraArgs = (args.args as string[]) || []
    const allArgs = [...rawArgs, ...extraArgs]
    if (allArgs.length === 0) {
      prompts.log.error("No subcommand provided")
      return
    }
    prompts.log.info(`Forwarding to daemonctl: ${allArgs.join(" ")}`)
    try {
      const child = spawn(ctl, allArgs, { stdio: "inherit" })
      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`daemonctl exited with code ${code}`))
          else resolve()
        })
        child.on("error", reject)
      })
    } catch (e: any) {
      prompts.log.error(e.message)
    }
  },
})

export const PlatformDaemonCommand = cmd({
  command: "bridge",
  aliases: ["daemon"],
  describe: "manage the IRIS bridge — start, stop, status, restart, logs, register",
  builder: (yargs) =>
    yargs
      .command(DaemonStartCommand)
      .command(DaemonStopCommand)
      .command(DaemonStatusCommand)
      .command(DaemonRestartCommand)
      .command(DaemonLogsCommand)
      .command(DaemonRunsCommand)
      .command(DaemonInstallCommand)
      .command(DaemonRegisterCommand)
      .command(DaemonPassthroughCommand)
      .strict(false),
  async handler() {},
})
