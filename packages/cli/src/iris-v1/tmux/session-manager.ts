/**
 * TmuxSession — TypeScript/Bun tmux orchestration for IRIS CLI.
 *
 * Used by CLI commands (iris hive swarm/attach/panes) and MCP tools
 * that need direct local tmux interaction without going through the
 * daemon HTTP bridge.
 *
 * All tmux operations use -L iris (isolated socket) to avoid
 * interfering with the user's personal tmux sessions.
 */

import { $ } from "bun"
import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync, mkdirSync } from "fs"

const SOCKET = "iris"
const LOG_DIR = join(homedir(), ".iris", "tmux-logs")
const BRIDGE_URL = process.env.IRIS_BRIDGE_URL ?? "http://localhost:3200"

export namespace TmuxSession {
  export interface SessionInfo {
    name: string
    created: string
    attached: boolean
    panes: PaneInfo[]
    taskId: string | null
    type: string | null
  }

  export interface PaneInfo {
    index: number
    pid: number
    command: string
    active: boolean
    role: string | null
  }

  export interface SwarmConfig {
    prompt: string
    roles: SwarmRole[]
    model?: string
  }

  export interface SwarmRole {
    name: string
    cmd: string[]
    cwd?: string
    env?: Record<string, string>
  }

  // ── Verification ────────────────────────────────────────────────────

  export async function ensureTmux(): Promise<void> {
    const result = await $`tmux -V`.nothrow().quiet().text()
    if (!result || result.includes("not found")) {
      throw new Error(
        "tmux not found. Install with: brew install tmux (macOS) or sudo apt install tmux (Linux)"
      )
    }
    const match = result.match(/(\d+\.\d+)/)
    if (match && parseFloat(match[1]) < 3.0) {
      throw new Error(`tmux ${match[1]} found but >= 3.0 required`)
    }
  }

  // ── tmux command helpers ────────────────────────────────────────────

  async function tmux(...args: string[]): Promise<string> {
    const result = await $`tmux -L ${SOCKET} ${args}`.nothrow().quiet().text()
    return result.trim()
  }

  async function tmuxOk(...args: string[]): Promise<boolean> {
    const result = await $`tmux -L ${SOCKET} ${args}`.nothrow().quiet()
    return result.exitCode === 0
  }

  // ── Session operations ──────────────────────────────────────────────

  export async function listSessions(): Promise<SessionInfo[]> {
    const raw = await tmux(
      "list-sessions",
      "-F",
      "#{session_name}|#{session_created}|#{session_attached}"
    )
    if (!raw) return []

    const sessions: SessionInfo[] = []
    for (const line of raw.split("\n")) {
      const [name, created, attached] = line.split("|")
      if (!name?.startsWith("iris-")) continue

      const panes = await listPanes(name)
      sessions.push({
        name,
        created: created || "",
        attached: attached === "1",
        panes,
        taskId: null,
        type: null,
      })
    }
    return sessions
  }

  export async function listPanes(sessionName: string): Promise<PaneInfo[]> {
    const raw = await tmux(
      "list-panes",
      "-t",
      sessionName,
      "-F",
      "#{pane_index}|#{pane_pid}|#{pane_current_command}|#{pane_active}"
    )
    if (!raw) return []

    return raw.split("\n").map((line) => {
      const [idx, pid, cmd, active] = line.split("|")
      return {
        index: parseInt(idx) || 0,
        pid: parseInt(pid) || 0,
        command: cmd || "",
        active: active === "1",
        role: null,
      }
    })
  }

  export async function captureOutput(
    sessionName: string,
    paneIndex = 0,
    lines = 50
  ): Promise<string> {
    return tmux(
      "capture-pane",
      "-p",
      "-t",
      `${sessionName}:0.${paneIndex}`,
      "-S",
      `-${lines}`
    )
  }

  export async function isAlive(sessionName: string): Promise<boolean> {
    return tmuxOk("has-session", "-t", sessionName)
  }

  export async function killSession(sessionName: string): Promise<void> {
    await tmux("kill-session", "-t", sessionName)
  }

  export function attachSession(sessionName: string): void {
    // This replaces the current terminal — must use execSync with stdio inherit
    const { execSync } = require("child_process")
    execSync(`tmux -L ${SOCKET} attach -t ${sessionName}`, { stdio: "inherit" })
  }

  export async function sendInput(
    sessionName: string,
    paneIndex: number,
    text: string
  ): Promise<void> {
    await $`tmux -L ${SOCKET} send-keys -t ${sessionName}:0.${paneIndex} ${text} Enter`
      .nothrow()
      .quiet()
  }

  // ── Bridge proxy helpers ────────────────────────────────────────────
  // These call the daemon HTTP bridge at localhost:3200 for operations
  // that the daemon owns (task-linked sessions, swarm dispatch).

  export async function fetchBridgeSessions(): Promise<SessionInfo[]> {
    try {
      const res = await fetch(`${BRIDGE_URL}/daemon/tmux/sessions`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return []
      const data = (await res.json()) as { sessions: SessionInfo[] }
      return data.sessions || []
    } catch {
      return []
    }
  }

  export async function fetchBridgePanes(
    sessionName: string,
    lines = 20
  ): Promise<{ panes: (PaneInfo & { output: string })[] } | null> {
    try {
      const res = await fetch(
        `${BRIDGE_URL}/daemon/tmux/sessions/${sessionName}/panes?lines=${lines}`,
        { signal: AbortSignal.timeout(5000) }
      )
      if (!res.ok) return null
      return (await res.json()) as { panes: (PaneInfo & { output: string })[] }
    } catch {
      return null
    }
  }

  export async function sendBridgeInput(
    sessionName: string,
    paneIndex: number,
    text: string
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `${BRIDGE_URL}/daemon/tmux/sessions/${sessionName}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pane: paneIndex, text }),
          signal: AbortSignal.timeout(5000),
        }
      )
      return res.ok
    } catch {
      return false
    }
  }

  export async function killBridgeSession(sessionName: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${BRIDGE_URL}/daemon/tmux/sessions/${sessionName}`,
        {
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
        }
      )
      return res.ok
    } catch {
      return false
    }
  }
}
