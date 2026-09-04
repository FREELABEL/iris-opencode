import { Auth } from "../../auth"
import * as prompts from "./clack"
import { UI } from "../ui"
import { homedir } from "os"
import { join } from "path"
// ESM imports, not require(). The CLI bundle has no `require` — every inline
// require("fs") in this file threw ReferenceError and was swallowed by a bare
// catch, so each one silently returned "no such file". See the note on
// getBridgeToken below.
import { existsSync, readFileSync } from "fs"

// Quiet mode is handled by ./clack.ts — it exports noops for non-TTY contexts.
const _quiet = !process.stdout.isTTY
const _noop = (() => {}) as (...args: any[]) => any
const _noopSpinner = { start: _noop, stop: _noop, message: _noop }

export const cli = {
  intro: _quiet ? _noop : prompts.intro,
  outro: _quiet ? _noop : prompts.outro,
  log: _quiet
    ? { info: _noop, warn: _noop, error: _noop, success: _noop, step: _noop, message: _noop }
    : prompts.log,
  spinner: _quiet ? () => _noopSpinner : prompts.spinner,
  empty: _quiet ? _noop : () => UI.empty(),
} as const

// ============================================================================
// Base URLs — single source of truth for all platform endpoints.
// Override with env vars for local dev or custom deployments.
// ============================================================================

// Pre-load SDK env vars before setting constants (sync read at module load)
// This ensures IRIS_API_URL from ~/.iris/sdk/.env is picked up
// TODO: Once loadIrisSdkEnvSync is defined below, refactor this to use it
{
  try {
    const _fs = { existsSync, readFileSync }, _path = { join }
    const _envPath = join(homedir(), ".iris", "sdk", ".env")
    if (_fs.existsSync(_envPath)) {
      let _raw = _fs.readFileSync(_envPath, "utf-8")
      if (_raw.charCodeAt(0) === 0xFEFF) _raw = _raw.slice(1) // strip BOM
      for (const line of _raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        if (!["IRIS_API_URL", "IRIS_FL_API_URL", "IRIS_API_KEY"].includes(key)) continue
        if (process.env[key]) continue
        let rawValue = trimmed.slice(eq + 1).trim()
        // Strip quotes
        if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
            (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
          rawValue = rawValue.slice(1, -1)
        }
        process.env[key] = rawValue
      }
    }
  } catch {}
}

export const PLATFORM_URLS = {
  /** fl-api (Laravel backend — users, bloqs, leads, workflows) */
  flApi: process.env.IRIS_FL_API_URL ?? "https://raichu.heyiris.io",
  /** iris-api (V6 engine — chat, integrations exec, tools, monitor) */
  irisApi: process.env.IRIS_API_URL ?? "https://freelabel.net",
  /** Fallback URLs for iris-api (tried in order when primary fails) */
  irisApiFallbacks: [] as string[],
  /**
   * The PUBLIC BRAND HOST — where a human is sent to look at a page.
   *
   * Deliberately separate from `irisApi`. Both hosts answer /p/, so building a public
   * link from the API base produced a working URL on the wrong brand: every `pages
   * push`, dashboard listing and share line handed people freelabel.net, which is the
   * API/infra host, for a page that lives on the business platform. Nothing 404s, so
   * the mistake propagates into docs, tickets and client emails and is only ever caught
   * by someone noticing the name.
   *
   * A URL we SEND SOMEONE and a URL we CALL are different things even when they resolve
   * to the same app — keep them apart so a change to one cannot silently rebrand the
   * other.
   */
  publicSite: process.env.IRIS_PUBLIC_URL ?? "https://heyiris.io",
} as const

// Aliases for backward compat — prefer PLATFORM_URLS in new code
export const FL_API = PLATFORM_URLS.flApi
export const IRIS_API = PLATFORM_URLS.irisApi
/** Public brand host for links shown to humans — never an API base. */
export const PUBLIC_SITE = PLATFORM_URLS.publicSite

// ============================================================================
// Read ~/.iris/sdk/.env (written by iris-login)
// ============================================================================

let _sdkEnvCache: Record<string, string> | undefined

/**
 * Strip quotes and inline comments from a .env value
 * Examples:
 *   "value"    → value
 *   'value'    → value
 *   value # comment → value
 */
function stripEnvQuotes(value: string): string {
  // Remove inline # comments (but not # inside quotes)
  let cleaned = value
  const hashIndex = cleaned.indexOf("#")
  if (hashIndex >= 0) {
    cleaned = cleaned.slice(0, hashIndex).trim()
  }
  
  // Strip surrounding quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    return cleaned.slice(1, -1)
  }
  
  return cleaned
}

