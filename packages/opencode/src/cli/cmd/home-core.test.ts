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
  captureStep,
  compileShorthand,
  parseDuration,
  toTransitionTime,
  unknownWordHelp,
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

/**
 * Epic #186312 · ADR-04, step 1 — the colour vocabulary, and an error that names the word
 * it could not understand.
 *
 * WHY THIS IS THE FIRST STEP. Asked for teal, `iris home all teal` took "teal" as part of a
 * ROOM NAME — everything unrecognised falls through to the room, by design — produced no
 * verbs, and refused with "Nothing to do with 'all teal'". The user hears "the lights are
 * broken"; the truth is "that is not a word I know". Same family as the shipped bug where
 * `iris home lights purple` matched no devices and exited 0 silently: an unknown word must
 * never be laundered into a different kind of failure.
 */
describe("ADR-04 · colour vocabulary", () => {
  test("teal is a colour, not a room name", () => {
    expect(COLORS.teal).toBeDefined()
    const { room, verbs } = parseSetArgs(["all", "teal"])
    expect(room).toBe("all")
    expect(verbs?.hue).toBeDefined()
    expect(verbs?.on).toBe(true)
  })

  test("teal sits between green and cyan, and is none of them", () => {
    // Derived from #008080, the actual definition of teal: hue 0.5 of the wheel.
    // If it collided with cyan there would be no point adding the word.
    const teal = COLORS.teal!.hue!
    expect(teal).toBeGreaterThan(COLORS.green!.hue!)
    expect(teal).not.toBe(COLORS.cyan!.hue!)
    expect(teal).toBeLessThanOrEqual(COLORS.cyan!.hue!)
  })

  test("the colours people actually ask for by name all resolve", () => {
    for (const name of ["teal", "turquoise", "lime", "magenta", "gold", "lavender"]) {
      expect(resolveColor(name), `${name} should be a known colour`).not.toBeNull()
    }
  })
})

describe("ADR-04 · an error that names the offending word", () => {
  const rooms = ["master", "living", "treyton's room"]

  test("it names the word it did not understand", () => {
    const msg = unknownWordHelp(["all", "chartreuse"], rooms)
    expect(msg).toContain("chartreuse")
  })

  test("it offers the colour list, because that is usually what was meant", () => {
    const msg = unknownWordHelp(["all", "chartreuse"], rooms)
    expect(msg.toLowerCase()).toContain("blue")
  })

  test("it offers the room list too, because the word may have been a room", () => {
    const msg = unknownWordHelp(["kitchen", "blue"], rooms)
    expect(msg).toContain("kitchen")
    expect(msg).toContain("living")
  })

  test("it does not accuse a word that IS understood", () => {
    // "all" and "blue" are both meaningful; only a genuinely unknown word may be named.
    const msg = unknownWordHelp(["all", "blue", "wibble"], rooms)
    expect(msg).toContain("wibble")
    expect(msg).not.toContain("'all'")
    expect(msg).not.toContain("'blue'")
  })

  test("a known room is never reported as unknown", () => {
    const msg = unknownWordHelp(["living", "zzz"], rooms)
    expect(msg).toContain("zzz")
    expect(msg).not.toContain("'living'")
  })
})

/**
 * Epic #186312 · ADR-04, step 2 — durations.
 *
 * Pure, and over-tested on purpose: `over 6s`, `teal:6s` and every mode word resolve through
 * this one function, so a wrong answer here is wrong everywhere and silently — a fade that is
 * 6ms instead of 6s does not error, it just snaps, and reads as "transitions don't work".
 */
describe("ADR-04 · parseDuration", () => {
  test("a bare number is milliseconds, because that is what the scene format already uses", () => {
    // The shipped sequences say `wait: 400` and mean 400ms. Changing that meaning would
    // silently reinterpret every scene anyone has already written.
    expect(parseDuration("400")).toBe(400)
    expect(parseDuration("0")).toBe(0)
  })

  test("it reads the units people write", () => {
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("6s")).toBe(6000)
    expect(parseDuration("30m")).toBe(1_800_000)
    expect(parseDuration("1h")).toBe(3_600_000)
  })

  test("it accepts fractions, because 1.5s is a thing people mean", () => {
    expect(parseDuration("1.5s")).toBe(1500)
    expect(parseDuration("0.5s")).toBe(500)
  })

  test("case does not matter", () => {
    expect(parseDuration("6S")).toBe(6000)
    expect(parseDuration("30M")).toBe(1_800_000)
  })

  test("it refuses rather than guessing", () => {
    for (const bad of ["", "s", "abc", "6x", "-5s", "6 s", "6ss", "1.2.3s", "NaN"]) {
      expect(parseDuration(bad), `${bad} must be refused`).toBeNull()
    }
  })

  test("a colour is not a duration", () => {
    // `teal:6s` splits on the colon; neither half may be mistaken for the other.
    expect(parseDuration("teal")).toBeNull()
    expect(parseDuration("#008080")).toBeNull()
  })
})

