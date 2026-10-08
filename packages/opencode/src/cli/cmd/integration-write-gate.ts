/**
 * `iris integrations exec` rehearses anything that is not a read, unless --apply (Alex, 2026-10-08).
 *
 * Kristen's desktop agent, probing which Gmail label actions existed, called create_label "to see
 * the validation error" — and it created `__iris_probe_xyz` in her real mailbox, which no IRIS action
 * could then delete. A probe and a write were the same call. Now a write typed at this door — by a
 * person, the desktop agent or MCP iris_run, all of which go through this command — shows what it
 * WOULD do and changes nothing until --apply is added.
 *
 * Why only here: the same backend endpoint is called server-to-server (fl-api's agent proxy, the
 * inbox, the Hive daemon) for real work, and in-platform agents are governed by trust levels and
 * approvals. A server-side default would silently stop production agents from sending mail.
 *
 * The classification is deliberately one-sided: an action is a READ only if it names a read verb and
 * no write verb. Anything unclear is treated as a write and rehearsed — a rehearsed read costs one
 * extra command; an unrehearsed write is what put a label in a client's mailbox.
 */

const READ_VERBS = new Set([
  "read", "search", "get", "list", "find", "fetch", "count", "check", "describe", "preview",
  "query", "lookup", "show", "view", "export", "download", "status", "health", "ping",
])
const WRITE_VERBS = new Set([
  "create", "add", "send", "update", "delete", "remove", "move", "archive", "trash", "mark", "upload",
  "post", "reply", "insert", "patch", "put", "set", "modify", "cancel", "pause", "resume", "publish",
  "share", "invite", "apply", "label", "assign", "merge", "import", "sync", "run", "execute", "start",
  "stop", "copy", "rename", "draft", "unarchive", "restore", "submit", "approve", "reject", "charge",
  "refund", "pay", "book", "schedule", "subscribe", "unsubscribe", "enable", "disable", "write", "edit",
  "empty", "purge", "destroy", "erase", "clear", "reset", "transfer", "convert", "generate",
])

export function actionVerbs(fn: string): string[] {
  return String(fn || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** A read names a read verb and no write verb. Everything else is rehearsed by default. */
export function isReadAction(fn: string): boolean {
  const words = actionVerbs(fn)
  if (words.some((w) => WRITE_VERBS.has(w))) return false
  return words.some((w) => READ_VERBS.has(w))
}

/** Is `fn` one of the functions this CLI knows for the integration? null = no list to check. */
export function knownFunction(fn: string, known: { name: string }[] | undefined): boolean | null {
  if (!known || known.length === 0) return null
  const f = String(fn).toLowerCase()
  return known.some((k) => k.name.toLowerCase() === f)
}

export type DryRun = {
  success: false
  dry_run: true
  integration: string
  function: string
  params: Record<string, unknown>
  message: string
  apply_with: string
}

/**
 * The rehearsal. success:false on purpose: a script or agent that expected the write to happen must
 * not read a rehearsal as "done" — that is the green-light-over-nothing this codebase keeps fixing.
 */
export function dryRunResult(target: string, fn: string, params: Record<string, unknown>): DryRun {
  return {
    success: false,
    dry_run: true,
    integration: target,
    function: fn,
    params,
    message: `Dry run — nothing was changed. ${target}.${fn} would run with the parameters above. To do it for real, add --apply.`,
    apply_with: `iris integrations exec ${target} ${fn} … --apply`,
  }
}
