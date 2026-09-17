import { describe, expect, test } from "bun:test"
import {
  COLORS,
  matchDevices,
  normalizeScene,
  parseSetArgs,
  resolveColor,
  stepVerbs,
  summarizeHueResponse,
  toWizParams,
  type HomeDevice,
} from "./home-core"

/**
 * #185775 — `iris home`. The reference prototype listed five commands as tested; two of them
 * did nothing. `iris home lights purple` treated "lights" as a room, matched zero devices,
 * printed nothing and exited 0. `iris home run scene.json` looked the filename up as a named
 * sequence. And a light that was unplugged reported ✅ because the Hue bridge ACKs writes to
 * unreachable lights. These tests lock those three, plus the parsing everything rides on.
 */

const devices: HomeDevice[] = [
  { id: "1", name: "Master Bedroom", room: "master", transport: "hue", ip: "10.0.0.2" },
  { id: "2", name: "Living Room", room: "living", transport: "hue", ip: "10.0.0.2" },
  { id: "3", name: "Living Room - Dome", room: "living", transport: "hue", ip: "10.0.0.2" },
  { id: "10.0.0.9", name: "Desk Lamp", room: "office", transport: "wiz", ip: "10.0.0.9" },
]

describe("parseSetArgs", () => {
  test("'lights' is a noise word, not a room that matches nothing", () => {
    const r = parseSetArgs(["lights", "purple"])
    expect(r.room).toBeNull()
    expect(r.verbs).toEqual({ ...COLORS.purple, on: true })
    expect(matchDevices(devices, r.room)).toHaveLength(4)
  })

  test("room + noise + color", () => {
    const r = parseSetArgs(["living", "lights", "blue"])
    expect(r.room).toBe("living")
    expect(r.verbs?.hue).toBe(COLORS.blue.hue)
  })

  test("off wins over a color's implied on, regardless of order", () => {
    expect(parseSetArgs(["master", "off"]).verbs).toEqual({ on: false })
    expect(parseSetArgs(["off", "red"]).verbs?.on).toBe(false)
  })

  test("brightness as raw value or percent, clamped", () => {
    expect(parseSetArgs(["bri", "120"]).verbs?.bri).toBe(120)
    expect(parseSetArgs(["bri", "50%"]).verbs?.bri).toBe(127)
    expect(parseSetArgs(["bri", "999"]).verbs?.bri).toBe(254)
  })

  test("nothing actionable returns null verbs so the caller refuses instead of sending {}", () => {
    expect(parseSetArgs(["living"]).verbs).toBeNull()
    expect(parseSetArgs(["lights"]).verbs).toBeNull()
  })

  test("multi-word rooms survive", () => {
    expect(parseSetArgs(["living", "room", "warm"]).room).toBe("living room")
  })
})

describe("resolveColor", () => {
  test("hex requires # so a six-letter room name is not a color", () => {
    expect(resolveColor("bedroo")).toBeNull()
    expect(resolveColor("facade")).toBeNull()
    expect(resolveColor("#ff0000")).toEqual({ hue: 0, sat: 254, bri: 254 })
  })

  test("names are case-insensitive and returned as copies", () => {
    const c = resolveColor("PURPLE")!
    c.hue = 1
    expect(COLORS.purple.hue).toBe(46920)
  })
})

describe("matchDevices", () => {
  test("room field exact match, or name substring", () => {
    expect(matchDevices(devices, "living").map((d) => d.id)).toEqual(["2", "3"])
    expect(matchDevices(devices, "dome").map((d) => d.id)).toEqual(["3"])
  })

  test("an exact device name targets only that device, not names that contain it", () => {
    expect(matchDevices(devices, "Living Room").map((d) => d.id)).toEqual(["2"])
    expect(matchDevices(devices, "living room").map((d) => d.id)).toEqual(["2"])
  })

  test("an unknown room matches nothing — the command must report it, not no-op", () => {
    expect(matchDevices(devices, "garage")).toEqual([])
  })

  test("'all' and null are every device", () => {
    expect(matchDevices(devices, "all")).toHaveLength(4)
    expect(matchDevices(devices, null)).toHaveLength(4)
  })
})

describe("normalizeScene", () => {
  test("prototype shape: array with a {repeat} marker", () => {
    const s = normalizeScene([{ color: "blue", wait: 100 }, { off: true, wait: 100 }, { repeat: 10 }])
    expect(s.repeat).toBe(10)
    expect(s.steps).toHaveLength(2)
  })

  test("object shape", () => {
    expect(normalizeScene({ steps: [{ color: "red" }], repeat: 3 }).repeat).toBe(3)
  })

  test("a typo'd color fails before any light moves", () => {
    expect(() => normalizeScene([{ color: "red" }, { color: "purpel" }])).toThrow("step 2")
  })

  test("empty and malformed scenes are rejected", () => {
    expect(() => normalizeScene([])).toThrow()
    expect(() => normalizeScene([{ repeat: 2 }])).toThrow()
    expect(() => normalizeScene({ nope: 1 })).toThrow()
  })

  test("repeat is bounded", () => {
    expect(normalizeScene({ steps: [{ color: "red" }], repeat: 1e9 }).repeat).toBe(1000)
  })
})

describe("stepVerbs", () => {
  test("off step, color step, bri override", () => {
    expect(stepVerbs({ off: true, color: "red" })).toEqual({ on: false })
    expect(stepVerbs({ color: "purple", bri: 60 })).toEqual({ on: true, ...COLORS.purple, bri: 60 })
  })
})

describe("toWizParams", () => {
  test("off, rgb, and colour temperature", () => {
    expect(toWizParams({ on: false, hue: 0 })).toEqual({ state: false })
    expect(toWizParams({ on: true, hue: 0, sat: 254 })).toMatchObject({ state: true, r: 255, g: 0, b: 0 })
    expect(toWizParams({ on: true, ct: 370 })).toEqual({ state: true, temp: 2703 })
  })
})

describe("summarizeHueResponse", () => {
  const accepted = [{ success: { "/lights/2/state/on": true } }]

  test("bridge ACK for an unreachable light is NOT success", () => {
    const r = summarizeHueResponse(accepted, false)
    expect(r.ok).toBe(false)
    expect(r.note).toContain("unreachable")
  })

  test("ACK for a reachable light is success; unknown reachability is not held against it", () => {
    expect(summarizeHueResponse(accepted, true).ok).toBe(true)
    expect(summarizeHueResponse(accepted, undefined).ok).toBe(true)
  })

  test("bridge errors and empty bodies fail with the bridge's reason", () => {
    expect(summarizeHueResponse([{ error: { description: "unauthorized user" } }], true)).toEqual({ ok: false, note: "unauthorized user" })
    expect(summarizeHueResponse({}, true).ok).toBe(false)
  })
})
