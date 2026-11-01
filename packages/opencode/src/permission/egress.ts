// "LOCAL" DOES NOT MEAN "PRIVATE" (#192114).
//
// Measured 2026-11-01: a stand-in local model called `webfetch` with a URL holding a fake SSN. No
// prompt, and the logging server received it. A local model keeps the PROMPT at home; it can still
// send what it read out through a tool.
//
// So on a session using a local model, or one marked private, a tool that can send data off the
// machine has to be approved. The list runs the other way round: anything not known to stay on
// this machine counts as leaving it, so a new tool, MCP tool or plugin tool fails closed.
//
//   normal   no change. Whether normal sessions should ask too is a product decision, not this one.
//   local    `*: allow` no longer covers these tools. A rule the person wrote, in config or on the
//            session by the client that created it, still counts.
//   private  no rule or earlier "always" counts. Each call is asked for, or refused.
//
// This is approval, not containment. Once approved, `bash` can reach the network.
import { Wildcard } from "@/util/wildcard"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "."

export type Mode = "normal" | "local" | "private"

const STAYS_LOCAL = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "todowrite",
  "todoread",
  "question",
  "skill",
  "task",
  "plan_enter",
  "plan_exit",
  "invalid",
  "external_directory",
  "doom_loop",
])

/** Built-in tools that ask for themselves. A plugin tool does not, so the session asks for it. */
const ASKS_FOR_ITSELF = new Set([...STAYS_LOCAL, "bash", "shell", "webfetch", "websearch", "codesearch"])

export function sendsDataOut(permission: string) {
  return !STAYS_LOCAL.has(permission)
}

export function asksForItself(tool: string) {
  return ASKS_FOR_ITSELF.has(tool)
}

export function isLocalUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".ts.net")) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const a = Number(v4[1])
  const b = Number(v4[2])
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // Tailscale's range
  )
}

export function isPrivate(env: Record<string, string | undefined> = process.env) {
  const value = (env.IRIS_PRIVATE ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

export function mode(input: { modelUrl?: unknown; env?: Record<string, string | undefined> }): Mode {
  if (isPrivate(input.env ?? process.env)) return "private"
  return isLocalUrl(input.modelUrl) ? "local" : "normal"
}

/** `ruleset`, plus an ask for this call when the guard applies. A deny is never loosened. */
export function tighten(input: {
  mode: Mode
  permission: string
  patterns: readonly string[]
  ruleset: PermissionV1.Ruleset
  explicit: PermissionV1.Ruleset
}): PermissionV1.Ruleset {
  if (input.mode === "normal" || !sendsDataOut(input.permission)) return input.ruleset
  if (input.patterns.some((p) => Permission.evaluate(input.permission, p, input.ruleset).action === "deny"))
    return input.ruleset
  if (input.mode === "local") {
    const written = (pattern: string) =>
      input.explicit.findLast(
        (rule) => Wildcard.match(input.permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
      )?.action === "allow"
    if (input.patterns.length > 0 && input.patterns.every(written)) return input.ruleset
  }
  return [...input.ruleset, { permission: input.permission, pattern: "*", action: "ask" }]
}

export * as Egress from "./egress"