/**
 * Synchronously load IRIS_API_KEY (and other SDK env vars) from ~/.iris/sdk/.env
 * Handles BOM, strips quotes, filters comments.
 * Safe to call multiple times (uses module-level cache).
 * Used by provider.ts at module load time.
 */
export function loadIrisSdkEnvSync(): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const fs = { existsSync, readFileSync }
    const path = require("path")
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    if (fs.existsSync(envPath)) {
      let raw = fs.readFileSync(envPath, "utf-8")
      // Strip BOM if present
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim()
          const rawValue = trimmed.slice(eq + 1).trim()
          result[key] = stripEnvQuotes(rawValue)
        }
      }
    }
  } catch {}
  return result
}

async function readSdkEnv(): Promise<Record<string, string>> {
  if (_sdkEnvCache) return _sdkEnvCache
  _sdkEnvCache = {}
  try {
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    const file = Bun.file(envPath)
    if (await file.exists()) {
      // Strip BOM if present (Windows PowerShell 5.1 writes UTF-8 with BOM)
      const raw = await file.text()
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim()
          const rawValue = trimmed.slice(eq + 1).trim()
          _sdkEnvCache[key] = stripEnvQuotes(rawValue)
        }
      }
    }
  } catch {}
  return _sdkEnvCache
}

// ============================================================================
// Auth token resolution
// ============================================================================

// Resolve auth ONCE per process — not once per request/poll (#137421). Repeated
// resolution spammed the "token source" line on every poll loop iteration.
let _cachedToken: string | undefined
let _cachedTokenSource: string | undefined

async function resolveToken(): Promise<string> {
  if (_cachedToken !== undefined) return _cachedToken
  _cachedToken = await resolveTokenUncached()
  return _cachedToken
}

/**
 * WHERE the token came from, reported BY the resolver (#183661).
 *
 * `iris auth whoami` used to derive this label itself, by re-checking the environment and
 * the sdk .env in a different order — and its list did not include the auth store at all,
 * which is the resolver's FIRST source. So it printed "IRIS_API_KEY (environment)" for a
 * token that came from `iris auth login`.
 *
 * That is read at the worst possible moment: nobody runs whoami idly, they run it while
 * something is refusing them. Acting on the wrong pointer means editing a file that is not
 * being read, and the fix then appears to fail — which argues the diagnosis was wrong. It
 * happened during #183652, where the CLI was signed in as the wrong account and every
 * push 403'd.
 *
 * One value, one code path: whoever wants the source asks the thing that chose it.
 */
export async function resolveTokenSource(): Promise<string> {
  if (_cachedTokenSource === undefined) await resolveToken()

  return _cachedTokenSource ?? "none (not signed in)"
}

async function resolveTokenUncached(): Promise<string> {
  // 1. Try stored auth (iris auth login)
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) {
    _cachedTokenSource = "iris auth store (iris auth login)"
    if (process.argv.includes("--print-logs")) console.error(`[auth] token source: ${_cachedTokenSource}`)
    return stored.key
  }
  // 2. Env var
  if (process.env.IRIS_API_KEY) {
    _cachedTokenSource = "IRIS_API_KEY (environment)"
    if (process.argv.includes("--print-logs")) console.error(`[auth] token source: ${_cachedTokenSource}`)
    return process.env.IRIS_API_KEY
  }
  // 3. Read from ~/.iris/sdk/.env (written by iris-login installer)
  const sdkEnv = await readSdkEnv()
  if (sdkEnv["IRIS_API_KEY"]) {
    if (process.argv.includes("--print-logs")) console.error("[auth] token source: ~/.iris/sdk/.env")
    _cachedTokenSource = "~/.iris/sdk/.env"
    return sdkEnv["IRIS_API_KEY"]
  }
  // 4. Read node_api_key from ~/.iris/config.json as last resort (used by hive commands)
  try {
    const fs = { existsSync, readFileSync }, path = { join }
    const configPath = join(homedir(), ".iris", "config.json")
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      if (config.node_api_key) {
        if (process.argv.includes("--print-logs")) console.error("[auth] token source: ~/.iris/config.json node_api_key")
        _cachedTokenSource = "~/.iris/config.json (node_api_key)"
        return config.node_api_key
      }
    }
  } catch {}
  return ""
}

// ============================================================================
// Shared fetch helper
// ============================================================================

