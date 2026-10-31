import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * Held recordings — dictation audio written to disk BEFORE any engine sees it.
 *
 * Transcription is a network call to a cloud engine, and cloud engines fail: a disabled key, an
 * exhausted balance, a dropped connection. Without this, every one of those failures throws away
 * what the person just said and asks them to say it again. With it, a failed dictation is a
 * saved file that can be retried — automatically by the app, or by hand after a restart.
 *
 * Files are private to the user (0700 dir, 0600 files), deleted the moment a transcript comes
 * back, and pruned after MAX_AGE_MS so a dead engine cannot fill the disk with recordings.
 */

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const KEPT = "kept"
/** Ids are generated here and come back from the UI, so they are validated before touching a path. */
const ID = /^[0-9]{13}-[a-z0-9]{6}$/

export interface Held {
  id: string
  bytes: number
  /** Duration, assuming the 16 kHz mono 16-bit WAV both capture paths produce. */
  seconds: number
  createdAt: number
  /** The board it was recorded under, when it was recorded for one (an Atlas card). */
  bloqId?: string
  /** See HeldMeta.review. */
  review?: boolean
}

/** What a held take must keep besides its audio. */
export interface HeldMeta {
  /**
   * The board it was recorded under (#190041 ADR-01). A retry uploads under THIS board, never the
   * person's default: the platform applies the named board's cloud/PHI policy, so a retry that
   * drifted to another board would be judged by the wrong policy.
   */
  bloqId?: string
  /**
   * The person touched the take's text before it ended (#191998). Its transcript holds words they
   * removed, so it is offered for review and its recording is kept, never put back in the message.
   */
  review?: boolean
}

export function hold(audio: Uint8Array, dir = defaultDir(), meta: HeldMeta = {}): Held {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`
  writeFileSync(join(dir, `${id}.wav`), audio, { mode: 0o600 })
  if (meta.bloqId || meta.review) writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 })
  return {
    ...describe(id, audio.byteLength, Date.now()),
    ...(meta.bloqId ? { bloqId: meta.bloqId } : {}),
    ...(meta.review ? { review: true } : {}),
  }
}

/** The board a held take was recorded under, or {} for one taken without a board. */
export function readHeldMeta(id: string, dir = defaultDir()): HeldMeta {
  if (!ID.test(id)) return {}
  try {
    const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as HeldMeta
    return {
      ...(typeof meta.bloqId === "string" && /^[0-9]+$/.test(meta.bloqId) ? { bloqId: meta.bloqId } : {}),
      ...(meta.review === true ? { review: true } : {}),
    }
  } catch {
    return {}
  }
}

/** Read a held recording, or null if the id is malformed or the file is gone. */
export function readHeld(id: string, dir = defaultDir()): Uint8Array | null {
  if (!ID.test(id)) return null
  try {
    return new Uint8Array(readFileSync(join(dir, `${id}.wav`)))
  } catch {
    return null
  }
}

export function release(id: string, dir = defaultDir()) {
  if (!ID.test(id)) return
  rmSync(join(dir, `${id}.wav`), { force: true })
  rmSync(join(dir, `${id}.json`), { force: true })
}

/**
 * Keep a transcribed take's recording: the person touched its text, and "Full transcript" still
 * offers the audio (#191998). One file, the newest such take: the next replaces it, and it is pruned
 * with the held recordings. Returns where it now is.
 */
export function keepRecording(id: string, dir = defaultDir()): { id: string; path: string } | undefined {
  if (!ID.test(id)) return undefined
  const kept = join(dir, KEPT)
  rmSync(kept, { recursive: true, force: true })
  mkdirSync(kept, { recursive: true, mode: 0o700 })
  const path = join(kept, `${id}.wav`)
  renameSync(join(dir, `${id}.wav`), path)
  rmSync(join(dir, `${id}.json`), { force: true })
  return { id, path }
}

/** Delete a kept recording, or a held one: the id is the same either way. */
export function discard(id: string, dir = defaultDir()) {
  release(id, dir)
  release(id, join(dir, KEPT))
}

/** Every held recording, oldest first. Prunes anything past MAX_AGE_MS on the way. */
export function listHeld(dir = defaultDir(), now = Date.now()): Held[] {
  if (basename(dir) !== KEPT) listHeld(join(dir, KEPT), now)
  const names = (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()
  return names
    .flatMap((name) => {
      const id = name.replace(/\.wav$/, "")
      if (!ID.test(id)) return []
      const stat = statSync(join(dir, name))
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        release(id, dir)
        return []
      }
      return [{ ...describe(id, stat.size, stat.mtimeMs), ...readHeldMeta(id, dir) }]
    })
    .sort((a, b) => a.createdAt - b.createdAt)
}

function describe(id: string, bytes: number, createdAt: number): Held {
  return { id, bytes, seconds: Math.max(0, Math.round((bytes - 44) / 32000)), createdAt }
}

function defaultDir() {
  return join(Global.Path.state, "dictation")
}
