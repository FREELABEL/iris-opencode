import os from "os"
import { FL_API, IRIS_API, irisFetch } from "./platform"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

/**
 * "Report" on a failed command in the desktop (#189435). The user presses it, reads exactly what
 * will be sent, and sends it; this files it on the IRIS bug board the same way `iris bug report`
 * does (POST /api/v1/public/bug-report, then the IRIS API host if fl-api answers 5xx).
 *
 * Nothing here runs on its own. The command and its output only leave the machine on that press,
 * and secrets are scrubbed first.
 */
export type CommandReport = {
  tool: string
  command: string
  error: string
  output?: string
  note?: string
}

const OUTPUT_LINES = 40
const FIELD_MAX = 4000

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [redacted]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "$1-[redacted]"],
  [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}/g, "$1_[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox-[redacted]"],
  [/\bnode_live_[A-Za-z0-9]{8,}/g, "node_live_[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]"],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS))=("[^"]*"|'[^']*'|\S+)/g, "$1=[redacted]"],
  [/(--?(?:token|api[-_]?key|password|secret)[= ])("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]"],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@"],
]

/** Removes things that look like credentials. Best effort; the user also sees the text before it is sent. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
}

const clip = (text: string, max = FIELD_MAX) => (text.length > max ? text.slice(0, max) + "\n… (cut)" : text)

export function tailLines(text: string, n = OUTPUT_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n")
  return lines.length > n ? lines.slice(-n).join("\n") : lines.join("\n")
}

/** The first word or two of a command: what the title names, never its arguments. */
export function commandHead(command: string): string {
  const words = command.trim().split(/\s+/).filter((w) => w && !/^[A-Z_]+=/.test(w))
  if (!words.length) return "command"
  return words[0] === "iris" || words[0] === "bun" || words[0] === "npm" || words[0] === "git"
    ? words.slice(0, 2).join(" ")
    : words[0]
}

export function buildCommandReport(input: CommandReport, version = InstallationVersion) {
  const command = clip(redact(input.command), 1000)
  const error = clip(redact(input.error), 1000)
  const output = input.output ? clip(redact(tailLines(input.output))) : undefined
  const head = redact(commandHead(input.command))
  const description = [
    input.note?.trim() ? `**What the user was doing:** ${clip(redact(input.note.trim()), 2000)}` : undefined,
    `**Reported from IRIS Desktop** ${version} · ${os.platform()} ${os.arch()} · tool \`${input.tool}\``,
    "",
    "**Command**",
    "```",
    command,
    "```",
    `**Result:** ${error}`,
    output ? ["", `**Last ${OUTPUT_LINES} lines of output**`, "```", output, "```"].join("\n") : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
  return {
    title: clip(`Desktop: \`${head}\` failed (${error.split("\n")[0]})`, 180),
    description,
    severity: "medium",
    command,
    error,
  }
}

export async function submitCommandReport(
  input: CommandReport,
): Promise<{ ok: true; itemId?: number } | { ok: false; reason: string }> {
  const report = buildCommandReport(input)
  const body = JSON.stringify({
    ...report,
    system_info: { source: "desktop", version: InstallationVersion, platform: os.platform(), arch: os.arch() },
  })
  const send = (base: string) =>
    irisFetch("/api/v1/public/bug-report", base, { method: "POST", body, signal: AbortSignal.timeout(15_000) })
  try {
    let res = await send(FL_API)
    // Same fallback as `iris bug report`: a reporter with no second route loses the report.
    if (!res.ok && res.status >= 500) res = await send(IRIS_API).catch(() => res)
    if (!res.ok) return { ok: false, reason: `The bug board answered ${res.status}. Try again in a minute.` }
    const json = (await res.json().catch(() => ({}))) as { data?: { item_id?: number }; item_id?: number }
    return { ok: true, itemId: json.data?.item_id ?? json.item_id }
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "No answer in 15s. Check your connection." : "Could not reach the bug board." }
  }
}
