/**
 * One error surface for `--json` callers (#190878).
 *
 * `iris … --json | jq` used to get prose on a validation failure — yargs' own messages
 * ("Not enough non-option arguments"), a handler's usage line ("Give a query …"), a playbook's
 * argument check ("Missing required argument: who") — and jq reported a parse error instead of
 * the reason. Every error that reaches the top level of the CLI is rendered here instead: with
 * --json on the command line it is ONE JSON object on stdout, `{"success": false, "error": …}`,
 * with a non-zero exit; without it, nothing changes.
 */
import { NamedError } from "@opencode-ai/util/error"

/**
 * A mistake in how the command was called, as opposed to a failure while running it. Thrown by
 * handlers so the top level renders it (as JSON under --json); it is not beaconed as a crash.
 */
export class CliUsageError extends Error {
  override name = "CliUsageError"
  constructor(message: string) {
    super(message)
  }
}

/**
 * Did the caller ask for JSON? Reads the raw argv, so it answers even when yargs itself is what
 * failed. Arguments after a bare `--` belong to something else and are not read.
 */
export function wantsJson(argv: readonly string[]): boolean {
  let want = false
  for (const a of argv) {
    if (a === "--") break
    if (a === "--json" || a === "--json=true") want = true
    else if (a === "--no-json" || a === "--json=false") want = false
  }
  return want
}

/** The JSON object for an error. `path` is included when the error names a file (a bad playbook header). */
export function errorPayload(message: string, e?: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { success: false, error: message }
  if (e instanceof NamedError) {
    const data = (e.toObject() as { data?: Record<string, unknown> }).data ?? {}
    if (typeof data.path === "string") out.path = data.path
    out.type = e.name
  } else if (e instanceof Error && e.name && e.name !== "Error") {
    out.type = e.name
  }
  return out
}

/**
 * Write the error object to stdout and wait for it to drain — the process exits right after, and
 * an exit with bytes still buffered on a pipe truncates them (see writeJson in cmd/iris-api.ts).
 */
export async function writeErrorJson(message: string, e?: unknown): Promise<void> {
  const payload = JSON.stringify(errorPayload(message, e), null, 2) + "\n"
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    process.stdout.write(payload, done)
    setTimeout(done, 10_000)
  })
}