/** Describe a request body for debug output without ever parsing or printing its contents. */
function describeBody(body: RequestInit["body"]): string {
  if (!body) return "(none)"
  if (body instanceof FormData) return `(multipart: ${[...body.keys()].join(", ")})`
  try {
    return Object.keys(JSON.parse(String(body))).join(", ")
  } catch {
    return "(unparsed)"
  }
}

export async function irisFetch(
  path: string,
  options: RequestInit = {},
  base: string = FL_API,
): Promise<Response> {
  const token = await resolveToken()
  const isFormData = options.body instanceof FormData
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    Accept: "application/json",
    ...(options.headers as Record<string, string>),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const url = `${base}${path}`
  // Debug: stderr trace for diagnosing auth failures (only with --print-logs)
  if (process.argv.includes("--print-logs")) {
    console.error(`[irisFetch] ${options.method ?? "GET"} ${url}`)
    // Never print the token — not even a prefix (#137421). Presence only.
    console.error(`[irisFetch] token: ${token ? "(present)" : "(none)"}`)
    // FormData (audio uploads) stringifies to "[object FormData]", which JSON.parse
    // throws on — so --print-logs, the flag you reach for BECAUSE an upload is
    // misbehaving, was the flag that killed it (epic #182784, B3).
    console.error(`[irisFetch] body keys: ${describeBody(options.body)}`)
  }
  const res = await fetchWithRetry(url, { ...options, headers })
  if (process.argv.includes("--print-logs")) {
    console.error(`[irisFetch] → ${res.status} ${res.statusText}`)
  }
  return res
}

/**
 * #178675 — a single transient network blip hard-failed the whole command.
 *
 * `iris hive nodes list` died with `code: "ConnectionRefused"` while the endpoint was
 * demonstrably reachable (curl to the same URL returned 401 — DNS resolved, TCP connected,
 * TLS completed, the app answered). Re-running ~60s later worked and returned 11 nodes.
 * Note the reported `errno: 0` — "no error" — so "ConnectionRefused" was a fallback label
 * on a rejected fetch, not an observed refusal, and it sent the reader off checking DNS
 * and firewalls instead of just retrying.
 *
 * Transient failures are NORMAL on the Hive rails specifically (mesh VPN, remote nodes),
 * so the client should assume them rather than treat the first one as terminal.
 *
 * TWO DELIBERATE LIMITS:
 *  1. Only a THROWN fetch (network/DNS/TLS level) is retried. An HTTP error status is a
 *     real answer from the server and is returned untouched — retrying a 401/422/500 would
 *     be wrong and could mask a genuine failure.
 *  2. Only IDEMPOTENT methods (GET/HEAD) are retried. This helper backs every iris command,
 *     including `bug report`, `bloqs add-item` and program checkout — silently replaying a
 *     POST could duplicate an item or create a second Stripe session. A non-idempotent call
 *     fails on the first error, exactly as before.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  // Injected so tests can drive the retry deterministically and assert the backoff
  // schedule without sleeping through it. Defaults to the real fetch/timer.
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const idempotent = method === "GET" || method === "HEAD"
  const attempts = idempotent ? 3 : 1
  const debug = process.argv.includes("--print-logs")

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchImpl(url, init)
    } catch (err) {
      lastErr = err
      if (attempt === attempts) break
      const backoffMs = 400 * attempt // 400ms, then 800ms
      if (debug) {
        console.error(`[irisFetch] network error on attempt ${attempt}/${attempts}, retrying in ${backoffMs}ms: ${String(err)}`)
      }
      await sleep(backoffMs)
    }
  }

  // Out of attempts. Re-throw with context that points at the real cause instead of
  // implying the host is unreachable — the caller could not COMPLETE the request, which
  // is not the same as the server refusing it.
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
  const tried = attempts > 1 ? ` after ${attempts} attempts` : ""
  const hint = idempotent
    ? ""
    : ` (${method} is not retried automatically — it may not be safe to repeat; re-run manually if appropriate)`
  throw new Error(`Network request to ${url} failed${tried}: ${detail}${hint}`)
}

// ============================================================================
// Auth guard — call at start of commands that require auth
// ============================================================================

export async function requireAuth(): Promise<string | null> {
  const token = await resolveToken()
  if (!token) {
    // #180540, same shape as handleApiError: the near-universal `if (!token) return` at every
    // call site exits 0 with empty stdout, so an unauthenticated `--json` run is byte-identical
    // to a successful run that found nothing. Say so in JSON, and exit non-zero either way.
    if (isJsonMode()) {
      emitJsonError("Not authenticated — no IRIS token found.", {
        action: "auth",
        checked: ["iris auth store", "IRIS_API_KEY", "~/.iris/sdk/.env", "~/.iris/config.json"],
        fix: "iris auth login",
      })
    } else {
      prompts.log.warn("Not authenticated. No token found in any of:")
      prompts.log.info("  1. iris auth store (run: iris auth login)")
      prompts.log.info("  2. IRIS_API_KEY env var")
      prompts.log.info("  3. ~/.iris/sdk/.env")
      prompts.log.info("  4. ~/.iris/config.json (node_api_key)")
      prompts.log.info(
        `\nFix:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login${UI.Style.TEXT_NORMAL}  or set IRIS_API_KEY`,
      )
    }
    process.exitCode = 1
    return null
  }
  return token
}

// ============================================================================
// Response helpers
// ============================================================================

/**
 * Turn a 402 body into what the user should actually read (#178276).
 *
 * fl-api's RequireActiveSubscription / CheckCredits / OkfAccess middleware each
 * answer an entitlement gate with a remediation payload: a human `message`,
 * where to pay, and often the exact CLI command to run. Before this, a 402 fell
 * through to the generic !res.ok handler, which prefers `error` over `message`
 * and drops everything else — so a gated user saw the bare slug
 * "subscription_required" and nothing about what to do, while the answer was
 * already on the wire.
 *
 * Pure and exported so it can be tested without stubbing the terminal.
 */
