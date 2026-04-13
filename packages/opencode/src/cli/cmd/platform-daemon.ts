import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { dim, bold, success } from "./iris-api"
import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import { execSync, spawn } from "child_process"

function printDivider() {
  console.log(`  ${dim("─".repeat(56))}`)
}

function printKV(k: string, v: unknown) {
  if (v === null || v === undefined || v === "") return
  console.log(`  ${dim(k + ":")}  ${String(v)}`)
}

function getDaemonCtl(): string | null {
  const p = join(homedir(), ".iris", "bin", "iris-daemon")
  return existsSync(p) ? p : null
}

function getBridgeCtl(): string | null {
  const p = join(homedir(), ".iris", "bin", "iris-bridge")
  return existsSync(p) ? p : null
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
      prompts.log.error("Daemon not installed. Run: curl -fsSL https://heyiris.io/install-code | bash")
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

    if (!daemonUp) {
      printDivider()
      printKV("Status", "offline")
      printDivider()
      prompts.log.info(dim("Start with: iris daemon start"))
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
  command: "logs",
  describe: "show daemon logs",
  async handler() {
    const ctl = getDaemonCtl()
    if (!ctl) { prompts.log.error("Daemon not installed"); return }
    const out = runCtl(ctl, "logs")
    if (out) console.log(out)
  },
})

const DaemonRunsCommand = cmd({
  command: "runs",
  aliases: ["schedules"],
  describe: "show scheduled script runs and history",
  async handler() {
    UI.empty()
    prompts.intro("◈  Bridge Schedules")
    try {
      const res = await fetch("http://localhost:3200/daemon/schedules", { signal: AbortSignal.timeout(3000) })
      if (!res.ok) { prompts.log.error(`HTTP ${res.status}`); prompts.outro("Done"); return }
      const data = await res.json() as { schedules?: any[] }
      const schedules = data.schedules ?? []

      if (schedules.length === 0) {
        prompts.log.warn("No schedules. Create one with: iris hive schedule add <script> --cron \"...\"")
        prompts.outro("Done")
        return
      }

      console.log(`  ${dim("─".repeat(56))}`)
      for (const s of schedules) {
        const status = s.running
          ? `${UI.Style.TEXT_HIGHLIGHT}running${UI.Style.TEXT_NORMAL}`
          : s.last_status === "completed"
            ? `${UI.Style.TEXT_SUCCESS}completed${UI.Style.TEXT_NORMAL}`
            : s.last_status === "failed"
              ? `${UI.Style.TEXT_DANGER}failed${UI.Style.TEXT_NORMAL}`
              : dim("pending")

        console.log(`  ${bold(s.filename)}  ${dim(s.cron)}  ${status}`)
        console.log(`    ${dim("Runs:")} ${s.run_count}  ${dim("Last:")} ${s.last_run ? new Date(s.last_run).toLocaleString() : "never"}  ${dim("Duration:")} ${s.last_duration_ms ? `${s.last_duration_ms}ms` : "—"}`)
        console.log(`    ${dim("ID:")} ${dim(s.id)}`)
        console.log()
      }
      console.log(`  ${dim("─".repeat(56))}`)
      prompts.outro(dim("iris hive schedule list  |  iris bridge logs"))
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
      .command(DaemonRegisterCommand)
      .demandCommand(),
  async handler() {},
})
