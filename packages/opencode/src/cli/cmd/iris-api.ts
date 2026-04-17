import { Auth } from "../../auth"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { homedir } from "os"
import { join } from "path"

// ============================================================================
// Base URLs — single source of truth for all platform endpoints.
// Override with env vars for local dev or custom deployments.
// ============================================================================

export const PLATFORM_URLS = {
  /** fl-api (Laravel backend — users, bloqs, leads, workflows) */
  flApi: process.env.IRIS_FL_API_URL ?? "https://raichu.heyiris.io",
  /** iris-api (V6 engine — chat, integrations exec, tools, monitor) */
  irisApi: process.env.IRIS_API_URL ?? "https://freelabel.net",
  /** Fallback URLs for iris-api (tried in order when primary fails) */
  irisApiFallbacks: ["https://main.heyiris.io", "https://iris-api.freelabel.net"],
} as const

// Aliases for backward compat — prefer PLATFORM_URLS in new code
export const FL_API = PLATFORM_URLS.flApi
export const IRIS_API = PLATFORM_URLS.irisApi

// ============================================================================
// Read ~/.iris/sdk/.env (written by iris-login)
// ============================================================================

let _sdkEnvCache: Record<string, string> | undefined

async function readSdkEnv(): Promise<Record<string, string>> {
  if (_sdkEnvCache) return _sdkEnvCache
  _sdkEnvCache = {}
  try {
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    const file = Bun.file(envPath)
    if (await file.exists()) {
      const text = await file.text()
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq > 0) {
          _sdkEnvCache[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
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
  if (stored?.type === "api" && stored.key) return stored.key
  // 2. Env var
  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  // 3. Read from ~/.iris/sdk/.env (written by iris-login installer)
  const sdkEnv = await readSdkEnv()
  return sdkEnv["IRIS_API_KEY"] ?? ""
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers as Record<string, string>),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${base}${path}`, { ...options, headers })
}

// ============================================================================
// Auth guard — call at start of commands that require auth
// ============================================================================

export async function requireAuth(): Promise<string | null> {
  const token = await resolveToken()
  if (!token) {
    prompts.log.warn("You are not logged in to the IRIS Platform.")
    prompts.log.info(
      `Run:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login${UI.Style.TEXT_NORMAL}  (select "IRIS Platform")`,
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
      msg = body.error ?? body.message ?? msg
    } catch {}
    prompts.log.warn(msg)
    process.exitCode = 1
    return false
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
    try {
      const body = (await res.json()) as { error?: string; message?: string; errors?: Record<string, string[]> }
      msg = body.error ?? body.message ?? msg
      // Laravel validation returns { errors: { field: ["msg", ...] } }
      if (body.errors && typeof body.errors === "object") {
        const details = Object.entries(body.errors)
          .map(([field, msgs]) => `  ${field}: ${(msgs as string[]).join(", ")}`)
          .join("\n")
        if (details) msg += "\n" + details
      }
    } catch {}
    prompts.log.error(`${action} failed: ${msg}`)
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
