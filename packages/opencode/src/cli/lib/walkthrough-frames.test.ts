import { describe, expect, test, mock } from "bun:test"
import { spawnSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// walkthrough.ts talks to the API; nothing here does. Stub the client so the module loads alone.
mock.module("../cmd/iris-api", () => ({ irisFetch: async () => new Response("{}"), IRIS_API: "", FL_API: "" }))
const { extractKeyframes, evenlyPick, isVideo } = await import("./walkthrough")

/**
 * `iris playbook draft` drafted from narration only, so every step done on screen without being
 * said was lost. These pin the frame half: scene changes are found, a screen that barely changes
 * still gets frames, and extraction failing never costs the draft.
 */

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0

function video(dir: string, name: string, filter: string, inputs: string[]): string {
  const out = join(dir, name)
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", out])
  if (r.status !== 0) throw new Error(String(r.stderr))
  return out
}

describe("evenlyPick", () => {
  test("keeps first and last, spreads the rest", () => {
    expect(evenlyPick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9])
  })
  test("fewer candidates than asked returns them all", () => {
    expect(evenlyPick([1, 2], 10)).toEqual([1, 2])
  })
})

describe("isVideo", () => {
  test("video containers are video; audio is not", () => {
    expect(isVideo("walk.MOV")).toBe(true)
    expect(isVideo("walk.m4a")).toBe(false)
  })
})

describe.skipIf(!ffmpeg)("extractKeyframes", () => {
  test("finds one frame per screen change, with timestamps and unique refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-test-"))
    try {
      const src = video(dir, "scenes.mp4", "[0][1][2]concat=n=3:v=1:a=0[v]", [
        "-f", "lavfi", "-i", "color=c=red:s=320x240:d=3",
        "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=3",
        "-f", "lavfi", "-i", "color=c=green:s=320x240:d=3",
      ])
      const { frames } = extractKeyframes(src, 10)
      const times = frames.map((f) => Math.round(f.t))
      expect(times).toEqual([0, 3, 6])
      expect(new Set(frames.map((f) => f.ref)).size).toBe(frames.length)
      expect(frames[0].jpeg.subarray(0, 2).toString("hex")).toBe("ffd8") // a real JPEG
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a screen that never changes is one frame, not the same frame five times", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-test-"))
    try {
      const src = video(dir, "static.mp4", "[0]null[v]", ["-f", "lavfi", "-i", "color=c=gray:s=320x240:d=10"])
      const { frames } = extractKeyframes(src, 5)
      expect(frames.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("text changing on a white screen registers as screen changes", () => {
    // The real case: a screen recording, where a new page is a small change in pixels. At a
    // camera-style threshold none of these cuts registered and the draft got evenly spaced
    // frames that missed them.
    const dir = mkdtempSync(join(tmpdir(), "kf-test-"))
    try {
      const box = (x: number) => `color=c=white:s=320x240:d=3,drawbox=x=${x}:y=20:w=60:h=14:color=black:t=fill`
      const src = video(dir, "text.mp4", "[0][1][2]concat=n=3:v=1:a=0[v]", [
        "-f", "lavfi", "-i", box(20), "-f", "lavfi", "-i", box(120), "-f", "lavfi", "-i", box(220),
      ])
      const { frames } = extractKeyframes(src, 10)
      expect(frames.map((f) => Math.round(f.t))).toEqual([0, 3, 6])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("never throws — an unreadable file is a note, not a lost draft", () => {
    const r = extractKeyframes("/nonexistent/walk.mp4", 5)
    expect(r.frames).toEqual([])
    expect(r.note).toBeTruthy()
  })

  test("max 0 means narration only and does no work", () => {
    expect(extractKeyframes("/nonexistent/walk.mp4", 0)).toEqual({ frames: [] })
  })
})
