/**
 * Who may run what on a managed host — the approval policy behind `iris hive host run` (#179098).
 *
 * A remote command is the most powerful thing the CLI does, and the CLI is driven by agents as
 * often as by people. So the rule this file exists to hold: AN AGENT NEVER APPROVES ITS OWN
 * COMMAND. "Ask" means a y/N prompt at a terminal; without one, an ask is a refusal. And the
 * policy that decides what is asked can only be LOOSENED by a person at a terminal — otherwise
 * an agent refused once would set its host to `open` and run it again.
 *
 * Per host, one of three modes:
 *   confirm    every command asks a person, even read-only ones
 *   allowlist  commands matching the built-in read-only set or the host's patterns run;
 *              everything else asks a person                                   (the default)
 *   open       nothing asks — the owner chose that — and every run is still logged
 *
 * Pure: no I/O here except reading and writing the config file, so every rule is testable.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

export type HostMode = "confirm" | "allowlist" | "open"
export const HOST_MODES: HostMode[] = ["confirm", "allowlist", "open"]

export interface HostEntry {
  /** How the host is reached: an Azure VM via `az vm run-command`, or a tailnet machine via ssh. */
  via?: "az" | "ssh"
  resource_group?: string
  os?: "windows" | "linux"
  mode?: HostMode
  /** Extra commands that run without asking, as globs (`*` = anything), matched case-insensitively. */
  allow?: string[]
}

export interface HostConfig {
  hosts: Record<string, HostEntry>
}

export function hostConfigPath(): string {
  return process.env.IRIS_HIVE_HOST_CONFIG || join(homedir(), ".iris", "hive-host.json")
}

export function hostAuditPath(): string {
  return process.env.IRIS_HIVE_HOST_AUDIT || join(homedir(), ".iris", "hive-host-audit.jsonl")
}

export function readHostConfig(): HostConfig {
  try {
    const raw = JSON.parse(readFileSync(hostConfigPath(), "utf8"))
    return { hosts: raw && typeof raw.hosts === "object" ? raw.hosts : {} }
  } catch {
    return { hosts: {} }
  }
}