describe("ADR-04 · toTransitionTime", () => {
  test("Hue counts fades in TENTHS of a second, not milliseconds", () => {
    // The unit mismatch is the whole reason this function exists. Passing ms straight
    // through would make every fade 10x too long and nothing would report an error.
    expect(toTransitionTime(6000)).toBe(60)
    expect(toTransitionTime(400)).toBe(4)
  })

  test("it clamps to what the bridge can actually store", () => {
    // transitiontime is a uint16 of tenths — 6553.5s. Asking for longer does not fail,
    // it OVERFLOWS, and a 2-hour sunset becomes a jump cut.
    expect(toTransitionTime(3_600_000 * 4)).toBe(65535)
    expect(toTransitionTime(-1)).toBe(0)
  })

  test("sub-tenth fades round to the nearest tenth rather than to zero", () => {
    // Rounding down would turn a 50ms fade into an instant snap; the caller asked for a
    // fade and should get the shortest real one.
    expect(toTransitionTime(50)).toBe(1)
    expect(toTransitionTime(0)).toBe(0)
  })
})

/**
 * Epic #186312 · ADR-04, step 3 — `over <duration>`.
 *
 * The capability already reached the bridge and could not be spoken: `Verbs.transitiontime`
 * is declared, sendTo() forwards the whole verbs object verbatim, and `sunrise` already
 * fades with it. Nothing in the CLI could set it. This is a parser change, not a protocol one.
 *
 * The property that makes it worth having: the BRIDGE performs the fade. The command exits
 * immediately, so `iris home all warm over 30m` is a half-hour sunset with no daemon, no
 * cron, and no terminal left open.
 */
describe("ADR-04 · over", () => {
  test("it sets a fade, in the bridge's units", () => {
    const { room, verbs } = parseSetArgs(["all", "teal", "over", "6s"])
    expect(room).toBe("all")
    expect(verbs?.transitiontime).toBe(60)
    expect(verbs?.hue).toBe(COLORS.teal!.hue)
  })

  test("`over` is never mistaken for a room name", () => {
    const { room } = parseSetArgs(["living", "blue", "over", "3s"])
    expect(room).toBe("living")
  })

  test("it works on a multi-word room", () => {
    const { room, verbs } = parseSetArgs(["living", "room", "warm", "over", "30m"])
    expect(room).toBe("living room")
    expect(verbs?.transitiontime).toBe(18_000)
  })

  test("it works with brightness alone — a dim-down is a fade too", () => {
    // `bri 10` is a RAW Hue value (1-254); `bri 10%` is a percentage. Easy to get
    // backwards, and getting it backwards makes a dim-down 25x too bright.
    const raw = parseSetArgs(["all", "bri", "10", "over", "10s"])
    expect(raw.verbs?.bri).toBe(10)
    expect(raw.verbs?.transitiontime).toBe(100)

    const pct = parseSetArgs(["all", "bri", "10%", "over", "10s"])
    expect(pct.verbs?.bri).toBe(25)
    expect(pct.verbs?.transitiontime).toBe(100)
  })

  test("a fade longer than the bridge can store is clamped, not overflowed", () => {
    const { verbs } = parseSetArgs(["all", "warm", "over", "4h"])
    expect(verbs?.transitiontime).toBe(65535)
  })

  test("`over` with a junk duration refuses instead of silently snapping", () => {
    // Left to fall through, "banana" would become part of the ROOM and the fade would be
    // dropped in silence — the command would appear to work and simply not fade.
    const { verbs } = parseSetArgs(["all", "teal", "over", "banana"])
    expect(verbs).toBeNull()
  })

  test("`over` with nothing after it refuses", () => {
    expect(parseSetArgs(["all", "teal", "over"]).verbs).toBeNull()
  })
})

/**
 * Epic #186312 · ADR-04, step 4 — `fade` in the step schema.
 *
 * One field, and it changes the character of the whole format. Every shipped sequence JUMPS
 * between steps, which is why the built-ins are called pulse and strobe and there is nothing
 * called breathe or drift. Same data, one field, the other half of the design space.
 */
