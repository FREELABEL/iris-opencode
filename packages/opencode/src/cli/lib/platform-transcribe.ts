import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { isPersonToken } from "./live-dictation"
import { resolveSttPolicy } from "./stt-policy"

// ============================================================================
// Transcription through the IRIS platform — the same path IRIS Desktop takes
// (iris/1.18.23 packages/opencode/src/transcribe/remote.ts + chain.ts), so the
// CLI and Desktop answer the same audio the same way (#188304, #187808).
//
// THIS SENDS THE AUDIO OFF THE MACHINE, to iris-api POST /api/v1/genesis/transcribe,
// which forwards to fl-api's provider chain (xAI first). The board is what applies
// the PHI policy: the platform refuses audio filed under a PHI-marked board before
// any provider sees it. With no board configured the platform files the take under
// the person's own board, which is never a PHI board (#188013).
//
// Under `IRIS_TRANSCRIPTION_POLICY=sovereign` nothing here runs: the policy check
// comes before any credential is read.
// ============================================================================

export interface PlatformConfig {
  apiUrl: string
  token: string
  bloqId?: string
}

export class PlatformTranscribeError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 = the platform was never reached. */
    readonly status: number,
  ) {
    super(message)
    this.name = "PlatformTranscribeError"
  }
}

export interface PlatformDeps {
  env?: Record<string, string | undefined>
  configPath?: string
  token?: () => Promise<string>
  fetch?: typeof fetch
}

/** API URL, person token and (optional) board — or the reason the platform cannot be used. */
export async function resolvePlatformConfig(
  deps: PlatformDeps = {},
): Promise<{ config: PlatformConfig } | { reason: string }> {
  const env = deps.env ?? process.env
  if (resolveSttPolicy() === "sovereign")
    return { reason: "Transcription policy is 'sovereign' — audio stays on this machine." }

  let bloqId = env["IRIS_TRANSCRIBE_BLOQ_ID"]?.trim() || ""
  let apiUrl = env["IRIS_API_URL"]?.trim() || ""
  try {
    const path = deps.configPath ?? join(homedir(), ".iris", "config.json")
    if (existsSync(path)) {
      const cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      bloqId = bloqId || String(cfg["default_bloq_id"] ?? "").trim()
      apiUrl = apiUrl || String(cfg["api_url"] ?? "").trim()
    }
  } catch {
    /* an unreadable config is the same as no config */
  }
  if (!apiUrl) apiUrl = (await import("../cmd/iris-api")).IRIS_API

  let token = ""
  try {
    token = (await (deps.token ?? (async () => (await import("../cmd/iris-api")).resolveToken()))()).trim()
  } catch {
    token = ""
  }
  // The platform refuses anonymous transcription, and refuses a node_api_key as a caller.
  if (!token || !isPersonToken(token))
    return { reason: "Cloud transcription needs you signed in to IRIS — run: iris auth login" }

  return { config: { apiUrl: apiUrl.replace(/\/$/, ""), token, bloqId: bloqId || undefined } }
}

/** IRIS_TRANSCRIBE_PROVIDERS=xai,openrouter,openai — platform provider names, tried in order. Desktop's switch. */
export function platformProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env["IRIS_TRANSCRIBE_PROVIDERS"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return list.length ? list : ["xai"]
}

/** A hung connection must not hold a transcription forever. */
const TIMEOUT_MS = 90_000

export async function transcribePlatform(
  audio: Uint8Array,
  cfg: PlatformConfig,
  opts: { filename?: string; provider?: string; language?: string; fetch?: typeof fetch } = {},
): Promise<{ text: string; provider: string }> {
  const form = new FormData()
  form.append("audio_file", new Blob([audio as unknown as BlobPart], { type: "audio/wav" }), opts.filename ?? "audio.wav")
  if (cfg.bloqId) form.append("bloq_id", cfg.bloqId)
  form.append("provider", opts.provider ?? "xai")
  if (opts.language) form.append("language", opts.language)

  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${cfg.apiUrl}/api/v1/genesis/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new PlatformTranscribeError(`Could not reach ${cfg.apiUrl} for transcription: ${String(e)}`, 0)
  }
  const body = (await res.json().catch(() => null)) as any
  if (!res.ok || !body?.success)
    // The platform names the real cause (PHI board, dead provider, no credits) — surfaced, not flattened.
    throw new PlatformTranscribeError(body?.message || `Transcription failed (HTTP ${res.status})`, res.status)
  return {
    text: String(body?.data?.text ?? "").trim(),
    // The platform names the engine that actually answered; its own chain can differ from the one asked for.
    provider: String(body?.data?.provider || opts.provider || "xai"),
  }
}

/** Worth trying the next provider: unreachable, rate limited, or a server-side failure. A 4xx is a fact about the request. */
export function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

/**
 * The platform providers in order, moving on only on failures another provider could clear.
 * Throws the last error when all fail — the caller decides whether on-device whisper is a fallback.
 */
export async function transcribePlatformChain(
  audio: Uint8Array,
  cfg: PlatformConfig,
  opts: { filename?: string; language?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): Promise<{ text: string; provider: string }> {
  let last: unknown
  for (const provider of platformProviders(opts.env)) {
    try {
      return await transcribePlatform(audio, cfg, { ...opts, provider })
    } catch (e) {
      last = e
      if (e instanceof PlatformTranscribeError && !retryable(e.status)) throw e
    }
  }
  throw last
}

const boardCache = new Map<string, string>()

/**
 * The board a take is filed under: the configured one, else the one the platform picks for this
 * person (their own, never a PHI board), asked once at GET /api/v1/transcribe/scope. For paths
 * that must name a board up front — the live-preview relay. Undefined when the platform cannot say.
 */
export async function resolveBoard(cfg: PlatformConfig, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  if (cfg.bloqId) return cfg.bloqId
  const key = `${cfg.apiUrl}|${cfg.token}`
  const hit = boardCache.get(key)
  if (hit) return hit
  try {
    const res = await fetcher(`${cfg.apiUrl}/api/v1/transcribe/scope`, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => null)) as any
    const id = res.ok && body?.data?.bloq_id ? String(body.data.bloq_id) : undefined
    if (id) boardCache.set(key, id)
    return id
  } catch {
    return undefined
  }
}