export function writeHostConfig(cfg: HostConfig): void {
  mkdirSync(dirname(hostConfigPath()), { recursive: true })
  writeFileSync(hostConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

export function modeOf(entry: HostEntry | undefined): HostMode {
  return entry?.mode && HOST_MODES.includes(entry.mode) ? entry.mode : "allowlist"
}

/**
 * Commands that only look. Matched on a word boundary at the START of the command, and only for a
 * command that is not compound (see below) — so `Get-Service` passes and `Get-Service; Remove-Item x`
 * does not. Reading logs is included on purpose: diagnosing a down service is the main use.
 */
export const BUILTIN_READ_ONLY = [
  // Windows
  "hostname", "whoami", "ipconfig", "systeminfo", "Get-Date", "Get-Service", "Get-Process", "Get-ComputerInfo",
  "Get-Volume", "Get-PSDrive", "Get-NetIPAddress", "Get-NetTCPConnection", "Test-NetConnection", "Get-WinEvent",
  "Get-EventLog", "Get-HotFix", "Get-LocalUser",
  // Linux / macOS
  "uptime", "uname", "df", "free", "id", "date", "systemctl status", "systemctl is-active", "journalctl", "ss -tlnp",
  "ps aux", "sw_vers", "launchctl list",
  // Both
  "tailscale status", "tailscale ip",
]

/**
 * Anything that can chain, substitute, redirect or evaluate. A compound command is never run
 * without asking, whatever the allowlist says: a pattern written for one command must not admit a
 * second one riding behind it.
 */
export function isCompound(command: string): boolean {
  return (
    /[;|&<>`\n\r]/.test(command) ||
    command.includes("$(") ||
    /\b(invoke-expression|iex|invoke-command|icm|start-process|eval|exec|sudo|su)\b/i.test(command) ||
    // `powershell -enc <base64>` runs anything; `\b-enc` never matches (no boundary before "-").
    /(^|\s)-(e|ec|enc|encodedcommand)\b/i.test(command)
  )
}

export function globMatch(pattern: string, command: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i")
  return re.test(command.trim())
}

function builtinMatch(command: string): string | null {
  const c = command.trim()
  for (const p of BUILTIN_READ_ONLY) {
    if (c.toLowerCase() === p.toLowerCase() || c.toLowerCase().startsWith(p.toLowerCase() + " ")) return p
  }
  return null
}

export type Decision =
  | { action: "run"; reason: string }
  | { action: "ask"; reason: string }
  | { action: "refuse"; reason: string }

/** What the policy says about one command. `interactive` = a person is at a terminal to answer. */
export function decide(entry: HostEntry | undefined, command: string, interactive: boolean): Decision {
  const mode = modeOf(entry)
  const ask = (reason: string): Decision =>
    interactive ? { action: "ask", reason } : { action: "refuse", reason: `${reason} — and no one is at a terminal to approve it` }

  if (!command.trim()) return { action: "refuse", reason: "empty command" }
  if (mode === "open") return { action: "run", reason: "host is in open mode" }
  if (mode === "confirm") return ask("host is in confirm mode: every command needs a person's yes")

  if (isCompound(command)) return ask("compound command (chains, pipes, redirects or evaluates), never auto-allowed")
  const builtin = builtinMatch(command)
  if (builtin) return { action: "run", reason: `read-only (${builtin})` }
  const pattern = (entry?.allow ?? []).find((p) => globMatch(p, command))
  if (pattern) return { action: "run", reason: `matches allow pattern "${pattern}"` }
  return ask("not on this host's allowlist")
}

/** Is changing `from` into `to` a loosening — something only a person at a terminal may do? */
export function loosens(from: HostEntry | undefined, to: HostEntry): boolean {
  const rank: Record<HostMode, number> = { confirm: 0, allowlist: 1, open: 2 }
  if (rank[modeOf(to)] > rank[modeOf(from)]) return true
  const before = new Set((from?.allow ?? []).map((p) => p.toLowerCase()))
  return (to.allow ?? []).some((p) => !before.has(p.toLowerCase()))
}

export interface AuditEntry {
  at: string
  host: string
  via: string
  command: string
  decision: string
  reason: string
  exit?: number | null
}

export function audit(entry: AuditEntry): void {
  try {
    mkdirSync(dirname(hostAuditPath()), { recursive: true })
    appendFileSync(hostAuditPath(), JSON.stringify(entry) + "\n", { mode: 0o600 })
  } catch {
    // An unwritable log must not block the command — but it is the record, so say so.
    console.error("warning: could not write the host audit log at " + hostAuditPath())
  }
}

// ── transport output ─────────────────────────────────────────────────────────

export const EXIT_MARK = "__IRIS_EXIT__"

/** Wrap a command so the exit status comes back — `az vm run-command` does not report one. */
export function wrapForExit(command: string, os: "windows" | "linux"): string {
  return os === "windows"
    ? `${command}\n$__irisOk = $?\n$__irisCode = if ($__irisOk) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }\n"${EXIT_MARK} $__irisCode"`
    : `${command}\n__iris_rc=$?\necho "${EXIT_MARK} $__iris_rc"`
}

/** Split `az vm run-command invoke -o json` output into stdout, stderr and the wrapped exit code. */
export function parseRunCommand(json: string): { stdout: string; stderr: string; exit: number | null } {
  let value: Array<{ code?: string; message?: string }> = []
  try {
    value = JSON.parse(json)?.value ?? []
  } catch {
    return { stdout: "", stderr: "could not read az output", exit: null }
  }
  let stdout = ""
  let stderr = ""
  for (const v of value) {
    const msg = v.message ?? ""
    if (/StdOut/i.test(v.code ?? "")) stdout += msg
    else if (/StdErr/i.test(v.code ?? "")) stderr += msg
    else {
      // Linux RunShellScript: one message "Enable succeeded: \n[stdout]\n…\n[stderr]\n…"
      const m = /\[stdout\]\n?([\s\S]*?)(?:\n?\[stderr\]\n?([\s\S]*))?$/.exec(msg)
      if (m) {
        stdout += m[1] ?? ""
        stderr += m[2] ?? ""
      } else stdout += msg
    }
  }
  return splitExit(stdout, stderr)
}

export function splitExit(stdout: string, stderr: string): { stdout: string; stderr: string; exit: number | null } {
  const re = new RegExp(`\\r?\\n?${EXIT_MARK} (-?\\d+)\\s*$`)
  const m = re.exec(stdout)
  return m
    ? { stdout: stdout.slice(0, m.index).replace(/\s+$/, ""), stderr: stderr.trim(), exit: Number(m[1]) }
    : { stdout: stdout.replace(/\s+$/, ""), stderr: stderr.trim(), exit: null }
}
