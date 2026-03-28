import { Auth } from "../../auth"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"

// ============================================================================
// Base URLs
// ============================================================================

export const FL_API = process.env.IRIS_FL_API_URL ?? "https://apiv2.heyiris.io"
export const IRIS_API = process.env.IRIS_API_URL ?? "https://iris-api.heyiris.io"

// ============================================================================
// Auth token resolution
// ============================================================================

async function resolveToken(): Promise<string> {
  // 1. Try stored auth (iris auth login)
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) return stored.key
  // 2. Env var fallback (backwards compat with PHP CLI users)
  return process.env.IRIS_API_KEY ?? ""
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
    prompts.log.warn("You are not logged in.")
    prompts.log.info(
      `Set your API key:  ${UI.Style.TEXT_HIGHLIGHT}export IRIS_API_KEY=<your-key>${UI.Style.TEXT_NORMAL}`,
    )
    prompts.log.info(
      `Or run:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login${UI.Style.TEXT_NORMAL}`,
    )
    return null
  }
  return token
}

// ============================================================================
// Response helpers
// ============================================================================

export async function handleApiError(res: Response, action: string): Promise<boolean> {
  if (res.status === 401 || res.status === 403) {
    prompts.log.warn("Authentication failed — your token may be expired or invalid.")
    prompts.log.info(
      `Refresh:  ${UI.Style.TEXT_HIGHLIGHT}iris auth login${UI.Style.TEXT_NORMAL}`,
    )
    return false
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      msg = body.error ?? body.message ?? msg
    } catch {}
    prompts.log.error(`${action} failed: ${msg}`)
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

  // 2. Auto-resolve from /api/v1/me
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