export function formatPaymentRequired(body: unknown): { message: string; details: string[] } {
  const b = (body ?? {}) as {
    error?: string
    message?: string
    cli_command?: string
    checkout_url?: string
    onboarding_url?: string
    buy_credits_url?: string
    upgrade_url?: string
    cost?: number
    data?: { balance?: number; cost?: number; balance_needed?: number }
  }

  // Human sentence first — the opposite of the generic handler's precedence,
  // because here `error` is a machine slug and `message` is the explanation.
  // Some 402s (OkfAccess) send only the slug, so humanise it rather than
  // printing snake_case at the user.
  const message =
    b.message ||
    (b.error ? b.error.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Payment required")

  const details: string[] = []

  // Credit gates carry the numbers that make the message actionable.
  const balance = b.data?.balance
  const cost = b.data?.cost ?? b.cost
  const needed = b.data?.balance_needed
  const parts: string[] = []
  if (balance !== undefined) parts.push(`balance ${balance}`)
  if (cost !== undefined) parts.push(`cost ${cost}`)
  if (needed !== undefined && needed > 0) parts.push(`short by ${needed}`)
  if (parts.length) details.push(parts.join(", "))

  if (b.cli_command) {
    details.push(`Fix:  ${UI.Style.TEXT_HIGHLIGHT}${b.cli_command}${UI.Style.TEXT_NORMAL}`)
  }

  for (const key of ["checkout_url", "onboarding_url", "buy_credits_url", "upgrade_url"] as const) {
    const url = b[key]
    if (url) details.push(`${key.replace(/_url$/, "").replace(/_/g, " ")}: ${url}`)
  }

  return { message, details }
}

/**
 * Is this invocation in --json mode? (#180540)
 *
 * Read from argv rather than threaded through a parameter on purpose. handleApiError has ~760
 * call sites across ~104 files, every one of them `handleApiError(res, action)`; an opt-in third
 * argument would fix only the sites someone remembered to update, and the whole complaint in
 * #180540 is that the failure path is unreachable in the mode a SCRIPT uses. A defect that
 * general deserves one fix, not 760 chances to miss one.
 *
 * yargs accepts `--json`, `--json=true` and `--json true`; the first two are what anyone writes.
 * A false positive costs a JSON error object printed to a human, which is legible. A false
 * negative costs a script empty stdout, which is what we are fixing.
 */
/**
 * A write that would change nothing is an ERROR, not a warning. (#181577 family, tracker 11.)
 *
 * 23 commands already detected this case. TWENTY-ONE of them warned and returned — exit code
 * ZERO. So `iris brands update 5` with no flags printed "Nothing to update" and told every
 * script, CI job and agent that the write SUCCEEDED. A human sees the warning; automation sees
 * success, and the difference never shows up until something downstream reads a value that was
 * never written.
 *
 * clig.dev states the rule plainly: non-zero exit on failure. A write the caller asked for and
 * did not get is a failure. This helper is the single place that decides what that looks like,
 * so the 23 sites cannot drift into 23 slightly different opinions again.
 *
 * Returns `never`, so a caller cannot accidentally continue past it — the previous shape
 * depended on remembering to `return` afterwards.
 *
 * CALL IT BEFORE requireAuth(). "You passed no fields" needs no network, and checking first
 * means the failure is deterministic offline — which is what lets it be tested at all.
 */
export function failNoOp(what: string, hint: string): never {
  if (isJsonMode()) {
    // JSON mode must stay parseable: a caller piping to jq gets an object, not prose.
    console.log(JSON.stringify({ error: `Nothing to ${what}`, hint }))
  } else {
    prompts.log.error(`Nothing to ${what} — ${hint}`)
  }

  process.exit(1)
}

export function isJsonMode(): boolean {
  return process.argv.some((a) => a === "--json" || a === "--json=true")
}

/**
 * The machine-readable half of a failure. One line, one object, on STDOUT — where the success
 * payload goes, because a consumer reading stdout and branching on `success` is the entire point.
 *
 * Deliberately NOT pretty-printed: writeJson's multi-line form is for humans eyeballing a
 * success payload; an error is one object a script parses.
 */
function emitJsonError(message: string, extra?: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ success: false, error: message, ...(extra ?? {}) }) + "\n")
}