describe("ADR-04 · fade in a scene step", () => {
  test("a step can fade instead of snapping", () => {
    expect(stepVerbs({ color: "teal", bri: 254, fade: 800 } as any).transitiontime).toBe(8)
  })

  test("a step with no fade still snaps — every existing scene keeps its timing", () => {
    // The shipped sequences have no `fade`. If absence meant "some default fade", every
    // scene anyone already wrote would quietly change character.
    expect(stepVerbs({ color: "blue", wait: 100 } as any).transitiontime).toBeUndefined()
  })

  test("fade accepts the duration vocabulary, not just milliseconds", () => {
    expect(stepVerbs({ color: "teal", fade: "1.5s" } as any).transitiontime).toBe(15)
  })

  test("fading to off is still a fade — the light dims out rather than cutting", () => {
    const v = stepVerbs({ off: true, fade: 2000 } as any)
    expect(v.on).toBe(false)
    expect(v.transitiontime).toBe(20)
  })

  test("a junk fade is refused at load, not silently dropped mid-show", () => {
    // normalizeScene validates colours already; a bad fade must fail the same way rather
    // than producing a show that runs and simply does not fade.
    expect(() => normalizeScene([{ room: "all", color: "blue", fade: "banana" }])).toThrow(/fade/i)
  })

  test("an over-long fade is clamped, never overflowed", () => {
    expect(stepVerbs({ color: "warm", fade: "4h" } as any).transitiontime).toBe(65535)
  })
})

/**
 * Epic #186312 · ADR-04, step 5 — capture.
 *
 * The highest-value piece, and it is not syntax. Nobody writes a good scene in JSON from a
 * cold start; they tune the room by eye and then want it back. Tonight's rainforest was set
 * by hand and is unrecoverable — it would have to be re-derived from memory.
 *
 * Captured state is stored RAW (hue/sat/ct), never round-tripped through hex: a saved scene
 * must reproduce the light exactly, and hex loses both the white-point and the precision.
 */
describe("ADR-04 · captureStep", () => {
  test("a colour light is captured in the bridge's own units", () => {
    const step = captureStep("living", { on: true, bri: 200, hue: 32768, sat: 254, colormode: "hs" })
    expect(step).toMatchObject({ room: "living", hue: 32768, sat: 254, bri: 200 })
    expect((step as any).ct).toBeUndefined()
  })

  test("a white light is captured as colour TEMPERATURE, not as a hue", () => {
    // A bulb in ct mode reports a stale hue/sat from whenever it was last coloured.
    // Saving those would restore the wrong light entirely.
    const step = captureStep("master", { on: true, bri: 180, ct: 366, hue: 8000, sat: 140, colormode: "ct" })
    expect(step).toMatchObject({ room: "master", ct: 366, bri: 180 })
    expect((step as any).hue).toBeUndefined()
  })

  test("a light that is off is captured as off", () => {
    expect(captureStep("trey", { on: false, bri: 1, colormode: "hs" })).toMatchObject({ room: "trey", off: true })
  })

  test("what is captured survives a round trip back to verbs", () => {
    const original = { on: true, bri: 200, hue: 32768, sat: 254, colormode: "hs" }
    const v = stepVerbs(captureStep("living", original) as any)
    expect(v).toMatchObject({ on: true, bri: 200, hue: 32768, sat: 254 })
  })

  test("a ct capture survives the round trip too", () => {
    const v = stepVerbs(captureStep("master", { on: true, bri: 180, ct: 366, colormode: "ct" }) as any)
    expect(v).toMatchObject({ on: true, bri: 180, ct: 366 })
  })

  test("raw hue and ct in a hand-written step are honoured, not ignored", () => {
    // Capture writes these, so the runner must read them — otherwise every saved scene
    // silently restores nothing but brightness.
    expect(stepVerbs({ hue: 12345, sat: 200, bri: 100 } as any)).toMatchObject({ hue: 12345, sat: 200, bri: 100 })
    expect(stepVerbs({ ct: 300 } as any)).toMatchObject({ ct: 300 })
  })

  test("a captured scene is a valid scene", () => {
    const scene = [
      captureStep("living", { on: true, bri: 200, hue: 32768, sat: 254, colormode: "hs" }),
      captureStep("master", { on: true, bri: 180, ct: 366, colormode: "ct" }),
    ]
    expect(() => normalizeScene(scene)).not.toThrow()
    expect(normalizeScene(scene).steps).toHaveLength(2)
  })
})

