import { describe, expect, test } from "bun:test"
import { capProgress, formatClock, levelFromRms, LEVEL_HISTORY, pushLevel, waveformBars } from "./dictate-visual"

describe("levelFromRms — loudness on a scale a person hears", () => {
  test("silence and the noise floor sit at zero", () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(0.0005)).toBe(0) // about -66 dBFS
  })
  test("normal speech lands mid-scale, not pinned to either end", () => {
    const v = levelFromRms(0.05) // about -26 dBFS
    expect(v).toBeGreaterThan(0.4)
    expect(v).toBeLessThan(0.9)
  })
  test("loud input saturates at one and never past it", () => {
    expect(levelFromRms(0.5)).toBe(1)
    expect(levelFromRms(4)).toBe(1)
  })
  test("is monotonic", () => {
    let last = -1
    for (const r of [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3]) {
      const v = levelFromRms(r)
      expect(v).toBeGreaterThanOrEqual(last)
      last = v
    }
  })
  test("garbage in is silence out", () => {
    expect(levelFromRms(Number.NaN)).toBe(0)
    expect(levelFromRms(-1)).toBe(0)
  })
})

describe("pushLevel — a fixed-length history, newest last", () => {
  test("keeps exactly LEVEL_HISTORY entries so the waveform never changes width", () => {
    let h = new Array(LEVEL_HISTORY).fill(0)
    for (let i = 0; i < LEVEL_HISTORY * 2; i++) h = pushLevel(h, i / (LEVEL_HISTORY * 2))
    expect(h.length).toBe(LEVEL_HISTORY)
    expect(h[h.length - 1]).toBeCloseTo((LEVEL_HISTORY * 2 - 1) / (LEVEL_HISTORY * 2))
  })
  test("does not mutate its input", () => {
    const h = [0, 0, 0]
    pushLevel(h, 1)
    expect(h).toEqual([0, 0, 0])
  })
})

describe("waveformBars — geometry for the SVG", () => {
  test("one bar per history entry, all inside the viewbox, centred vertically", () => {
    const bars = waveformBars([0, 0.5, 1], { width: 30, height: 20, gap: 2 })
    expect(bars.length).toBe(3)
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.w).toBeLessThanOrEqual(30 + 1e-9)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.h).toBeLessThanOrEqual(20 + 1e-9)
      expect(b.y + b.h / 2).toBeCloseTo(10)
    }
  })
  test("silent bars keep a visible minimum so the strip reads as listening, not broken", () => {
    const [bar] = waveformBars([0], { width: 10, height: 20, gap: 0 })
    expect(bar!.h).toBeGreaterThan(0)
  })
  test("louder is taller", () => {
    const [a, b] = waveformBars([0.2, 0.8], { width: 20, height: 20, gap: 0 })
    expect(b!.h).toBeGreaterThan(a!.h)
  })
})

describe("formatClock and capProgress", () => {
  test("m:ss with tabular-friendly zero padding", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(9)).toBe("0:09")
    expect(formatClock(65)).toBe("1:05")
    expect(formatClock(300)).toBe("5:00")
  })
  test("progress toward the five-minute cap, clamped", () => {
    expect(capProgress(0, 300)).toBe(0)
    expect(capProgress(150, 300)).toBeCloseTo(0.5)
    expect(capProgress(900, 300)).toBe(1)
    expect(capProgress(10, 0)).toBe(0)
  })
})
