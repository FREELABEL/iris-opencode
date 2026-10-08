import { expect, test } from "bun:test"
import { explainNoAudio } from "../../src/cli/lib/transcription"

// #188550 — real ffmpeg stderr, captured 2026-10-08.
const SILENT = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1206, 834 kb/s, SAR 1:1 DAR 320:201, 60 fps, 60 tbr, 1536k tbn (default)\nError opening output file /tmp/x.wav.\nError opening output files: Invalid argument\n"
const WITH_AUDIO = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080, 1329 kb/s, SAR 1:1 DAR 16:9, 60 fps, 60 tbr, 1536k tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)\n"

test("a video with no audio stream says so, instead of ffmpeg's 'Invalid argument'", () => {
  const m = explainNoAudio(SILENT)
  expect(m).toMatch(/no audio track/)
  expect(m).toMatch(/iris look --image/)
})

test("a file that HAS audio is not called silent — the real error must still surface", () => {
  expect(explainNoAudio(WITH_AUDIO + "\nError opening output file x.wav.")).toBeNull()
})

test("no stream listing at all (ffmpeg could not even read the file) is not a verdict", () => {
  expect(explainNoAudio("dyld: Library not loaded: libx265.215.dylib")).toBeNull()
  expect(explainNoAudio("")).toBeNull()
})
