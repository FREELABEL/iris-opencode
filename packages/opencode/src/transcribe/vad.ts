import { wavFormat } from "./segments"

/**
 * Does this recording contain speech? Asked BEFORE any engine sees it, because every engine is a
 * paid cloud call now (#187808) and a take of room noise is still a take: it uploads, it bills,
 * and whisper-family models answer it with a confident "You" or "(upbeat music)".
 *
 * The peak check at /dictate/stop catches a DEAD microphone (peak < 0.01). It cannot catch a live
 * microphone in a room where nobody spoke: an air conditioner or a laptop fan peaks far above 0.01.
 * Hermes Agent measured exactly that failure — 7 ghost prompts in 13 minutes — before gating it
 * (NousResearch/hermes-agent#127190). This is the same gate without a model download.
 *
 * Method: 30 ms frames, loudness per frame, the take's own quiet level as its noise floor. Speech
 * is loudness well above that floor, sustained for at least a syllable, adding up to at least
 * 250 ms. Steady noise has no such excursions; a click or a door has them for too short a time.
 *
 * FAIL-OPEN, always. Anything this cannot read, or a take too loud throughout to tell noise from
 * continuous speech, answers true and goes to the engine exactly as before. This gate may cost a
 * wasted upload. It must never be the reason real speech was thrown away.
 */

const FRAME_SAMPLES = 480 // 30 ms at 16 kHz
/** Speech must stand this far above the take's own quiet level. */
const ABOVE_FLOOR_DB = 12
/** ...and above this, so a near-silent take's floor cannot make its hiss look loud. */
const ABSOLUTE_MIN_DB = -50
/** A burst shorter than this many frames (90 ms) is a click, not a syllable. */
const MIN_RUN_FRAMES = 3
/** Total speech needed, matching the Silero settings Hermes ships (min speech 250 ms). */
const MIN_SPEECH_MS = 250
/** A take whose QUIET level is this loud is either a very loud room or wall-to-wall speech. Can't tell — send it. */
const AMBIGUOUS_FLOOR_DB = -35

export type SpeechVerdict = {
  speech: boolean
  /** Why, in words a log reader can act on. */
  reason: "speech" | "no-speech" | "unreadable" | "too-short" | "loud-throughout"
  speechMs?: number
  floorDb?: number
}

export function detectSpeech(audio: Uint8Array): SpeechVerdict {
  const format = wavFormat(audio)
  if (!format) return { speech: true, reason: "unreadable" }
  const db = frameLoudness(audio.subarray(format.dataOffset, format.dataOffset + format.dataBytes))
  // Shorter than one syllable run: nothing to measure a floor against. The TUI and the composer
  // already refuse takes this short; anything else reaching here is sent.
  if (db.length < MIN_RUN_FRAMES * 2) return { speech: true, reason: "too-short" }
  const frames = db.length

  const floorDb = percentile(db, 0.1)
  if (floorDb > AMBIGUOUS_FLOOR_DB) return { speech: true, reason: "loud-throughout", floorDb }

  const threshold = Math.max(floorDb + ABOVE_FLOOR_DB, ABSOLUTE_MIN_DB)
  let speechFrames = 0
  let run = 0
  for (let f = 0; f <= frames; f++) {
    if (f < frames && db[f]! > threshold) {
      run++
      continue
    }
    if (run >= MIN_RUN_FRAMES) speechFrames += run
    run = 0
  }
  const speechMs = speechFrames * 30
  return speechMs >= MIN_SPEECH_MS
    ? { speech: true, reason: "speech", speechMs, floorDb }
    : { speech: false, reason: "no-speech", speechMs, floorDb }
}

/** Loudness of each 30 ms frame of 16 kHz mono PCM16, in dBFS (-120 for digital silence). */
export function frameLoudness(pcm: Uint8Array): Float64Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const frames = Math.floor(pcm.byteLength / 2 / FRAME_SAMPLES)
  const db = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const v = view.getInt16((f * FRAME_SAMPLES + i) * 2, true) / 0x8000
      sum += v * v
    }
    const rms = Math.sqrt(sum / FRAME_SAMPLES)
    db[f] = rms > 0 ? 20 * Math.log10(rms) : -120
  }
  return db
}

function percentile(values: Float64Array, p: number) {
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}