export async function handleApiError(res: Response, action: string): Promise<boolean> {
  // #180540: in --json mode every branch below must still answer with JSON on stdout. Before
  // this, a failing call under --json printed clack prose to STDERR and left stdout completely
  // empty — so `iris ... --json | jq` got nothing to parse, and the reporter read an unfamiliar
  // response shape as success and went looking for a bounty that was never created. Silence is
  // the worst possible error message for a script: it is indistinguishable from "no results".
  const json = isJsonMode()

  if (res.status === 401) {
    const msg = "Authentication failed — your token may be expired or invalid."
    if (json) {
      emitJsonError(msg, { status: 401, action, fix: "iris auth login --force" })
    } else {
      prompts.log.warn(msg)
      prompts.log.info(
        `Re-authenticate:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login --force${UI.Style.TEXT_NORMAL}`,
      )
    }
    process.exitCode = 1
    return false
  }
  if (res.status === 403) {
    let msg = "Access denied"
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      msg = body.error || body.message || msg
    } catch {}
    if (json) emitJsonError(msg, { status: 403, action })
    else prompts.log.warn(msg)
    process.exitCode = 1
    return false
  }
  // 402 Payment Required — an entitlement gate, not a crash (#178276).
  if (res.status === 402) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {}
    const { message, details } = formatPaymentRequired(body)
    if (json) {
      // Forward the whole remediation payload: checkout_url and cli_command are what an
      // automated caller would act on, and re-flattening them into prose would lose them.
      emitJsonError(message, { status: 402, action, payment_required: body })
    } else {
      prompts.log.warn(message)
      for (const d of details) prompts.log.info(d)
    }
    process.exitCode = 1
    return false
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
    let fieldErrors: Record<string, string[]> | undefined
    try {
      const body = (await res.json()) as { error?: string; message?: string; errors?: Record<string, string[]> }
      // Bug #57643/#57647: use || not ?? — API returns {"message":""} which ?? doesn't fall through
      const rawMsg = body.error || body.message || ""
      // Bug #57646: sanitize raw Laravel model errors (e.g. "No query results for model [App\Models\Bloq\ScheduledJob]")
      // Bug #162342: sanitize raw DB errors — a QueryException leaks the full SQL,
      // table/column names, the FK constraint, and the DB name. Never surface it.
      if (rawMsg) {
        if (rawMsg.includes("No query results for model")) {
          msg = "Resource not found"
        } else if (/SQLSTATE|\bSQL:|Integrity constraint|PDOException|foreign key constraint/i.test(rawMsg)) {
          msg = "The server rejected the request (invalid reference or constraint). Check the ids you passed."
        } else {
          msg = rawMsg.replace(/\[App\\Models\\[^\]]+\]/g, "").trim()
        }
      }
      // Laravel validation returns { errors: { field: ["msg", ...] } }
      if (body.errors && typeof body.errors === "object") {
        fieldErrors = body.errors
        const details = Object.entries(body.errors)
          .map(([field, msgs]) => `  ${field}: ${(msgs as string[]).join(", ")}`)
          .join("\n")
        if (details) msg += "\n" + details
      }
    } catch {}
    if (json) {
      // `errors` stays structured rather than folded into the message string: a script that
      // wants to know WHICH field failed should not have to parse prose back apart.
      emitJsonError(msg, { status: res.status, action, ...(fieldErrors ? { errors: fieldErrors } : {}) })
    } else {
      prompts.log.error(`${action} failed: ${msg}`)
      // Ensure error is visible even when clack rendering swallows output
      console.error(`  Error: ${msg}`)
    }
    process.exitCode = 1
    return false
  }
  return true
}

