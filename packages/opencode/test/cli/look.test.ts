import { describe, expect, test } from "bun:test"
import { regionCapturePlan } from "../../src/cli/cmd/platform-look"
import { askVision } from "../../src/cli/cmd/ocr-core"

// #188543 — the OS's own region picker, then the existing vision lane. Pins which picker runs where,
// that nothing is guessed when no picker exists, and the shared gateway call's failure wording.
const OUT = "/tmp/x.png"
const only = (...bins: string[]) => (b: string) => bins.includes(b)

describe("regionCapturePlan", () => {
  test("macOS: screencapture interactive region, silent", () => {
    expect(regionCapturePlan("darwin", {}, only(), OUT)).toEqual({ steps: [{ cmd: "screencapture", args: ["-i", "-x", OUT] }] })
  })
  test("Wayland with slurp+grim: geometry from slurp feeds grim", () => {
    const p: any = regionCapturePlan("linux", { WAYLAND_DISPLAY: "wayland-1" }, only("slurp", "grim", "maim"), OUT)
    expect(p.steps.map((s: any) => s.cmd)).toEqual(["slurp", "grim"])
    expect(p.steps[1].geometryFromPrev).toBe(true)
  })
  test("X11 prefers maim, then gnome-screenshot, then ImageMagick import", () => {
    expect((regionCapturePlan("linux", { DISPLAY: ":0" }, only("maim", "import"), OUT) as any).steps[0].cmd).toBe("maim")
    expect((regionCapturePlan("linux", { DISPLAY: ":0" }, only("gnome-screenshot", "import"), OUT) as any).steps[0].cmd).toBe("gnome-screenshot")
    expect((regionCapturePlan("linux", { DISPLAY: ":0" }, only("import"), OUT) as any).steps[0].cmd).toBe("import")
  })
  test("never runs an X11 picker on a Wayland-only session", () => {
    const p: any = regionCapturePlan("linux", { WAYLAND_DISPLAY: "w" }, only("maim", "import"), OUT)
    expect(p.error).toMatch(/slurp \+ grim/)
  })
  test("no screen, no picker, Windows: an error that says what to do — never a guess", () => {
    expect((regionCapturePlan("linux", {}, only("maim"), OUT) as any).error).toMatch(/--image/)
    expect((regionCapturePlan("linux", { DISPLAY: ":0" }, only(), OUT) as any).error).toMatch(/maim/)
    expect((regionCapturePlan("win32", {}, only(), OUT) as any).error).toMatch(/Win\+Shift\+S/)
  })
})

describe("askVision (shared by ocr and look)", () => {
  const msg = [{ role: "user" as const, content: [{ type: "text" as const, text: "q" }] }]
  const reply = (status: number, body: any) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as any
  test("strips the model's <think> block and returns the answer", async () => {
    const r = await askVision({ base: "http://x", token: "t", model: "iris/gpt-4o-mini", messages: msg, maxTokens: 5, fetchImpl: reply(200, { choices: [{ message: { content: "<think>hm</think> It is a stack trace." } }] }) })
    expect(r).toEqual({ ok: true, text: "It is a stack trace.", usage: null })
  })
  test("a refusal carries the status and what the gateway said", async () => {
    const r: any = await askVision({ base: "http://x", token: "t", model: "m", messages: msg, maxTokens: 5, fetchImpl: reply(402, "out of credits") })
    expect(r.ok).toBe(false)
    expect(r.error).toBe("HTTP 402 from the model gateway: out of credits")
  })
  test("no choices is not an empty answer", async () => {
    const r: any = await askVision({ base: "http://x", token: "t", model: "m", messages: msg, maxTokens: 5, fetchImpl: reply(200, { choices: [] }) })
    expect(r.error).toBe("The model returned no reply.")
  })
  test("network failure never throws", async () => {
    const r: any = await askVision({ base: "http://x", token: "t", model: "m", messages: msg, maxTokens: 5, fetchImpl: (async () => { throw new Error("ECONNREFUSED") }) as any })
    expect(r.error).toMatch(/Could not reach http:\/\/x: ECONNREFUSED/)
  })
})
