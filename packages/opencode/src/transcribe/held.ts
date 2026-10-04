import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { join } from "path"
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
/** Ids are generated here and come back from the UI, so they are validated before touching a path. */
const ID = /^[0-9]{13}-[a-z0-9]{6}$/

export interface Held {
  id: string
  bytes: number
  /** Duration, assuming the 16 kHz mono 16-bit WAV both capture paths produce. */
  seconds: number
  createdAt: number
}

export function hold(audio: Uint8Array, dir = defaultDir()): Held {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`
  writeFileSync(join(dir, `${id}.wav`), audio, { mode: 0o600 })
  return describe(id, audio.byteLength, Date.now())
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
}

/** Every held recording, oldest first. Prunes anything past MAX_AGE_MS on the way. */
export function listHeld(dir = defaultDir(), now = Date.now()): Held[] {
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
      return [describe(id, stat.size, stat.mtimeMs)]
    })
    .sort((a, b) => a.createdAt - b.createdAt)
}

function describe(id: string, bytes: number, createdAt: number): Held {
  return { id, bytes, seconds: Math.max(0, Math.round((bytes - 44) / 32000)), createdAt }
}

function defaultDir() {
  return join(Global.Path.state, "dictation")
}