/**
 * Epic #186312 · ADR-04, steps 6-7 — the shorthand compiles to the scene format.
 *
 * ONE ENGINE, TWO DENSITIES. `@living teal:6s blue:6s drift` and the JSON are the same
 * thing written at different densities, so the shorthand can never drift from the format:
 * there is only one runner. It also makes the shorthand a TEACHER — run it with --explain
 * and you have learned the file format without reading any documentation.
 *
 * TRACKS are the genuinely new capability. A scene today is ONE global sequential timeline,
 * so every room shares a clock — which is why `pulse` pulses the whole house in lockstep and
 * nothing can drift out of phase. Ambient lighting is almost entirely about rooms being
 * slightly out of phase.
 */
describe("ADR-04 · compileShorthand", () => {
  test("a bare timeline targets the whole house", () => {
    const scene = compileShorthand(["teal:6s", "blue:6s", "drift"])!
    expect(Object.keys(scene.tracks)).toEqual(["all"])
    expect(scene.tracks.all).toHaveLength(2)
  })

  test("drift makes the duration the FADE — continuous motion, nothing snaps", () => {
    const [first] = compileShorthand(["teal:6s", "drift"])!.tracks.all
    expect(first.fade).toBe(6000)
    expect(first.wait).toBe(6000)
  })

  test("pulse makes the duration a HOLD — snap, sit, snap", () => {
    const [first] = compileShorthand(["purple:400", "dim:400", "pulse"])!.tracks.all
    expect(first.fade).toBe(0)
    expect(first.wait).toBe(400)
  })

  test("the default mode is drift, because ambient is the common case", () => {
    expect(compileShorthand(["teal:6s"])!.tracks.all[0].fade).toBe(6000)
  })

  test("@room opens a track", () => {
    const scene = compileShorthand(["@living", "teal:6s", "blue:6s", "drift"])!
    expect(Object.keys(scene.tracks)).toEqual(["living"])
  })

  test("two rooms get INDEPENDENT clocks — the whole point", () => {
    const scene = compileShorthand(["@living", "teal:6s", "blue:6s", "@bedroom", "amber:4s", "drift"])!
    expect(Object.keys(scene.tracks).sort()).toEqual(["bedroom", "living"])
    expect(scene.tracks.living).toHaveLength(2)
    expect(scene.tracks.bedroom).toHaveLength(1)
  })

  test("a multi-word room survives @", () => {
    const scene = compileShorthand(["@living", "room", "teal:6s"])!
    expect(Object.keys(scene.tracks)).toEqual(["living room"])
  })

  test("x6 repeats, loop runs until stopped", () => {
    expect(compileShorthand(["teal:1s", "blue:1s", "x6"])!.repeat).toBe(6)
    expect(compileShorthand(["teal:1s", "loop"])!.loop).toBe(true)
  })

  test("a hex is a colour here too", () => {
    expect(compileShorthand(["#008080:2s"])!.tracks.all[0].color).toBe("#008080")
  })

  test("off is a step, so a track can go dark deliberately", () => {
    expect(compileShorthand(["off:1s", "teal:1s", "pulse"])!.tracks.all[0].off).toBe(true)
  })

  test("it returns null when there is no timeline, so the old parser still gets its turn", () => {
    // `iris home all blue` must NOT be captured by the timeline parser.
    expect(compileShorthand(["all", "blue"])).toBeNull()
    expect(compileShorthand([])).toBeNull()
  })

  test("an unknown colour in a timeline is refused, not silently dropped", () => {
    expect(() => compileShorthand(["chartreuse:2s"])).toThrow(/chartreuse/)
  })

  test("an unreadable duration is refused", () => {
    expect(() => compileShorthand(["teal:banana"])).toThrow(/banana/)
  })

  /**
   * THE SAFETY PROPERTY. MIN_STEP_MS and never-switch-off are enforced in the template
   * engine with tests. The shorthand must INHERIT them by clamping, not by refusing: a
   * language in which the dangerous thing cannot be said beats one that validates after.
   */
  test("a step faster than the photosensitivity floor is clamped, not honoured", () => {
    const [s] = compileShorthand(["red:10", "blue:10", "strobe"])!.tracks.all
    expect(s.wait).toBeGreaterThanOrEqual(100)
  })

  test("repeat cannot be used to smuggle in an endless strobe", () => {
    expect(compileShorthand(["red:100", "x99999"])!.repeat).toBeLessThanOrEqual(1000)
  })
})
