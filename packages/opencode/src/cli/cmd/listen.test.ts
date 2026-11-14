import { describe, test, expect } from "bun:test"
import { renderMeter } from "./listen"
import { formatDictationClock, dictationBar } from "./tui/component/prompt/dictate"
import { resolveDevice, levelToUnit, silenceWarning } from "../lib/mic"

/**
 * Guards for `iris listen`.
 *
 * The meter exists because a recorder with no feedback fails SILENTLY — a muted input or the
 * wrong device selected looks exactly like a working one until the transcript comes back
 * empty, and by then the thing you were saying is gone. Every test here is about that class
 * of failure: something that produces a plausible result while being wrong.
 */

const MACBOOK = [
  { index: 0, name: "BlackHole 16ch" },
  { index: 1, name: "MacBook Pro Microphone" },
]

describe("device selection", () => {
  test("prefers the microphone over a loopback device that enumerates first", () => {
    // This is the whole reason selection is not `devices[0]`. BlackHole is index 0 on this
    // machine, carries system audio rather than a voice, and would record perfect silence
    // while every other part of the pipeline reported success.
    expect(resolveDevice(MACBOOK)?.name).toBe("MacBook Pro Microphone")
  })

  test("matches a requested device by name, not by position", () => {
    // Indices shift when any device is added or removed, so a remembered index silently
    // points at a different input later. Names are what a person actually knows.
    expect(resolveDevice(MACBOOK, "blackhole")?.index).toBe(0)
    expect(resolveDevice(MACBOOK, "macbook")?.index).toBe(1)
  })

  test("returns null for a device that is not there, rather than falling back", () => {
    // Falling back to "some other input" when the named one is missing is how you record the
    // wrong thing and never find out. An explicit request that cannot be honoured is an error.
    expect(resolveDevice(MACBOOK, "scarlett")).toBeNull()
  })

  test("still picks something sensible when only virtual devices exist", () => {
    const virtualOnly = [{ index: 0, name: "BlackHole 16ch" }]
    expect(resolveDevice(virtualOnly)?.index).toBe(0)
  })

  test("survives an empty device list", () => {
    expect(resolveDevice([])).toBeNull()
  })
})

describe("level mapping", () => {
  test("digital silence reads zero", () => {
    expect(levelToUnit(-Infinity)).toBe(0)
    expect(levelToUnit(-120)).toBe(0)
  })

  test("a quiet room stays near the floor so movement means something", () => {
    // Measured on the internal mic: room tone sits at -60..-55 dBFS. If that rendered as a
    // third of the bar, a muted input and a quiet room would look the same.
    expect(levelToUnit(-60)).toBeCloseTo(0, 5)
    expect(levelToUnit(-55)).toBeLessThan(0.15)
  })

  test("ordinary speech lands in the readable middle of the scale", () => {
    // Also measured: speech peaks between -45 and -35. A scale where normal talking pins the
    // bar is as useless as one where it never moves.
    expect(levelToUnit(-40)).toBeGreaterThan(0.3)
    expect(levelToUnit(-40)).toBeLessThan(0.6)
  })

  test("clamps rather than overflowing on a hot signal", () => {
    expect(levelToUnit(0)).toBe(1)
    expect(levelToUnit(12)).toBe(1)
  })

  test("is monotonic — louder never draws shorter", () => {
    const points = [-70, -60, -50, -40, -30, -20, -10, 0]
    const units = points.map(levelToUnit)
    for (let i = 1; i < units.length; i++) expect(units[i]).toBeGreaterThanOrEqual(units[i - 1])
  })
})

describe("meter rendering", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

  test("draws a fixed-width bar so the line never reflows mid-recording", () => {
    const widths = [0, 0.25, 0.5, 1].map((u) => strip(renderMeter(u, u, 0)).length)
    expect(new Set(widths).size).toBe(1)
  })

  test("shows elapsed time as mm:ss and rolls past a minute", () => {
    expect(strip(renderMeter(0, 0, 5_000))).toContain("00:05")
    expect(strip(renderMeter(0, 0, 65_000))).toContain("01:05")
    expect(strip(renderMeter(0, 0, 605_000))).toContain("10:05")
  })

  test("fills proportionally", () => {
    const full = strip(renderMeter(1, 1, 0))
    const empty = strip(renderMeter(0, 0, 0))
    expect((full.match(/█/g) ?? []).length).toBeGreaterThan((empty.match(/█/g) ?? []).length)
    expect(full).toContain("100%")
    expect(empty).toContain("0%")
  })

  test("holds a peak tick above the current level", () => {
    // The tick is what makes a brief clipping spike visible at 12fps; without it a peak that
    // lands between two frames is never drawn at all.
    expect(strip(renderMeter(0.1, 0.8, 0))).toContain("│")
  })
})

describe("the silence guard", () => {
  test("warns when nothing ever crossed the noise floor", () => {
    const w = silenceWarning(0, "BlackHole 16ch")
    expect(w).toBeTruthy()
    expect(w).toContain("BlackHole 16ch")
  })

  test("does NOT warn about a quiet room on a live microphone", () => {
    // Crying wolf here would be worse than staying quiet: a warning on every soft-spoken
    // recording is a warning people stop reading, and then the real dead-input case sails past.
    expect(silenceWarning(0.09, "MacBook Pro Microphone")).toBeNull()
  })

  test("does not warn about normal speech", () => {
    expect(silenceWarning(0.45, "MacBook Pro Microphone")).toBeNull()
  })
})

describe("the dictation indicator (TUI)", () => {
  test("clock is mm:ss and rolls past a minute", () => {
    expect(formatDictationClock(0)).toBe("00:00")
    expect(formatDictationClock(7_000)).toBe("00:07")
    expect(formatDictationClock(61_000)).toBe("01:01")
    expect(formatDictationClock(3_599_000)).toBe("59:59")
  })

  test("bar is fixed width so the footer never reflows mid-recording", () => {
    // It shares a row with the agent and model names. A meter that grows pushes those off a
    // narrow terminal, which costs more than the meter gives.
    for (const u of [0, 0.3, 0.77, 1]) expect(dictationBar(u).length).toBe(12)
  })

  test("bar fills monotonically and clamps outside 0..1", () => {
    const filled = (s: string) => (s.match(/█/g) ?? []).length
    expect(filled(dictationBar(0))).toBe(0)
    expect(filled(dictationBar(1))).toBe(12)
    expect(filled(dictationBar(0.5))).toBeGreaterThan(filled(dictationBar(0.25)))
    expect(filled(dictationBar(-1))).toBe(0)
    expect(filled(dictationBar(5))).toBe(12)
  })
})
