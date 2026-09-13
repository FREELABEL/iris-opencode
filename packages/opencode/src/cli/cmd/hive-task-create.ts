// ── iris hive tasks create ──────────────────────────────────────────────
//
// Dispatch a task of ANY type to a node. Until this existed the CLI could create exactly two
// kinds of work — a shell command (`hive run`) and a user script (`scripts run`) — while the
// API accepted thirty. Everything else (mcp_call, remotion, discover, browser_agent…) could
// only be dispatched from the dashboard or by hand-rolling a POST, which is why the hive-mcp
// playbook had two "do this from your own client" steps in the middle of an otherwise
// executable recipe.
//
// The pure parts live here so they can be tested without a network: argument parsing, the two
// refusals that would otherwise become a task that succeeds while doing nothing, and the
// error rendering.

/**
 * Task types whose PAYLOAD is the prompt, not the config.
 *
 * These are the dangerous ones to dispatch without `--prompt`: the API only requires the field
 * to be a non-empty string, so a placeholder passes validation, the node accepts the task, runs
 * an empty script / a missing slug, and reports success. A green check over work that never
 * happened is the failure this map exists to prevent — the value is what to say instead.
 */
export const PROMPT_IS_PAYLOAD: Record<string, string> = {
  sandbox_execute: "the shell script body — or just use `iris hive run <node> \"<command>\"`",
  shell: "the command to run",
  user_script: "the script slug — or use `iris scripts run <slug> --node <node>`",
  hive_script: "the JavaScript source to run on the node",
  discover: "the npm subcommand to run, e.g. import-yt-feed",
  artisan: "the artisan command, e.g. health:check",
  playbook_run: "the playbook slug",
  skill_run: "the skill slug",
  execute_file: "the path of the file to execute on that node",
  message: "the message text",
  session_message: "the message text",
}

export interface TaskRequestInput {
  type: string
  prompt?: string
  config: Record<string, unknown>
}

export interface Refusal {
  ok: false
  error: string
  hint?: string
}

export type Check = { ok: true } | Refusal

/**
 * Refuse the two shapes that dispatch fine and then do nothing.
 *
 * Deliberately NOT a whitelist of task types. The enum lives in the API
 * (NodeTaskController::store) and grows there; a copy here would make every new server-side
 * type unusable from the CLI until somebody remembered to update it. An unknown type gets a
 * 422 whose message names every accepted value — see describeApiError.
 */
export function checkTaskRequest(input: TaskRequestInput): Check {
  const type = input.type?.trim()
  if (!type) return { ok: false, error: "--type is required (e.g. mcp_call, remotion, browser_agent)" }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""

  if (!prompt && PROMPT_IS_PAYLOAD[type]) {
    return {
      ok: false,
      error: `--type ${type} carries its work in --prompt, and none was given`,
      hint: `--prompt is ${PROMPT_IS_PAYLOAD[type]}. Without it the node accepts the task, runs nothing, and reports success.`,
    }
  }

  // mcp_call names a server that the node must already allow. The daemon falls back to reading
  // the server name out of `prompt` when config.server is absent, so a task with neither is not
  // rejected up front — it goes to the node and fails there, one round trip later, with a
  // message about an allowlist that is not the actual problem.
  if (type === "mcp_call") {
    const server = firstString(input.config.server, input.config.mcp_server)
    if (!server && !prompt) {
      return {
        ok: false,
        error: "mcp_call needs the server name",
        hint: "Pass it in the config: --config '{\"server\":\"argent\"}'. That name must be in ~/.iris/mcp-servers.json ON THE NODE.",
      }
    }
  }

  return { ok: true }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim()
  return undefined
}

export interface ParsedConfig {
  ok: true
  config: Record<string, unknown>
}

/**
 * Parse --config, which is either inline JSON or `@path/to/file.json`.
 *
 * Requires a JSON OBJECT. Laravel validates `config` as `array`, which accepts a JSON list
 * too — so `--config '["a"]'` would be stored and then silently ignored by every executor,
 * since they all read named keys.
 */
