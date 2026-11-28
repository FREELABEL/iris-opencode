export * as Egress from "./egress.js"

// "LOCAL" DOES NOT MEAN "PRIVATE" (#192114). Measured 2026-11-01: a stand-in local model called
// `webfetch` with a URL holding a fake SSN. No prompt, and the logging server received it. A local
// model keeps the PROMPT at home; it can still send what it read out through a tool.
//
// So on a session using a local model, or one marked private, a tool that can send data off the
// machine has to be approved. The list runs the other way round: anything not known to stay on
// this machine counts as leaving it, so a new tool, MCP tool or plugin tool fails closed.
//
//   normal   no change. Whether normal sessions should ask too is a product decision, not this one.
//   local    `*: allow` no longer covers these tools. A rule the person wrote, in config or on the
//            session by the client that created it, or an "always" they answered, still counts.
//   private  neither counts. Each call is asked for; with nobody to answer, it is refused.
//
// This is approval, not containment. Once approved, `shell` can reach the network. See #192103 and
// the daemon `--network none` plan.
export type Mode = "normal" | "local" | "private"

const STAYS_LOCAL = new Set([
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "patch",
  "question",
  "skill",
  "external_directory",
  "subagent", // A subagent's own tool calls are guarded; one pinned to a hosted model is checked in the plugin.
])

export function sendsDataOut(action: string) {
  return !STAYS_LOCAL.has(action)
}

export function isLocalUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false
  const parsed = URL.parse(url)
  if (!parsed) return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
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

/** The one bit `iris run --private` (#192103) needs to set. */
export function isPrivate(env: Record<string, string | undefined> = process.env) {
  const value = (env.IRIS_PRIVATE ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

export function mode(input: { readonly modelUrl?: unknown; readonly env?: Record<string, string | undefined> }): Mode {
  if (isPrivate(input.env ?? process.env)) return "private"
  return isLocalUrl(input.modelUrl) ? "local" : "normal"
}
