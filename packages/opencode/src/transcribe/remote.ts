import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { TranscribeError } from "./local"

/**
 * Dictation transcription through the IRIS platform's engines (xAI first; the order is
 * transcribe/chain.ts). THIS SENDS THE AUDIO OFF THE MACHINE. Since 2026-10-04 the cloud is the
 * primary path; on-device whisper is only a last resort, used when it is already installed
 * (localWhisperReady) — never downloaded mid-dictation. Measured on identical audio, same machine:
 *
 *     local whisper base.en   0.64s   "Southern  transcription keeps the audio on the machine."
 *     grok (xai)              0.93s   "Sovereign transcription keeps the audio on the machine."
 *
 * The bloq scope is required by the platform and is what applies its PHI transcription policy:
 * fl-api refuses audio filed under a PHI-marked board before it reaches xAI. There is no
 * unscoped path, by design — a request without one is refused.
 */

export interface RemoteConfig {
  apiUrl: string
  /** Optional: the endpoint accepts a scoped request without one. */
  token?: string
  /** Optional: with none, the platform files the take under the person's own board (#188013). */
  bloqId?: string
}

/** Read ~/.iris/config.json, the same file the CLI authenticates with. Env wins. */
export function readRemoteConfig(): RemoteConfig | null {
  return describeRemoteConfig().config
}

/**
 * The remote config, or — when there is none — what is missing, in words a person can act on.
 * GET /transcribe/health reports the reason as `cloud.reason`.
 */
export function describeRemoteConfig(
  configPath = join(homedir(), ".iris", "config.json"),
): { config: RemoteConfig | null; reason?: string } {
  let apiUrl = process.env["IRIS_API_URL"]?.trim() || ""
  let token = process.env["IRIS_API_KEY"]?.trim() || ""
  let bloqId = process.env["IRIS_TRANSCRIBE_BLOQ_ID"]?.trim() || ""

  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
      apiUrl = apiUrl || String(cfg["api_url"] ?? "")
      token = token || String(cfg["node_api_key"] ?? "")
      bloqId = bloqId || String(cfg["default_bloq_id"] ?? "")
    }
  } catch {
    /* an unreadable config is the same as no config */
  }

  if (!apiUrl)
    return {
      config: null,
      reason: "You are not signed in to IRIS. Run iris auth login in a terminal, then try dictation again.",
    }
  // The platform refuses anonymous transcription, so a person's credential is REQUIRED. The
  // node_api_key in ~/.iris/config.json is not one — the platform rejects it as a caller — so
  // only shapes the platform's guard accepts are sent; anything else is reported, not tried.
  const usable = token && isPersonToken(token) ? token : undefined
  if (!usable)
    return {
      config: null,
      reason: "Dictation needs you signed in to IRIS. Run iris auth login in a terminal, then restart IRIS.",
    }
  return { config: { apiUrl: apiUrl.replace(/\/$/, ""), token: usable, bloqId: bloqId || undefined } }
}

/**
 * Credentials the platform accepts as a person: a Passport JWT, the 64-character SDK token the
 * desktop is launched with (~/.iris/sdk/.env), or a prefixed iris_/fl_ API token.
 */
export function isPersonToken(token: string): boolean {
  if (/^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return true
  if (/^[A-Za-z0-9]{64}$/.test(token)) return true
  return /^(iris_|fl_)[A-Za-z0-9_-]{8,}$/.test(token)
}

/** A failed platform call. `status` is the HTTP status, or 0 when the platform was never reached. */
export class RemoteTranscribeError extends TranscribeError {
  constructor(
    message: string,
    readonly status: number,
    /** The platform's Retry-After, in ms, when it sent one (429/503). Unbounded here; the chain caps it. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/** Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/** A hung connection must not hold a dictation forever; the retry chain needs it to fail. */
const TIMEOUT_MS = 90_000

export async function transcribeRemote(
  audio: Uint8Array,
  cfg: RemoteConfig,
  opts: { filename?: string; provider?: string; language?: string } = {},
): Promise<{ text: string; provider: string; ms: number }> {
  const started = Date.now()
  const form = new FormData()
  form.append("audio_file", new Blob([audio as unknown as BlobPart], { type: "audio/wav" }), opts.filename ?? "dictation.wav")
  // No board configured is normal: the platform files the take under the person's own board.
  if (cfg.bloqId) form.append("bloq_id", cfg.bloqId)
  form.append("provider", opts.provider ?? "xai")
  if (opts.language) form.append("language", opts.language)

  let res: Response
  try {
    res = await fetch(`${cfg.apiUrl}/api/v1/genesis/transcribe`, {
      method: "POST",
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new RemoteTranscribeError(`Could not reach ${cfg.apiUrl} for remote transcription: ${String(e)}`, 0)
  }

  const body = (await res.json().catch(() => null)) as any
  if (!res.ok || !body?.success) {
    // The platform names the real cause (dead provider, bad scope, no credits). Surfaced
    // rather than flattened — that is exactly what let us diagnose the provider outage.
    throw new RemoteTranscribeError(
      body?.message || `Remote transcription failed (HTTP ${res.status})`,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    )
  }
  return {
    text: String(body?.data?.text ?? "").trim(),
    // The platform names the engine that actually answered — with a server-side chain that can
    // differ from the one asked for. Fall back to the one asked for, never to a hard-coded name.
    provider: String(body?.data?.provider || opts.provider || "xai"),
    ms: Date.now() - started,
  }
}

const boardCache = new Map<string, string>()

/**
 * The board a take is filed under: the configured one, else the one the platform picks for this
 * person (their own, never a PHI board) — asked once at /v1/transcribe/scope and remembered. For the
 * paths that must name a board up front (the live-preview relay, spoken replies). Undefined, never
 * a throw, when the platform cannot say: the caller reports that in words.
 */
export async function resolveBoard(cfg: { apiUrl: string; token?: string; bloqId?: string }): Promise<string | undefined> {
  if (cfg.bloqId) return cfg.bloqId
  if (!cfg.token) return undefined
  const key = `${cfg.apiUrl}|${cfg.token}`
  const hit = boardCache.get(key)
  if (hit) return hit
  try {
    const res = await fetch(`${cfg.apiUrl}/api/v1/transcribe/scope`, {
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
