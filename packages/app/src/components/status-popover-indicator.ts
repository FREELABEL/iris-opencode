import type { LspStatus } from "@opencode-ai/sdk/v2/client"
import type { McpServer } from "@opencode-ai/client/promise"

export function hasServiceNeedingAttention(input: { mcp: Array<McpServer["status"]["status"]> }) {
  return input.mcp.some((status) => status === "needs_auth" || status === "needs_client_registration")
}

export function hasNonBlockingServiceIssue(input: {
  mcp: Array<McpServer["status"]["status"]>
  lsp: Array<LspStatus["status"]>
}) {
  return (
    input.mcp.some((status) => status !== "connected" && status !== "pending" && status !== "disabled") ||
    input.lsp.some((status) => status === "error")
  )
}

export function serverStatusDotClass(input: {
  ready: boolean
  serverHealth: boolean | undefined
  attention?: boolean
  issue: boolean
}) {
  if (input.serverHealth === false) return "bg-icon-critical-base"
  if (!input.ready || input.serverHealth === undefined) return "bg-border-weak-base"
  if (input.attention) return "bg-v2-background-bg-accent"
  if (input.issue) return "bg-icon-warning-base"
  if (input.serverHealth === true) return "bg-icon-success-base"
  return "bg-border-weak-base"
}

/**
 * WHICH i18n KEY EXPLAINS THE DOT (#186524).
 *
 * The dot carried colour and nothing else: a client asked what the green dot meant and had to
 * be told out loud. Colour is a recall test — you either remember the legend or you do not —
 * and there was no legend anywhere in the app. The same four states that pick the colour pick
 * a sentence, so the two can never drift apart.
 *
 * Returned as a KEY, not a string: this app ships ~40 locales, and a hardcoded English tooltip
 * would be a regression everywhere but here.
 */
export function serverStatusDotLabelKey(input: {
  ready: boolean
  serverHealth: boolean | undefined
  attention?: boolean
  issue: boolean
}): string {
  if (input.serverHealth === false) return "status.dot.offline"
  if (!input.ready || input.serverHealth === undefined) return "status.dot.connecting"
  if (input.attention) return "status.dot.attention"
  if (input.issue) return "status.dot.issue"
  return "status.dot.healthy"
}