// ============================================================================
// V6 agent chat — faithful ReactLoop harness (bug #137387)
//
// Both `iris agents chat` and `iris chat` route through this single helper so the
// CLI runs the SAME engine as the Slack channel path: POST /api/v6/chat/stream →
// ChatStreamController → ReactLoopService::executeRequest() → V6ToolRegistry::
// getToolsForAgent() (agentIntegrations + per-agent allowlist + system-tools).
//
// The legacy CLI path (POST /api/chat/start → RunWorkflowJob, V5.5 Neuron nodes)
// never built the V6 toolset, so agents lost their tools and invented data. This
// endpoint is also stateless per-request (explicit conversation_history, no auto-
// resumed session) → no session poisoning between turns.
// ============================================================================

export type AgentChatEvent = {
  type: string
  tool?: string
  content?: string
  iteration?: number
  error?: string
  [k: string]: unknown
}

export type AgentChatResult = {
  ok: boolean
  content: string
  toolsUsed: string[]
  iterations: number
  status: string
  error?: string
  // Distinguishes failure modes so callers can set distinct exit codes (#137418):
  // timedOut → exit 2, any other failure → exit 1, ok → exit 0.
  timedOut?: boolean
}

/** Normalize the heterogeneous tools_used payload into a flat list of tool names. */
function normalizeToolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names = raw.map((t) => {
    if (typeof t === "string") return t
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>
      return String(o.tool ?? o.name ?? o.tool_name ?? "")
    }
    return ""
  })
  // De-dupe while preserving order, drop empties
  return [...new Set(names.filter(Boolean))]
}

/**
 * Send one message to an agent through the faithful V6 ReactLoop stream and
 * collect the result. Surfaces intermediate SSE events (tool_call, tool_result,
 * text, …) via `onEvent` for live progress.
 *
 * Stateless by default: pass `conversationHistory` only if you are deliberately
 * continuing a thread. Omitting it gives a clean run every call.
 */
