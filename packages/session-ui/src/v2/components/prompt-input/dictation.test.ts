import { describe, expect, test } from "bun:test"
import { captureIsLive } from "./dictation-probe"

/**
 * #186525 — a client hit "Recording needs ffmpeg" on a Mac whose webview could record.
 *
 * The probe judged the first 400ms of a PUSH-TO-TALK recording against a speech threshold.
 * Nobody is speaking 400ms after pressing the button, so a working microphone measured as
 * denied and the session fell back to the sidecar, which needs ffmpeg.
 */
describe("captureIsLive — a live mic is not the same question as a loud one", () => {
  test("room tone counts as live, though it is far below speech", () => {
    expect(captureIsLive(0.0004, 6)).toBe(true) // quiet room, nobody talking yet
    expect(captureIsLive(0.2, 6)).toBe(true) // speaking
  })

  test("digital silence is the denied case — WKWebView measured exactly 0.0000", () => {
    expect(captureIsLive(0, 6)).toBe(false)
  })

  test("no buffers at all is not live, whatever the peak says", () => {
    expect(captureIsLive(0.5, 0)).toBe(false)
  })
})
