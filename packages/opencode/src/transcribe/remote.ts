import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { TranscribeError } from "./local"

/**
 * Remote transcription — Grok (xAI) through the IRIS platform.
 *
 * ## THIS SENDS THE AUDIO OFF THE MACHINE
 *
 * The local path exists so dictation never could, and that property is worth keeping for
 * anything sensitive. This is the deliberate opposite, chosen because the local base.en model
 * is measurably worse. Measured on identical audio, same clip, same machine:
 *
 *     local whisper base.en   0.64s   "Southern  transcription keeps the audio on the machine."
 *     grok (xai)              0.93s   "Sovereign transcription keeps the audio on the machine."
 *
 * A trade, not an upgrade: better words, at the cost of the recording leaving the device.
 * Anything under a PHI policy must stay on transcribeLocal.
 *
 * The bloq scope is required by the platform and is what applies its transcription policy.
 * There is no unscoped path, by design — an authenticated request without one is refused.
 */

export interface RemoteConfig {
  apiUrl: string
  /** Optional: the endpoint accepts a scoped request without one. */
  token?: string
  bloqId: string
}

/** Read ~/.iris/config.json, the same file the CLI authenticates with. Env wins. */
export function readRemoteConfig(): RemoteConfig | null {
  let apiUrl = process.env["IRIS_API_URL"]?.trim() || ""
  let token = process.env["IRIS_API_KEY"]?.trim() || ""
  let bloqId = process.env["IRIS_TRANSCRIBE_BLOQ_ID"]?.trim() || ""

  try {
    const p = join(homedir(), ".iris", "config.json")
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
      apiUrl = apiUrl || String(cfg["api_url"] ?? "")
      token = token || String(cfg["node_api_key"] ?? "")
      bloqId = bloqId || String(cfg["default_bloq_id"] ?? "")
    }
  } catch {
    /* an unreadable config is the same as no config */
  }

  // The token is OPTIONAL. ~/.iris/config.json holds a node_api_key, which this endpoint
  // rejects ("Invalid token format. Expected JWT or valid API token") — sending it turns a
  // working request into a 401. The scope is what the endpoint actually requires.
  if (!apiUrl || !bloqId) return null
  const usable = token && /^(ey|iris_|fl_)/.test(token) ? token : undefined
  return { apiUrl: apiUrl.replace(/\/$/, ""), token: usable, bloqId }
}

export async function transcribeRemote(
  audio: Uint8Array,
  cfg: RemoteConfig,
  opts: { filename?: string; provider?: string } = {},
): Promise<{ text: string; provider: string; ms: number }> {
  const started = Date.now()
  const form = new FormData()
  form.append("audio_file", new Blob([audio as unknown as BlobPart], { type: "audio/wav" }), opts.filename ?? "dictation.wav")
  form.append("bloq_id", cfg.bloqId)
  form.append("provider", opts.provider ?? "xai")

  let res: Response
  try {
    res = await fetch(`${cfg.apiUrl}/api/v1/genesis/transcribe`, {
      method: "POST",
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      body: form,
    })
  } catch (e) {
    throw new TranscribeError(`Could not reach ${cfg.apiUrl} for remote transcription: ${String(e)}`)
  }

  const body = (await res.json().catch(() => null)) as any
  if (!res.ok || !body?.success) {
    // The platform names the real cause (dead provider, bad scope, no credits). Surfaced
    // rather than flattened — that is exactly what let us diagnose the provider outage.
    throw new TranscribeError(body?.message || `Remote transcription failed (HTTP ${res.status})`)
  }
  return {
    text: String(body?.data?.text ?? "").trim(),
    provider: String(body?.data?.provider ?? opts.provider ?? "xai"),
    ms: Date.now() - started,
  }
}