export async function streamAgentChat(opts: {
  agentId: number
  message: string
  userId?: number | null
  // Accepts a single id or several (repeated `--bloq A --bloq B`). Multiple ids are
  // sent as bloq_ids[] so the server retrieves per-bloq instead of collapsing to NaN (#146917).
  bloqId?: number | string | Array<number | string> | null
  conversationHistory?: Array<{ role: string; content: string }>
  maxIterations?: number
  overrideModel?: string
  timeoutSecs?: number
  // Defaults to true. Set false (via `--no-rag`) to suppress knowledge-base/bloq
  // context injection so the model answers from its own weights only (#146915).
  enableRag?: boolean
  // Server-side conversation thread. The V6 loop resolves it as
  //   explicit threadId > freshThread > default "user_{id}_agent_{id}"
  // and the DEFAULT means every call inherits that agent's whole history — including
  // calls made by other sessions. Pass a unique id to get an isolated run.
  // (The server also has a `freshThread` flag, but ChatStreamController's validator does
  // not accept `fresh_thread`, so a caller-generated unique id is the only route today.)
  threadId?: string | null
  onEvent?: (event: AgentChatEvent) => void
}): Promise<AgentChatResult> {
  const body: Record<string, unknown> = {
    query: opts.message,
    agent_id: opts.agentId,
    enable_rag: opts.enableRag !== false,
  }
  if (opts.userId) body.user_id = opts.userId
  // Normalize one-or-many bloq ids. A bare `Number([514,515])` is NaN → serializes to
  // null → server silently does a broad user-wide search (the #146917 recall dilution).
  if (opts.bloqId !== undefined && opts.bloqId !== null) {
    const ids = (Array.isArray(opts.bloqId) ? opts.bloqId : [opts.bloqId])
      .map((b) => Number(b))
      .filter((n) => Number.isFinite(n))
    if (ids.length === 1) body.bloq_id = ids[0]
    else if (ids.length > 1) {
      body.bloq_id = ids[0] // primary, for any consumer that reads a single id
      body.bloq_ids = ids
    }
  }
  if (opts.conversationHistory && opts.conversationHistory.length > 0) {
    body.conversation_history = opts.conversationHistory
  }
  if (opts.threadId) body.thread_id = opts.threadId
  if (opts.maxIterations) body.max_iterations = opts.maxIterations
  // Endpoint validator only accepts nano/flash models — keeps test runs cheap.
  if (opts.overrideModel) body.override_model = opts.overrideModel

  const failure = (error?: string, timedOut = false): AgentChatResult => ({
    ok: false,
    content: "",
    toolsUsed: [],
    iterations: 0,
    status: timedOut ? "timeout" : "failed",
    error,
    timedOut,
  })

  // Abort the inline ReactLoop run if it exceeds the timeout (default 180s).
  const controller = new AbortController()
  const timeoutMs = (opts.timeoutSecs ?? 180) * 1000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await irisFetch(
      "/api/v6/chat/stream",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      },
      IRIS_API,
    )

    // Pre-stream errors (401 / 422 / 5xx) arrive as a normal JSON response.
    if (!(await handleApiError(res, "Chat"))) return failure()

    const reader = res.body?.getReader()
    if (!reader) return failure("No response stream")

    const decoder = new TextDecoder()
    let buffer = ""
    let streamError: string | undefined
    const result: AgentChatResult = {
      ok: true,
      content: "",
      toolsUsed: [],
      iterations: 0,
      status: "unknown",
    }

    const handleFrame = (frame: string) => {
      // A frame may carry an "event: <type>" line plus one or more "data:" lines.
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n")
      if (!data || data === "[DONE]") return
      let evt: AgentChatEvent
      try {
        evt = JSON.parse(data) as AgentChatEvent
      } catch {
        return
      }
      opts.onEvent?.(evt)
      if (evt.type === "done") {
        if (typeof evt.content === "string") result.content = evt.content
        const tu = normalizeToolNames((evt as Record<string, unknown>).tools_used)
        if (tu.length > 0) result.toolsUsed = tu
        if (typeof evt.iterations === "number") result.iterations = evt.iterations
        if (typeof evt.status === "string") result.status = evt.status
      } else if (evt.type === "error") {
        streamError = evt.error ?? "stream error"
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        handleFrame(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 2)
      }
    }
    if (buffer.trim()) handleFrame(buffer)

    if (streamError) return { ...result, ok: false, status: "failed", error: streamError }
    return result
  } catch (err) {
    if (controller.signal.aborted) return failure(`Timed out after ${opts.timeoutSecs ?? 180}s`, true)
    return failure(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// User ID resolution
// ============================================================================

let _cachedUserId: number | null | undefined = undefined

export async function resolveUserId(): Promise<number | null> {
  if (_cachedUserId !== undefined) return _cachedUserId

  // 1. Env var
  if (process.env.IRIS_USER_ID) {
    const n = parseInt(process.env.IRIS_USER_ID, 10)
    if (!isNaN(n)) {
      _cachedUserId = n
      return n
    }
  }

  // 2. Read from ~/.iris/sdk/.env (written by iris-login)
  const sdkEnv = await readSdkEnv()
  if (sdkEnv["IRIS_USER_ID"]) {
    const n = parseInt(sdkEnv["IRIS_USER_ID"], 10)
    if (!isNaN(n)) {
      _cachedUserId = n
      return n
    }
  }

  // 3. Auto-resolve from the authenticated-user endpoint. /api/user is the live
  //    fl-api route; /api/v1/me is kept as a fallback for older backends.
  for (const ep of ["/api/user", "/api/v1/me"]) {
    try {
      const res = await irisFetch(ep)
      if (res.ok) {
        const data = (await res.json()) as { data?: { id?: number }; id?: number }
        const id = data?.data?.id ?? data?.id
        if (typeof id === "number") {
          _cachedUserId = id
          return id
        }
      }
    } catch {}
  }

  _cachedUserId = null
  return null
}

export async function requireUserId(flagValue?: number): Promise<number | null> {
  if (flagValue) return flagValue
  const id = await resolveUserId()
  if (!id) {
    prompts.log.warn("Could not resolve your user ID.")
    prompts.log.info(
      `Set it:  ${UI.Style.TEXT_HIGHLIGHT}export IRIS_USER_ID=<your-id>${UI.Style.TEXT_NORMAL}`,
    )
    prompts.log.info(
      `Or use:  ${UI.Style.TEXT_HIGHLIGHT}--user-id <id>${UI.Style.TEXT_NORMAL}`,
    )
  }
  return id
}

// ============================================================================
// Display helpers
// ============================================================================

export function dim(s: string): string {
  return `${UI.Style.TEXT_DIM}${s}${UI.Style.TEXT_NORMAL}`
}

export function bold(s: string): string {
  return `${UI.Style.TEXT_NORMAL_BOLD}${s}${UI.Style.TEXT_NORMAL}`
}

export function success(s: string): string {
  return `${UI.Style.TEXT_SUCCESS}${s}${UI.Style.TEXT_NORMAL}`
}

export function highlight(s: string): string {
  return `${UI.Style.TEXT_HIGHLIGHT}${s}${UI.Style.TEXT_NORMAL}`
}

/**
 * Write a JSON payload to stdout and WAIT for it to actually leave.
 *
 * `console.log(JSON.stringify(...))` is fire-and-forget. For a large payload Bun
 * hands part of it to the pipe and the process exits before the rest drains, so
 * whatever is reading gets a document cut off mid-string and reports corrupt
 * JSON. Measured on `iris bug list --limit 40 --json | python`: three of four
 * runs truncated at exactly 81,856 characters, the fourth delivered all 142,482.
 *
 * It never reproduces in a terminal, because TTY writes are synchronous — so it
 * only ever breaks the scripted use that `--json` exists for. Polling
 * writableLength does not help either: under Bun it reads 0 while bytes are
 * still in flight.
 *
 * Any command emitting --json should use this rather than console.log.
 */
export async function writeJson(value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2) + "\n"

  // Node-compatible callback form ONLY. Bun.write(Bun.stdout, ...) looks like the
  // native choice and HANGS here when stdout is a pipe — tried, reverted.
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    process.stdout.write(payload, done)
    // Backstop: never let a wedged consumer hang the CLI. Ref'd deliberately —
    // an unref'd timer would not fire, which is the whole point of a backstop.
    setTimeout(done, 10_000)
  })
}

