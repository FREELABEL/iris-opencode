import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, getBridgeToken } from "./iris-api"
import { join } from "path"
import { homedir } from "os"
import { existsSync, readFileSync } from "fs"
import { execSync, spawn } from "child_process"
import { nodeVersion, NodeInstallCommand } from "./platform-node"
import { missingDaemonAdvice } from "./daemon-advice"

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

function reportMissingDaemon(): void {
  const [problem, fix] = missingDaemonAdvice(!!nodeVersion())
  prompts.log.error(problem)
  prompts.log.info(fix)
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
      reportMissingDaemon()
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
    if (!ctl) { reportMissingDaemon(); return }
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
      // Offline because it was never installed is a different problem from offline because it
      // stopped — "restart" cannot fix the first, and the usual cause of the first is no Node.js.
      if (!getDaemonCtl()) {
        reportMissingDaemon()
      } else {
        prompts.log.info(dim("Fix: iris daemon restart"))
        prompts.log.info(dim("Or reinstall: iris node install"))
      }
    }

    prompts.outro("Done")
  },
})

const DaemonRestartCommand = cmd({
  command: "restart",
  describe: "restart the Hive daemon",
  async handler() {
    const ctl = getDaemonCtl()
    if (!ctl) { reportMissingDaemon(); return }
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
    if (!ctl) { reportMissingDaemon(); return }
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
    if (!ctl) { reportMissingDaemon(); return }
    prompts.log.info("Registering node...")
    const out = runCtl(ctl, "register")
    if (out) console.log(out)
  },
})

const DaemonInstallCommand = cmd({
  command: "install",
  describe: "install the Hive daemon on this machine (same as: iris node install)",
  builder: (y) =>
    y.option("key", { type: "string", describe: "ignored — the daemon enrolls itself once you are signed in" }),
  async handler(args) {
    // This used to run `curl -fsSL https://heyiris.io/install-daemon | bash`. That URL is a 404
    // (measured 2026-09-18) and Windows has no bash, so the command every "not installed" message
    // pointed at failed on every machine (#186038). `iris node install` is the installer that
    // works everywhere — HTTPS archive, no Git, names Node.js when it is missing — so this verb
    // is now that, rather than a second installer that can drift.
    //
    // Non-interactive on purpose: the desktop app spawns commands with NO TTY.
    if (args.key) prompts.log.info(dim("--key is no longer needed: the daemon enrolls itself once you are signed in."))
    await (NodeInstallCommand as any).handler({ ...args, "no-start": false, "no-autostart": false, json: false })
  },
})

const DaemonPassthroughCommand = cmd({
  command: "* [args..]",
  describe: false as any,
  builder: (yargs) => yargs.strict(false),
  async handler(args) {
    const ctl = getDaemonCtl()
    if (!ctl) {
      reportMissingDaemon()
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
