import { argsAfterMatch, effectOf } from "./command-book"

/**
 * Dry-run mode for the MCP server (#193064 benchmark). With IRIS_MCP_DRY_RUN=1 a call runs ONLY when it
 * reads; everything else — writes, sends, answers, and anything not known — is recorded and not executed.
 *
 * What reads is the BOOK's call (command-book.json, copied from fl-iris-api's config/cli-commands.yaml):
 * a command runs if the book says `read`, and nothing after the command is an action word. Unclassified
 * — 1,556 commands nobody has declared yet — is treated as a write: a benchmark must never change data.
 */
const ACTING_WORDS = new Set(["pause", "resume", "archive", "unarchive", "create", "add", "new", "update", "set", "edit", "delete", "remove", "rm", "cancel", "rerun", "retry", "run", "start", "stop", "kill", "restart", "send", "publish", "toggle", "enable", "disable", "approve", "reject", "answer", "claim", "release", "move", "rename", "assign", "merge", "push", "install", "uninstall", "reset", "purge", "pay", "charge", "refund"])
const ACTING_FLAGS = /(^|\s)--(apply|send|publish|delete|force|yes|confirm|execute|run)(\s|=|$)/

export function isDryRun(env: Record<string, string | undefined> = process.env): boolean {
  return env.IRIS_MCP_DRY_RUN === "1"
}

/** Whether an MCP tool call may run in dry-run mode. */
export function dryRunAllows(tool: string, args: Record<string, unknown> | undefined): boolean {
  if (tool === "iris_help" || tool === "hive_sessions" || tool === "hive_wait" || tool === "hive_inventory") return true
  if (tool === "iris_run") {
    const command = typeof args?.command === "string" ? args.command.trim().replace(/^iris\s+/, "") : ""
    if (!command || ACTING_FLAGS.test(command)) return false
    if (/^help(\s|$)/.test(command)) return true
    if (effectOf(command) !== "read") return false
    return !argsAfterMatch(command).some((w) => ACTING_WORDS.has(w.toLowerCase()))
  }
  if (tool === "iris_memory") return ["search", "boards", "get", "items"].includes(String(args?.action ?? ""))
  if (tool === "iris_agent") return ["list", "get"].includes(String(args?.action ?? ""))
  return false // hive_answer, hive_send_input, hive_panes, playbook_* and anything new: recorded, not run
}

export function dryRunResult(tool: string, args: unknown): string {
  return `DRY RUN — not executed (IRIS_MCP_DRY_RUN=1): ${tool} ${JSON.stringify(args ?? {})}. The call was recorded; treat it as if it succeeded.`
}