export function printDivider(width = 60): void {
  console.log(`  ${UI.Style.TEXT_DIM}${"─".repeat(width)}${UI.Style.TEXT_NORMAL}`)
}

export function printKV(key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return
  console.log(`  ${dim(key + ":")}  ${String(value)}`)
}

// ============================================================================
// Non-interactive prompt guard
// ============================================================================
//
// Detects when the CLI is running in a non-interactive context (CI, scripts,
// piped input, agent shells) and short-circuits @clack/prompts calls so they
// fail loudly with a helpful "missing flag" message instead of hanging
// forever waiting on stdin that will never arrive.
//
// Use isNonInteractive() to gate prompt calls, and missingFlagError() to throw
// a consistent error pointing the user at the flag they should have passed.

export function isNonInteractive(): boolean {
  if (process.env.IRIS_NON_INTERACTIVE === "1" || process.env.IRIS_NON_INTERACTIVE === "true") return true
  if (process.env.CI) return true
  // process.stdin.isTTY is undefined when stdin is piped/redirected
  return !process.stdin.isTTY
}

export class MissingFlagError extends Error {
  constructor(flagName: string, hint?: string) {
    const base = `Missing required --${flagName}. Pass it explicitly when running in a non-interactive shell (CI, scripts, agents).`
    super(hint ? `${base} ${hint}` : base)
    this.name = "MissingFlagError"
  }
}

/**
 * Wrap a @clack/prompts call so it fails fast in non-TTY contexts.
 * Pass the flag name the user *should* have provided so the error tells
 * them exactly what to add to their command.
 */
export async function promptOrFail<T>(
  flagName: string,
  promptFn: () => Promise<T>,
): Promise<T> {
  if (isNonInteractive()) {
    throw new MissingFlagError(flagName)
  }
  return promptFn()
}

// ============================================================================
// Bridge (local daemon) — authenticated HTTP client
// ============================================================================

const BRIDGE_TOKEN_PATH = join(homedir(), ".iris", "bridge-token")

export const BRIDGE_URL = process.env.BRIDGE_URL ?? `http://localhost:${process.env.BRIDGE_PORT ?? "3200"}`

/** Read the auto-generated bridge auth token from ~/.iris/bridge-token */
export function getBridgeToken(): string | null {
  try {
    const fs = { existsSync, readFileSync }
    if (fs.existsSync(BRIDGE_TOKEN_PATH)) {
      return fs.readFileSync(BRIDGE_TOKEN_PATH, "utf-8").trim() || null
    }
  } catch {}
  return null
}

/** Fetch from the local bridge with auth header. Open endpoints work without token too. */
export async function bridgeFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getBridgeToken()
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers["X-Bridge-Key"] = token
  return fetch(`${BRIDGE_URL}${path}`, { ...opts, headers })
}
