import { describe, expect, test } from "bun:test"
import { wrapPcmAsWav } from "../../src/transcribe/capture"
import { splitWav } from "../../src/transcribe/segments"

// n seconds of 16 kHz mono PCM16 where every sample holds its own second index, so a segment's
// contents show which part of the recording it came from.
const seconds = (n: number) => {
  const pcm = new Int16Array(n * 16000)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.floor(i / 16000)
  return wrapPcmAsWav(new Uint8Array(pcm.buffer))
}
const samples = (wav: Uint8Array) => new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength))

describe("splitWav", () => {
  test("a recording within the segment length is passed through whole", () => {
    const wav = seconds(10)
    expect(splitWav(wav, 10)).toEqual([wav])
  })

  test("a longer recording becomes consecutive, complete, valid WAV segments", () => {
    const parts = splitWav(seconds(25), 10)
    expect(parts.map((p) => samples(p).length)).toEqual([160000, 160000, 80000])
    // Each segment starts where the previous one ended: second 0, 10, 20.
    expect(parts.map((p) => samples(p)[0])).toEqual([0, 10, 20])
    expect(parts.map((p) => samples(p).at(-1))).toEqual([9, 19, 24])
    for (const p of parts) expect(String.fromCharCode(...p.subarray(0, 4))).toBe("RIFF")
  })

  test("audio that is not 16 kHz mono PCM16 WAV is never split", () => {
    const notWav = new Uint8Array(2_000_000).fill(1)
    expect(splitWav(notWav, 1)).toEqual([notWav])
    const stereo = seconds(25)
    new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(splitWav(stereo, 10)).toEqual([stereo])
  })

  // Speech-like audio: a 180 Hz tone, loud, with a 300 ms pause starting at `pauseAt` seconds.
  const speechWithPause = (n: number, pauseAt: number) => {
    const pcm = new Int16Array(n * 16000)
    for (let i = 0; i < pcm.length; i++) {
      const t = i / 16000
      pcm[i] = t >= pauseAt && t < pauseAt + 0.3 ? 0 : Math.round(Math.sin(2 * Math.PI * 180 * t) * 8000)
    }
    return wrapPcmAsWav(new Uint8Array(pcm.buffer))
  }

  test("a cut moves back into the pause before the boundary, never past it", () => {
    // 25 s at 10 s segments; the search window is the last 2 s of each. Pause at 8.5–8.8 s.
    const parts = splitWav(speechWithPause(25, 8.5), 10)
    const first = samples(parts[0]!).length / 16000
    expect(first).toBeGreaterThanOrEqual(8.5)
    expect(first).toBeLessThan(8.8)
    // Nothing lost, nothing duplicated, and no part over the limit.
    expect(parts.reduce((n, p) => n + samples(p).length, 0)).toBe(25 * 16000)
    for (const p of parts) expect(samples(p).length).toBeLessThanOrEqual(10 * 16000)
  })

  test("with no pause in the window, the cut stays at the boundary", () => {
    // Pause at 3 s is outside the last-2-s search window of the first segment.
    const parts = splitWav(speechWithPause(25, 3), 10)
    expect(samples(parts[0]!).length).toBe(160000)
  })
})

