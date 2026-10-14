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
  executed: false
  integration: string
  function: string
  params: Record<string, unknown>
  recipients: number | null
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
    executed: false,
    integration: target,
    function: fn,
    params: previewParams(params),
    recipients: recipientCount(params),
    message: `Dry run — nothing was changed. ${target}.${fn} would run with the parameters above. To do it for real, add --apply.`,
    apply_with: `iris integrations exec ${target} ${fn} … --apply`,
  }
}

/**
 * Does the name itself say it changes something? (#189462)
 *
 * Separate from isReadAction on purpose. isReadAction answers "may this run without --apply?" and
 * says no to anything unclear; THIS answers "could anything — including the server — talk us out of
 * rehearsing it?". A name with a write verb in it is never downgraded to a read by a server plan:
 * the server can make a rehearsal stricter, never looser. On 2026-10-14
 * `exec mailjet send_transactional_email` without --apply delivered 177 real emails; whatever the
 * server said about that call, the word "send" was right there in the name.
 */
export function hasWriteVerb(fn: string): boolean {
  return actionVerbs(fn).some((w) => WRITE_VERBS.has(w) && !PRODUCE_VERBS.has(w))
}

/**
 * Verbs that are rehearsed by default but usually only PRODUCE something (a report, a converted
 * file) — `mercury generate_tax_summary`. The server's plan may still clear these as reads.
 */
const PRODUCE_VERBS = new Set(["generate", "convert"])

const RECIPIENT_KEYS = ["to", "cc", "bcc", "to_email", "to_emails", "recipient", "recipients", "emails", "email", "phone", "phones", "to_number", "numbers"]

/** How many people a call would reach, counted from the usual recipient fields. null = no recipient field. */
export function recipientCount(params: Record<string, unknown>): number | null {
  let n = 0
  let seen = false
  const count = (v: unknown): number => {
    if (v === null || v === undefined || v === "") return 0
    if (Array.isArray(v)) return v.reduce((s: number, x) => s + count(x), 0)
    if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean).length
    return 1 // an object such as { email, name }
  }
  for (const k of RECIPIENT_KEYS) {
    if (k in params) {
      seen = true
      n += count(params[k])
    }
  }
  return seen ? n : null
}

/** Long values (an HTML body, a base64 attachment) cut to a readable preview; the length is kept. */
export function previewParams(params: Record<string, unknown>, max = 160): Record<string, unknown> {
  const cut = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}… (${v.length} chars)` : v
    if (Array.isArray(v)) return v.length > 20 ? [...v.slice(0, 20).map(cut), `… (${v.length} items)`] : v.map(cut)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x)]))
    return v
  }
  return cut(params) as Record<string, unknown>
}

export type GateOutcome =
  /** The function ran for real; `result` is what the server answered. */
  | { kind: "executed"; result: any }
  /** Nothing ran. `plan` is the server's plan when it gave one. */
  | { kind: "rehearsed"; plan: any | null; server_ignored_dry_run?: boolean }
  /** The rehearsal itself was refused (several accounts and none chosen, …) — nothing ran. */
  | { kind: "refused"; result: any }

/**
 * The whole decision, with the network call injected so it can be tested without one (#189462).
 *
 * `call(true)` asks the server for a plan (execute-direct with dry_run:true — executes nothing);
 * `call(false)` performs the action. `call(false)` is reached ONLY when:
 *   · --apply was given (and --dry-run was not), or
 *   · the name is a read (isReadAction), or
 *   · the name carries no write verb AND the server's plan says it is a read that will work.
 * A name with a write verb is never run without --apply, whatever the server says.
 */
export async function gatedExec(
  fn: string,
  opts: { apply: boolean; forceDryRun: boolean },
  call: (dryRun: boolean) => Promise<any>,
): Promise<GateOutcome> {
  if (opts.apply && !opts.forceDryRun) return { kind: "executed", result: await call(false) }
  const rehearse = opts.forceDryRun || !isReadAction(fn)
  if (!rehearse) return { kind: "executed", result: await call(false) }

  let plan: any = null
  try {
    plan = await call(true)
  } catch {}
  if (plan?.dry_run && plan?.would_run) {
    const serverSaysRead = plan.ok && plan.would_run.effect === "read"
    if (serverSaysRead && !opts.forceDryRun && !hasWriteVerb(fn)) return { kind: "executed", result: await call(false) }
    return { kind: "rehearsed", plan }
  }
  if (plan?.success === false && plan?.error) return { kind: "refused", result: plan }
  // An answer that is not a plan, to a request that asked for one, means the server did not
  // honour dry_run — it may have RUN the action. Say so; never present it as a clean rehearsal.
  const ignored = !!plan && typeof plan === "object" && !plan.dry_run && (plan.success === true || "data" in plan)
  return { kind: "rehearsed", plan: null, ...(ignored ? { server_ignored_dry_run: true } : {}) }
}
