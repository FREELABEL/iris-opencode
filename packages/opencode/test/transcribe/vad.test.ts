import { describe, expect, test } from "bun:test"
import { wrapPcmAsWav } from "../../src/transcribe/capture"
import { detectSpeech } from "../../src/transcribe/vad"

// Deterministic noise, so a threshold change shows up as a test change, not a flake.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
}
const dbToAmp = (db: number) => Math.pow(10, db / 20)

/** A take built from layers, each a function of (sample index, seconds) → -1..1. */
function take(seconds: number, ...layers: ((i: number, t: number) => number)[]) {
  const pcm = new Int16Array(Math.round(seconds * 16000))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / 16000
    const v = layers.reduce((s, l) => s + l(i, t), 0)
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 0x7fff)))
  }
  return wrapPcmAsWav(new Uint8Array(pcm.buffer))
}
// Uniform noise has RMS amplitude/√3; scale so the layer's RMS is the stated dB.
const noise = (db: number, seed = 1) => {
  const r = rng(seed)
  const a = dbToAmp(db) * Math.sqrt(3)
  return () => (r() * 2 - 1) * a
}
const hum = (db: number) => (_: number, t: number) => Math.sin(2 * Math.PI * 60 * t) * dbToAmp(db) * Math.SQRT2
/** Voiced-speech stand-in: a 180 Hz tone in syllable bursts (on `on` s, off `off` s) inside [from, to). */
const syllables = (db: number, from: number, to: number, on = 0.18, off = 0.08) => (_: number, t: number) => {
  if (t < from || t >= to) return 0
  if ((t - from) % (on + off) >= on) return 0
  return Math.sin(2 * Math.PI * 180 * t) * dbToAmp(db) * Math.SQRT2
}
/** A single 20 ms click at `at` seconds. */
const click = (db: number, at: number) => (_: number, t: number) => (t >= at && t < at + 0.02 ? dbToAmp(db) : 0)

describe("detectSpeech — what must NOT be sent", () => {
  test("a minute of quiet room noise (the idle background take)", () => {
    const v = detectSpeech(take(60, noise(-55)))
    expect(v).toMatchObject({ speech: false, reason: "no-speech" })
  })

  test("an air conditioner: noise plus mains hum", () => {
    expect(detectSpeech(take(20, noise(-48), hum(-44))).speech).toBe(false)
  })

  test("a click or a door in an otherwise empty room", () => {
    expect(detectSpeech(take(10, noise(-55), click(-10, 4))).speech).toBe(false)
  })

  test("digital silence", () => {
    expect(detectSpeech(take(5)).speech).toBe(false)
  })
})

describe("detectSpeech — what must be sent", () => {
  test("a short phrase in a quiet room", () => {
    expect(detectSpeech(take(4, noise(-55), syllables(-22, 1.2, 2.2))).speech).toBe(true)
  })

  test("a single short word (~300 ms) is enough", () => {
    expect(detectSpeech(take(3, noise(-55), syllables(-22, 1, 1.3, 0.3, 0.1))).speech).toBe(true)
  })

  test("speech over the air conditioner", () => {
    expect(detectSpeech(take(10, noise(-48), hum(-44), syllables(-20, 3, 6))).speech).toBe(true)
  })

  test("quiet speech, well below a normal level, is still speech", () => {
    expect(detectSpeech(take(6, noise(-62), syllables(-40, 2, 4))).speech).toBe(true)
  })

  test("speech wall to wall, no pause to measure a floor in", () => {
    expect(detectSpeech(take(8, noise(-55), syllables(-20, 0, 8))).speech).toBe(true)
  })

  test("one phrase in a long background take is not lost", () => {
    expect(detectSpeech(take(120, noise(-55), syllables(-22, 70, 71))).speech).toBe(true)
  })
})

describe("detectSpeech — fails open", () => {
  test("audio it cannot read is sent (webm from the webview, other formats)", () => {
    expect(detectSpeech(new Uint8Array(5000).fill(7))).toMatchObject({ speech: true, reason: "unreadable" })
  })

  test("a take too short to measure is sent", () => {
    expect(detectSpeech(take(0.1, noise(-55)))).toMatchObject({ speech: true, reason: "too-short" })
  })

  test("a take loud throughout cannot be told from continuous speech, so it is sent", () => {
    expect(detectSpeech(take(5, noise(-25)))).toMatchObject({ speech: true, reason: "loud-throughout" })
  })
})
