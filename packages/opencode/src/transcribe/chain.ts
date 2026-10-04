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
  ) {
    super(message)
  }
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
  },
) {
  const attempts: Attempt[] = []
  const backoff = opts.backoffMs ?? [400, 1200]
  const remote = opts.remote

  for (const provider of remote ? (opts.providers ?? defaultProviders()) : []) {
    if (!remote) break
    for (const wait of [0, ...backoff]) {
      if (wait) await Bun.sleep(wait)
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

/** IRIS_TRANSCRIBE_PROVIDERS=xai,openai — platform provider names, tried in order. */
function defaultProviders() {
  const list = (process.env["IRIS_TRANSCRIBE_PROVIDERS"] ?? "xai,openai")
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
