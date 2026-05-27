import { Auth } from "../../auth"
import * as prompts from "./clack"
import { UI } from "../ui"
import { homedir } from "os"
import { join } from "path"

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
    const _fs = require("fs"), _path = require("path")
    const _envPath = _path.join(require("os").homedir(), ".iris", "sdk", ".env")
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
} as const

// Aliases for backward compat — prefer PLATFORM_URLS in new code
export const FL_API = PLATFORM_URLS.flApi
export const IRIS_API = PLATFORM_URLS.irisApi

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
    const fs = require("fs")
    const path = require("path")
    const envPath = path.join(require("os").homedir(), ".iris", "sdk", ".env")
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

async function resolveToken(): Promise<string> {
  // 1. Try stored auth (iris auth login)
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) {
    if (process.argv.includes("--print-logs")) console.error("[auth] token source: iris auth store")
    return stored.key
  }
  // 2. Env var
  if (process.env.IRIS_API_KEY) {
    if (process.argv.includes("--print-logs")) console.error("[auth] token source: IRIS_API_KEY env var")
    return process.env.IRIS_API_KEY
  }
  // 3. Read from ~/.iris/sdk/.env (written by iris-login installer)
  const sdkEnv = await readSdkEnv()
  if (sdkEnv["IRIS_API_KEY"]) {
    if (process.argv.includes("--print-logs")) console.error("[auth] token source: ~/.iris/sdk/.env")
    return sdkEnv["IRIS_API_KEY"]
  }
  // 4. Read node_api_key from ~/.iris/config.json as last resort (used by hive commands)
  try {
    const fs = require("fs"), path = require("path")
    const configPath = path.join(require("os").homedir(), ".iris", "config.json")
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      if (config.node_api_key) {
        if (process.argv.includes("--print-logs")) console.error("[auth] token source: ~/.iris/config.json node_api_key")
        return config.node_api_key
      }
    }
  } catch {}
  return ""
}

// ============================================================================
// Shared fetch helper
// ============================================================================

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
    console.error(`[irisFetch] token: ${token ? token.slice(0, 12) + "..." : "(none)"}`)
    console.error(`[irisFetch] body keys: ${options.body ? Object.keys(JSON.parse(String(options.body))).join(", ") : "(none)"}`)
  }
  const res = await fetch(url, { ...options, headers })
  if (process.argv.includes("--print-logs")) {
    console.error(`[irisFetch] → ${res.status} ${res.statusText}`)
  }
  return res
}

// ============================================================================
// Auth guard — call at start of commands that require auth
// ============================================================================

export async function requireAuth(): Promise<string | null> {
  const token = await resolveToken()
  if (!token) {
    prompts.log.warn("Not authenticated. No token found in any of:")
    prompts.log.info("  1. iris auth store (run: iris auth login)")
    prompts.log.info("  2. IRIS_API_KEY env var")
    prompts.log.info("  3. ~/.iris/sdk/.env")
    prompts.log.info("  4. ~/.iris/config.json (node_api_key)")
    prompts.log.info(
      `\nFix:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login${UI.Style.TEXT_NORMAL}  or set IRIS_API_KEY`,
    )
    return null
  }
  return token
}

// ============================================================================
// Response helpers
// ============================================================================

export async function handleApiError(res: Response, action: string): Promise<boolean> {
  if (res.status === 401) {
    prompts.log.warn("Authentication failed — your token may be expired or invalid.")
    prompts.log.info(
      `Re-authenticate:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login --force${UI.Style.TEXT_NORMAL}`,
    )
    process.exitCode = 1
    return false
  }
  if (res.status === 403) {
    let msg = "Access denied"
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      msg = body.error || body.message || msg
    } catch {}
    prompts.log.warn(msg)
    process.exitCode = 1
    return false
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
    try {
      const body = (await res.json()) as { error?: string; message?: string; errors?: Record<string, string[]> }
      // Bug #57643/#57647: use || not ?? — API returns {"message":""} which ?? doesn't fall through
      const rawMsg = body.error || body.message || ""
      // Bug #57646: sanitize raw Laravel model errors (e.g. "No query results for model [App\Models\Bloq\ScheduledJob]")
      if (rawMsg) {
        msg = rawMsg.includes("No query results for model")
          ? "Resource not found"
          : rawMsg.replace(/\[App\\Models\\[^\]]+\]/g, "").trim()
      }
      // Laravel validation returns { errors: { field: ["msg", ...] } }
      if (body.errors && typeof body.errors === "object") {
        const details = Object.entries(body.errors)
          .map(([field, msgs]) => `  ${field}: ${(msgs as string[]).join(", ")}`)
          .join("\n")
        if (details) msg += "\n" + details
      }
    } catch {}
    prompts.log.error(`${action} failed: ${msg}`)
    // Ensure error is visible even when clack rendering swallows output
    console.error(`  Error: ${msg}`)
    process.exitCode = 1
    return false
  }
  return true
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

  // 3. Auto-resolve from /api/v1/me
  try {
    const res = await irisFetch("/api/v1/me")
    if (res.ok) {
      const data = (await res.json()) as { data?: { id?: number }; id?: number }
      const id = data?.data?.id ?? data?.id
      if (typeof id === "number") {
        _cachedUserId = id
        return id
      }
    }
  } catch {}

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
    const fs = require("fs")
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
