/**
 * Dry-run mode for the MCP server (#193064 benchmark). With IRIS_MCP_DRY_RUN=1 a call runs ONLY when
 * it is known to read; everything else — writes, sends, answers, and anything not known — is recorded
 * and not executed. Unknown is treated as a write on purpose: a benchmark must never change real data.
 *
 * Interim: the read verbs below are a small allowlist until the book (#193064 decision 1) declares an
 * effect for every command; then this asks the book instead.
 */
const READ_VERBS = new Set(["list", "ls", "get", "show", "search", "items", "item", "tasks", "nodes", "sessions", "status", "view", "inventory", "help", "query", "members"])
// Whole commands that only read, run with no subcommand.
const READ_COMMANDS = new Set(["usage", "heartbeats", "models", "whoami", "help", "find"])
// A read verb followed by one of these is a write: `hive tasks create`, `hive nodes remove`, `bloqs items 297 delete 5`.
const ACTING_WORDS = new Set(["pause", "resume", "archive", "unarchive", "create", "add", "new", "update", "set", "edit", "delete", "remove", "rm", "cancel", "rerun", "retry", "run", "start", "stop", "kill", "restart", "send", "publish", "toggle", "enable", "disable", "approve", "reject", "answer", "claim", "release", "move", "rename", "assign", "merge", "push", "install", "uninstall", "reset", "purge", "pay", "charge", "refund"])
// Flags that turn a read verb into an action somewhere (e.g. `sessions … --follow` streams, fine; these are not).
const ACTING_FLAGS = /(^|\s)--(apply|send|publish|delete|force|yes|confirm|execute|run)(\s|=|$)/

export function isDryRun(env: Record<string, string | undefined> = process.env): boolean {
  return env.IRIS_MCP_DRY_RUN === "1"
}

/** Whether an MCP tool call may run in dry-run mode. */
export function dryRunAllows(tool: string, args: Record<string, unknown> | undefined): boolean {
  if (tool === "iris_help" || tool === "hive_sessions" || tool === "hive_wait" || tool === "hive_inventory") return true
  if (tool === "iris_run") {
    const command = typeof args?.command === "string" ? args.command.trim() : ""
    const words = command.split(/\s+/).filter((w) => w && !w.startsWith("-"))
    if (ACTING_FLAGS.test(command)) return false
    if (READ_COMMANDS.has(words[0])) return !words.slice(1).some((w) => ACTING_WORDS.has(w.toLowerCase()))
    if (words.length < 2) return false
    if (words.slice(2).some((w) => ACTING_WORDS.has(w.toLowerCase()))) return false
    return words[0] === "help" || READ_VERBS.has(words[1]) || words[1].startsWith("get-") || words[1].startsWith("list-")
  }
  if (tool === "iris_memory") return ["search", "boards", "get", "items"].includes(String(args?.action ?? ""))
  if (tool === "iris_agent") return ["list", "get"].includes(String(args?.action ?? ""))
  return false // hive_answer, hive_send_input, hive_panes, playbook_* and anything new: recorded, not run
}

export function dryRunResult(tool: string, args: unknown): string {
  return `DRY RUN — not executed (IRIS_MCP_DRY_RUN=1): ${tool} ${JSON.stringify(args ?? {})}. The call was recorded; treat it as if it succeeded.`
}
