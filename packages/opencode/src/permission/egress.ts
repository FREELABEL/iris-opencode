/**
 * "LOCAL" DOES NOT MEAN "PRIVATE" (#192114).
 *
 * Measured 2026-11-01: a stand-in local model called `webfetch` with a URL holding a fake SSN. No
 * prompt, and the logging server received it. A local model means the PROMPT stays home; the model
 * can still send anything it read out through a tool, whether it was poisoned, it read a malicious
 * document, or it simply made a mistake.
 *
 * So for a session on a local model, or one marked private, a tool that can send data off the
 * machine must be approved. Allow-listed the other way round: anything not known to stay on this
 * machine counts as leaving it, so a new tool, MCP tool or plugin tool fails closed.
 *
 *   normal   no change. Whether normal sessions should ask too is a product decision, not this one.
 *   local    `*: allow` no longer covers these tools. A rule the person wrote, in config or on the
 *            session by the client that created it, still counts.
 *   private  no rule or earlier "always" counts. Each call is asked for, or refused.
 *
 * This is approval, not containment. `bash` asking first does not put the command in a sandbox:
 * once approved, it can reach the network. See #192103 and the daemon `--network none` plan.
 */
import type { Config } from "@/config/config"
import { PermissionNext } from "./next"
import { Wildcard } from "@/util/wildcard"

export namespace Egress {
  export type Mode = "normal" | "local" | "private"

  /** Permissions that read or change only this machine. Everything else may send data out. */
  const STAYS_LOCAL = new Set([
    "read",
    "glob",
    "grep",
    "list",
    "lsp",
    "edit",
    "write",
    "patch",
    "multiedit",
    "todoread",
    "todowrite",
    "question",
    "skill",
    "task", // A subagent on another model asks through `subagent_model`; its tools are guarded too.
    "batch", // Each call inside it asks for itself.
    "invalid",
    "external_directory",
    "doom_loop",
  ])

  /** Built-in tools that call ctx.ask themselves. Plugin tools do not, so the prompt loop asks for them. */
  const ASKS_FOR_ITSELF = new Set([...STAYS_LOCAL, "bash", "webfetch", "websearch", "codesearch"])

  export function sendsDataOut(permission: string) {
    return !STAYS_LOCAL.has(permission)
  }

  export function asksForItself(tool: string) {
    return ASKS_FOR_ITSELF.has(tool)
  }

  export function isLocalUrl(url: string | undefined): boolean {
    if (!url) return false
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

  /**
   * The one bit `iris run --private` (#192103) needs to set. Read per call so a flag set during
   * startup counts.
   */
  export function isPrivate(env: Record<string, string | undefined> = process.env) {
    const value = (env.IRIS_PRIVATE ?? "").trim().toLowerCase()
    return value === "1" || value === "true"
  }

  export function mode(input: { modelUrl?: string; env?: Record<string, string | undefined> }): Mode {
    if (isPrivate(input.env ?? process.env)) return "private"
    return isLocalUrl(input.modelUrl) ? "local" : "normal"
  }

  /** The rules the person wrote: global or project `permission`, and this agent's. */
  export function explicitRules(config: Pick<Config.Info, "permission" | "agent">, agent: string) {
    return PermissionNext.merge(
      PermissionNext.fromConfig(config.permission ?? {}),
      PermissionNext.fromConfig(config.agent?.[agent]?.permission ?? {}),
    )
  }

  /**
   * `ruleset`, plus an ask for this call when the guard applies. Appended, because the last match
   * wins; a pattern already denied keeps it so nothing here can loosen a deny.
   */
  export function tighten(input: {
    mode: Mode
    permission: string
    patterns: string[]
    ruleset: PermissionNext.Ruleset
    explicit: PermissionNext.Ruleset
  }): PermissionNext.Ruleset {
    if (input.mode === "normal" || !sendsDataOut(input.permission)) return input.ruleset
    if (input.patterns.some((p) => PermissionNext.evaluate(input.permission, p, input.ruleset).action === "deny"))
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

  // ── Is anybody there to ask? ────────────────────────────────────────────────────────────────

  let listening = false
  let eventClients = 0

  export function serverListening(value: boolean) {
    listening = value
  }

  /** Counts a client on the event stream, the only way a prompt reaches a person. Returns the release. */
  export function eventClientConnected() {
    eventClients++
    let released = false
    return () => {
      if (released) return
      released = true
      eventClients--
    }
  }

  /** A server with nobody on its event stream: `iris serve` alone. The prompt would wait forever. */
  export function unattended() {
    return listening && eventClients === 0
  }
}
