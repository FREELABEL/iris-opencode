import { localWhisperReady, stripNonSpeech, transcribeLocal, TranscribeError } from "./local"
import { RemoteTranscribeError, transcribeRemote, type RemoteConfig } from "./remote"

/**
 * Dictation engine chain: Grok first, other cloud engines next, on-device whisper LAST.
 *
 * Each cloud engine is retried only on failures that can clear by themselves (unreachable,
 * timeout, 429, 5xx) and then the chain moves on. A 4xx is a fact about the request or the
 * account — retrying it spends time to fail again — so it moves on immediately.
 *
 * Falling through engines cannot route around the PHI policy: the platform applies it to the
 * board on EVERY cloud provider, so a refused recording is refused by each of them. On-device
 * whisper is the one engine that never leaves the machine, so it is also the right last stop
 * for a refusal — but only if it is already installed (see localWhisperReady).
 *
 * The caller holds the audio on disk before calling this (held.ts), so total failure loses
 * nothing: it returns the attempts, and the recording waits for a retry.
 */

export interface Attempt {
  engine: string
  ok: boolean
  /** HTTP status from the platform; 0 = never reached. Absent for on-device whisper. */
  status?: number
  error?: string
  ms: number
}

export class ChainError extends TranscribeError {
  constructor(
    message: string,
    readonly attempts: Attempt[],
    /**
     * True when no engine and no retry can succeed on THIS recording (a 413: it is over the
     * platform's size limit). The caller must not hold it for a retry that would fail the same way.
     */
    readonly final = false,
    /** The HTTP status that made it final, when there was one. */
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Longest a Retry-After may hold one dictation inside the chain. The person is waiting. */
export const MAX_RETRY_AFTER_MS = 5000

/** Default engine order. Grok primary; OpenRouter second as the multi-model aggregator. */
const DEFAULT_PROVIDERS = "xai,openrouter,openai"

/** The engines a dictation would try right now, in order — what /transcribe/health reports. */
export function effectiveEngines(opts: { remote: RemoteConfig | null; local: boolean; providers?: string[] }) {
  return [...(opts.remote ? (opts.providers ?? defaultProviders()) : []), ...(opts.local ? ["whisper-local"] : [])]
}

export async function transcribeWithFallback(
  audio: Uint8Array,
  opts: {
    filename: string
    language?: string
    remote: RemoteConfig | null
    providers?: string[]
    local?: boolean
    /** Waits between retries of ONE engine; its length is the retry count. */
    backoffMs?: number[]
    /** Cap on a server's Retry-After; defaults to MAX_RETRY_AFTER_MS. */
    maxRetryAfterMs?: number
  },
) {
  const attempts: Attempt[] = []
  const backoff = opts.backoffMs ?? [400, 1200]
  const remote = opts.remote
  // A 429's Retry-After, owed before the NEXT request — same engine or the next one, since the
  // limit may be the platform's own and every engine sits behind it.
  let owed = 0

  for (const provider of remote ? (opts.providers ?? defaultProviders()) : []) {
    if (!remote) break
    for (const wait of [0, ...backoff]) {
      const pause = Math.max(wait, owed)
      owed = 0
      if (pause) await Bun.sleep(pause)
      const started = Date.now()
      const result = await transcribeRemote(audio, remote, {
        filename: opts.filename,
        language: opts.language,
        provider,
      }).catch((e: unknown) => (e instanceof Error ? e : new TranscribeError(String(e))))
      if (!(result instanceof Error)) {
        attempts.push({ engine: provider, ok: true, status: 200, ms: Date.now() - started })
        return { text: stripNonSpeech(result.text), provider: result.provider, attempts }
      }
      const status = result instanceof RemoteTranscribeError ? result.status : 0
      attempts.push({ engine: provider, ok: false, status, error: result.message, ms: Date.now() - started })
      // Over the size limit: every engine sits behind the same limit, and a held copy would be
      // retried into the same refusal for a week. Stop here and say what the limit is.
      if (status === 413) throw new ChainError(tooLargeMessage(result.message), attempts, true, 413)
      if (status === 429 && result instanceof RemoteTranscribeError && result.retryAfterMs !== undefined)
        owed = Math.min(result.retryAfterMs, opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS)
      if (!retryable(status)) break
    }
  }

  if (opts.local ?? localWhisperReady()) {
    const started = Date.now()
    const result = await transcribeLocal(audio, { filename: opts.filename, language: opts.language }).catch(
      (e: unknown) => (e instanceof Error ? e : new TranscribeError(String(e))),
    )
    if (!(result instanceof Error)) {
      attempts.push({ engine: "whisper-local", ok: true, ms: Date.now() - started })
      return { text: stripNonSpeech(result.text), provider: result.provider, attempts }
    }
    attempts.push({ engine: "whisper-local", ok: false, error: result.message, ms: Date.now() - started })
  }

  throw new ChainError(failureMessage(remote, attempts), attempts)
}

function retryable(status: number) {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

/**
 * The platform refuses uploads over 25 MB — about 13 minutes of the 16 kHz mono WAV both capture
 * paths produce. Named in the message so the person knows to split the take, not to retry it.
 */
function tooLargeMessage(platform: string) {
  return `That recording is too long to transcribe: the platform accepts up to 25 MB of audio (about 13 minutes). Record it in shorter parts.${platform ? ` (${platform})` : ""}`
}

/** IRIS_TRANSCRIBE_PROVIDERS=xai,openrouter,openai — platform provider names, tried in order. */
function defaultProviders() {
  const list = (process.env["IRIS_TRANSCRIBE_PROVIDERS"] ?? DEFAULT_PROVIDERS)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return list.length ? list : ["xai"]
}

/** One line per engine, its LAST error — the thing a person (or a bug report) needs. */
function failureMessage(remote: RemoteConfig | null, attempts: Attempt[]) {
  if (!remote && attempts.length === 0)
    return "Dictation needs an IRIS account and a board to file it under. Sign in with `iris auth login`, then set IRIS_TRANSCRIBE_BLOQ_ID or `default_bloq_id` in ~/.iris/config.json."
  const last = new Map(attempts.map((a) => [a.engine, a.error ?? ""]))
  const detail = [...last].map(([engine, error]) => `${engine}: ${error.slice(0, 160)}`).join(" · ")
  return `Every transcription engine failed (${detail})`
}
