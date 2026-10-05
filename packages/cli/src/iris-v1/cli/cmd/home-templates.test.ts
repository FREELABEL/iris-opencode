import { describe, expect, test } from "bun:test"
import { MIN_STEP_MS, TEMPLATES, findTemplate, type TemplateCtx } from "./home-templates"
import type { Verbs } from "./home-core"

/**
 * #185775 — prebuilt shows for `iris home run`. These run in real homes, around people who
 * did not ask for a light show, so the safety properties are tested for EVERY template rather
 * than trusted per-template: no state change faster than MIN_STEP_MS, and no light switched
 * off (a template dims instead). Plus: each one finishes, and none assumes a room name.
 */

function harness(rooms: string[], opts: { duration?: number } = {}) {
  let clock = 0
  let seed = 42
  const sends: { room: string; verbs: Verbs; at: number }[] = []
  const sleeps: number[] = []
  const ctx: TemplateCtx = {
    rooms,
    duration: opts.duration,
    now: () => clock,
    // deterministic LCG so a failure reproduces
    random: () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32),
    send: async (room, verbs) => { sends.push({ room, verbs, at: clock }) },
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
  }
  return { ctx, sends, sleeps, elapsed: () => clock }
}

const allowedRooms = (rooms: string[]) => new Set([...rooms, "all"])

describe.each(TEMPLATES.map((t) => [t.name, t] as const))("template %s", (_name, template) => {
  test("finishes, sends something, and stays near its advertised length", async () => {
    const h = harness(["master", "living", "trey's"])
    await template.play(h.ctx)
    expect(h.sends.length).toBeGreaterThan(0)
    const seconds = h.elapsed() / 1000
    expect(seconds).toBeGreaterThan(template.seconds * 0.5)
    expect(seconds).toBeLessThan(template.seconds * 1.6)
  })

  test(`never waits less than ${MIN_STEP_MS}ms between changes`, async () => {
    const h = harness(["a", "b", "c"])
    await template.play(h.ctx)
    expect(Math.min(...h.sleeps)).toBeGreaterThanOrEqual(MIN_STEP_MS)
  })

  test("never switches a light off — dark moments dim instead", async () => {
    const h = harness(["a", "b", "c"])
    await template.play(h.ctx)
    expect(h.sends.filter((s) => s.verbs.on === false)).toEqual([])
  })

  test("only addresses rooms from the registry (or all), and works in a one-room home", async () => {
    for (const rooms of [["kitchen"], ["den", "loft", "garage", "porch", "attic"]]) {
      const h = harness(rooms)
      await template.play(h.ctx)
      const allowed = allowedRooms(rooms)
      expect(h.sends.every((s) => allowed.has(s.room))).toBe(true)
    }
  })

  test("brightness stays in the Hue range", async () => {
    const h = harness(["a", "b"])
    await template.play(h.ctx)
    for (const s of h.sends) if (s.verbs.bri !== undefined) {
      expect(s.verbs.bri).toBeGreaterThanOrEqual(1)
      expect(s.verbs.bri).toBeLessThanOrEqual(254)
    }
  })
})

describe("--duration", () => {
  test("stretchable shows honour it", async () => {
    for (const t of TEMPLATES.filter((t) => t.stretch)) {
      const h = harness(["a", "b"], { duration: 90 })
      await t.play(h.ctx)
      expect(h.elapsed() / 1000).toBeGreaterThanOrEqual(89)
      expect(h.elapsed() / 1000).toBeLessThan(96)
    }
  })
})

describe("findTemplate", () => {
  test("case-insensitive; unknown is undefined", () => {
    expect(findTemplate("Barbie")?.name).toBe("barbie")
    expect(findTemplate("nope")).toBeUndefined()
  })

  test("names are unique and do not shadow the built-in sequences", () => {
    const names = TEMPLATES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const seq of ["pulse", "strobe", "rainbow"]) expect(names).not.toContain(seq)
  })
})
