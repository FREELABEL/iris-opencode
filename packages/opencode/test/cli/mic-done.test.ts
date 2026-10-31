import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnCapture } from "../../src/cli/lib/mic"

// `iris listen` waited on stop() instead of on the take, so ffmpeg got its `q` the moment
// recording began. These run real ffmpeg on a test tone, standing in for the microphone.
// -re: read in real time, as a microphone delivers it. Without it lavfi renders 1 s instantly.
const tone = ["-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
const device = { index: 0, name: "test tone" }
// 1 s of 16 kHz mono PCM16 is 32000 bytes, plus the header.
const ONE_SECOND = 32000

describe("Recording.done", () => {
  test("waits for a --seconds take to finish by itself, and the take is all there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iris-done-"))
    try {
      const rec = spawnCapture(tone, join(dir, "a.wav"), device, { seconds: 1 })
      const started = Date.now()
      await rec.done()
      // -re still sends the first 0.5 s as a burst (ffmpeg -readrate_initial_burst), so a 1 s take
      // ends after ~0.5 s here. The bug ended it in ~50 ms; 400 tells the two apart.
      expect(Date.now() - started).toBeGreaterThanOrEqual(400)
      const { ok } = await rec.stop() // after done(): a no-op that still reports
      expect(ok).toBe(true)
      expect(statSync(rec.path).size).toBeGreaterThanOrEqual(ONE_SECOND)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test("stop() called at once — what listen used to do — loses the take", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iris-done-"))
    try {
      const rec = spawnCapture(tone, join(dir, "b.wav"), device, { seconds: 1 })
      await rec.stop()
      let size = 0
      try {
        size = statSync(rec.path).size
      } catch {
        /* never written */
      }
      expect(size).toBeLessThan(ONE_SECOND / 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
