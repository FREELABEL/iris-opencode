import { appendFileSync, chmodSync, createReadStream, mkdirSync, mkdtempSync, rmSync, statSync } from "fs"
import { createHash } from "crypto"
import { homedir, tmpdir } from "os"
import { join } from "path"

// ============================================================================
// STT policy + audit — the CEILING over provider selection, and the record that
// proves what happened. Epic #182784.
//
// The problem this exists for: transcribeAudio() had a local-first DEFAULT but
// no ceiling. `--provider openai` or IRIS_TRANSCRIPTION_PROVIDER=openai routed
// the user's audio to a cloud POST, and no value of any variable could make that
// branch unreachable. A default is a preference. A policy is what you cannot
// override — so this module owns the clamp, not the caller.
// ============================================================================

export type SttPolicy = "sovereign" | "standard"

/** Providers that never leave the machine. Everything else is a network egress. */
const LOCAL_PROVIDERS = new Set(["whisper-local"])

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider)
}

/**
 * The machine's policy ceiling. Defaults to `sovereign`: audio stays on the box
 * unless someone deliberately opens it. Defaulting the other way would mean a
 * fresh install uploads voice on the first misconfiguration, and the failure is
 * silent — you cannot un-send audio.
 */
export function resolveSttPolicy(): SttPolicy {
  const raw = (process.env.IRIS_TRANSCRIPTION_POLICY ?? "").trim().toLowerCase()
  if (raw === "standard") return "standard"
  if (raw === "sovereign" || raw === "") return "sovereign"
  // An unrecognised policy must fail CLOSED. Treating a typo as "standard" would
  // turn `POLICY=soverign` into a silent egress.
  return "sovereign"
}

export class SttPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SttPolicyError"
  }
}

/**
 * Clamp a requested provider to what policy allows.
 *
 * Two different situations, deliberately handled differently:
 *  - EXPLICIT request (`--provider openai`) under sovereign -> THROW. Silently
 *    ignoring a flag the user typed is the "present-but-empty is not present"
 *    class of bug: they would read `provider: whisper-local` in the output and
 *    never learn their flag did nothing.
 *  - AMBIENT request (env var, no flag) under sovereign -> clamp to local and
 *    say so on stderr. An inherited env var is not a decision the user made here.
 */
export function clampProvider(
  requested: string,
  opts: { explicit: boolean; policy?: SttPolicy; warn?: (msg: string) => void } = { explicit: false },
): string {
  const policy = opts.policy ?? resolveSttPolicy()
  if (policy === "standard") return requested
  if (isLocalProvider(requested)) return requested

  if (opts.explicit) {
    throw new SttPolicyError(
      `Transcription policy is 'sovereign', so audio cannot be sent to '${requested}'.\n` +
        `  Audio stays on this machine. Nothing was uploaded.\n` +
        `  To allow cloud providers for this run: IRIS_TRANSCRIPTION_POLICY=standard`,
    )
  }

  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"))
  warn(
    `  ⚠ IRIS_TRANSCRIPTION_PROVIDER=${requested} ignored — policy is 'sovereign'. Using whisper-local.`,
  )
  return "whisper-local"
}

// ---------------------------------------------------------------------------
// Temp files
// ---------------------------------------------------------------------------

/**
 * A 0700 directory for audio scratch.
 *
 * On macOS os.tmpdir() is already a per-user 0700 dir, so this is belt-and-braces.
 * On Linux it is /tmp (mode 1777) where a 0644 WAV of someone's voice is readable
 * by every account on the box — that is the platform this actually fixes (ADR-02).
 */
export function secureTempDir(prefix = "iris-stt-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return dir
}

/** Best-effort recursive delete. Never throws — cleanup must not mask a real error. */
export function discardDir(dir: string | null | undefined): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** Best-effort single-file delete. Never throws. */
export function discardFile(path: string | null | undefined): void {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface SttAuditRecord {
  provider: string
  policy: SttPolicy
  bytes: number
  sha256: string
  ms: number
  ok: boolean
  error?: string
}

/**
 * One JSONL line per transcription: what was processed, by whom, how long.
 *
 * Explicitly NOT recorded: the audio, and the transcript text. An audit trail
 * that quotes the transcript is a second copy of the thing you were protecting.
 * The sha256 is enough to prove two runs saw the same audio without retaining any.
 */
export function auditTranscription(rec: SttAuditRecord): void {
  try {
    const dir = join(homedir(), ".iris", "logs")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdirSync's `mode` applies ONLY to directories it actually creates. ~/.iris/logs
    // already exists (0744, shared with the daemon logs), so the mode above was a
    // silent no-op and the audit dir stayed group/world listable. Measured, not assumed.
    // chmod unconditionally instead of trusting the create path.
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* not ours to chmod — the 0600 file mode below is the real protection */
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"
    appendFileSync(join(dir, "transcription.jsonl"), line, { mode: 0o600 })
  } catch {
    // Auditing must never break transcription. A dropped line is a worse outcome
    // than a failed transcription only if you never notice — hence `iris transcribe
    // --audit` reads this file back rather than trusting that it was written.
  }
}

/** sha256 of a buffer, for the audit line. */
export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex")
}

/**
 * sha256 + byte count of a file, streamed.
 *
 * Streamed rather than readFileSync because this runs on meeting recordings, and
 * loading an hour of audio into memory to compute a hash we only need 64 chars of
 * would be a memory spike proportional to the thing we are trying to be careful with.
 * Never throws: an audit line we cannot compute must not fail the transcription.
 */
export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  try {
    const bytes = statSync(path).size
    const hash = createHash("sha256")
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(path)
      rs.on("data", (c) => hash.update(c))
      rs.on("end", () => resolve())
      rs.on("error", reject)
    })
    return { sha256: hash.digest("hex"), bytes }
  } catch {
    return { sha256: "", bytes: 0 }
  }
}