export function parseConfigArg(
  raw: string | undefined,
  readFile: (p: string) => string,
): ParsedConfig | Refusal {
  if (raw === undefined || raw === null || raw === "") return { ok: true, config: {} }

  let text = raw
  if (raw.startsWith("@")) {
    const file = raw.slice(1)
    try {
      text = readFile(file)
    } catch (err) {
      return { ok: false, error: `Could not read --config file ${file}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      error: `--config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Single-quote the whole thing so your shell keeps the double quotes: --config '{\"server\":\"argent\"}'",
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `--config must be a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
      hint: "Every task executor reads named keys, so a list would be stored and then ignored.",
    }
  }

  return { ok: true, config: parsed as Record<string, unknown> }
}

/**
 * A one-line description of what this task will do, used for the default title and prompt.
 * For mcp_call it names the server and tool, because "mcp_call" alone in a task list tells you
 * nothing about which of six servers ran.
 */
export function describeTask(type: string, config: Record<string, unknown>): string {
  if (type === "mcp_call") {
    const server = firstString(config.server, config.mcp_server) ?? "?"
    const tool = firstString(config.tool)
    return tool ? `mcp_call ${server}:${tool}` : `mcp_call ${server} (tools/list)`
  }
  return type
}

export interface BuildPayloadInput {
  userId: number
  type: string
  nodeId?: string
  prompt?: string
  title?: string
  config: Record<string, unknown>
  timeoutSec?: number
  priority?: number
  allowFallback?: boolean
  requiredCapabilities?: string[]
}

/**
 * Build exactly the body NodeTaskController::store validates. Clamps are the API's own bounds,
 * applied here so an out-of-range value is corrected rather than returned as a 422 field error.
 */
export function buildTaskPayload(input: BuildPayloadInput): Record<string, unknown> {
  const described = describeTask(input.type, input.config)
  const prompt = (typeof input.prompt === "string" && input.prompt.trim()) ? input.prompt : described
  const title = (typeof input.title === "string" && input.title.trim()) ? input.title.trim() : `iris hive: ${described}`

  const payload: Record<string, unknown> = {
    user_id: input.userId,
    title: title.slice(0, 255),
    type: input.type,
    prompt,
  }

  if (Object.keys(input.config).length > 0) payload.config = input.config
  if (input.nodeId) payload.node_id = input.nodeId
  // node_id is a PIN by default on the API side, which is what naming a machine usually means.
  // Only send the opt-in when it was asked for — sending `false` would be identical, but an
  // absent key keeps the request readable in logs.
  if (input.allowFallback) payload.allow_node_fallback = true

  if (typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec)) {
    payload.timeout_seconds = Math.max(30, Math.min(3600, Math.round(input.timeoutSec)))
  }
  if (typeof input.priority === "number" && Number.isFinite(input.priority)) {
    payload.priority = Math.max(1, Math.min(10, Math.round(input.priority)))
  }
  if (input.requiredCapabilities && input.requiredCapabilities.length > 0) {
    payload.required_capabilities = Object.fromEntries(input.requiredCapabilities.map((c) => [c, true]))
  }

  return payload
}

/** A few types people actually dispatch, for the hint on a rejected --type. NOT a gate: the
 * authoritative enum is server-side (NodeTaskController::store) and Laravel's default message
 * for it is the useless "The selected type is invalid.", so something has to name examples. */
export const COMMON_TASK_TYPES = ["mcp_call", "sandbox_execute", "browser_agent", "remotion", "discover", "playbook_run", "user_script", "artisan"]

/**
 * Turn an API failure into something a person can act on.
 *
 * A raw 422 body is a JSON blob; the useful part is the per-field message. When the rejected
 * field is `type`, Laravel says only that it is invalid — so add examples, because otherwise the
 * next move is to go read the controller.
 */
export function describeApiError(status: number, bodyText: string): string {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  } catch { /* not JSON — fall through to the raw body */ }

  const lines: string[] = []
  const errors = parsed?.errors as Record<string, string[]> | undefined
  if (errors && typeof errors === "object") {
    for (const [field, msgs] of Object.entries(errors)) {
      for (const m of (Array.isArray(msgs) ? msgs : [String(msgs)])) lines.push(`${field}: ${m}`)
    }
  } else if (typeof parsed?.message === "string" && parsed.message) {
    lines.push(parsed.message)
  } else if (typeof parsed?.error === "string" && parsed.error) {
    lines.push(parsed.error)
  } else if (bodyText.trim()) {
    lines.push(bodyText.trim().slice(0, 400))
  }

  if (errors && Object.prototype.hasOwnProperty.call(errors, "type")) {
    lines.push(`common types: ${COMMON_TASK_TYPES.join(", ")} (the full list is the API's own enum)`)
  }

  const head = status === 422 ? "The API rejected the task" : `Task creation failed (HTTP ${status})`
  return lines.length ? `${head}:\n  ${lines.join("\n  ")}` : head
}

export const TERMINAL_STATUSES = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

/**
 * Process exit code for a finished task. `timeout` is 124 (coreutils `timeout`, and what
 * hive-script-result.ts already uses) so a caller can retry only those; an unknown status is a
 * failure rather than a success, because "we do not know" must never exit 0.
 */
export function exitCodeForStatus(status: string | undefined | null): number {
  switch (String(status ?? "")) {
    case "succeeded":
    case "completed":
      return 0
    case "timeout":
      return 124
    default:
      return 1
  }
}

/**
 * What to print as the task's answer.
 *
 * Task results are shaped by whichever executor ran: a shell task puts text in
 * result.output, mcp_call returns a structured object, others return neither. Returning the
 * kind alongside the text lets the caller render it without guessing, and an empty result is
 * reported as empty rather than as an absent field — a node that returned nothing at all is a
 * real and previously invisible outcome (#181633).
 */
export interface ResultView {
  kind: "text" | "json" | "none"
  text: string
  stderr?: string
  exitCode?: number
  /** The node that ACTUALLY ran it, as the node reported itself — not the name it is registered
   * under. Measured: a node registered as "AlexMaysnow1063" reports
   * "Alex-Mayo-Bisnow-23812.local", and on a fallback dispatch this is a different machine
   * entirely. Printing it is how you know where the work happened. */
  node?: string
}

/** Keys that are the transport, not the answer. Anything outside this set means the executor
 * put something structured in the result and the whole object has to be shown. */
const ENVELOPE_KEYS = new Set(["output", "stdout", "stderr", "data", "files", "metadata", "duration_ms"])

export function pickResultPayload(task: Record<string, unknown> | null | undefined): ResultView {
  const result = task?.result
  if (result === null || result === undefined || result === "") return { kind: "none", text: "" }
  if (typeof result === "string") return { kind: "text", text: result }
  if (typeof result !== "object") return { kind: "text", text: String(result) }

  const obj = result as Record<string, unknown>
  const metadata = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {}) as Record<string, unknown>
  const exitCode = typeof metadata.exit_code === "number" ? metadata.exit_code : undefined
  const node = typeof metadata.executed_by_node_name === "string" ? metadata.executed_by_node_name : undefined
  const stderrRaw = typeof obj.stderr === "string" && obj.stderr.trim() ? obj.stderr : undefined

  // The answer every node sends arrives wrapped: {output, stdout, stderr, data, files, metadata}.
  // For an mcp_call the entire answer is a JSON document inside `output` AS A STRING, so
  // rendering the wrapper as JSON prints that document escaped — `\n` and `\"` all the way
  // down. That is what the first live call looked like, and it is unreadable. If there is text
  // in output/stdout, that text IS the result.
  const body = firstString(obj.output, obj.stdout)
  const hasExtra = Object.keys(obj).some((k) => !ENVELOPE_KEYS.has(k) && !isEmptyValue(obj[k]))
  if (body && !hasExtra) return { kind: "text", text: body, stderr: stderrRaw, exitCode, node }

  return { kind: "json", text: JSON.stringify(obj, null, 2), stderr: stderrRaw, exitCode, node }
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0
  return false
}
