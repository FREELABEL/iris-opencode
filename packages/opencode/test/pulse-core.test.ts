import { afterEach, describe, expect, test } from "bun:test"
import {
  extend,
  formatCount,
  registerDefault,
  resetExtensions,
  runScript,
  scriptFor,
  type PulseScript,
  type Source,
  type SourceResult,
  type Stop,
} from "../src/pulse/core"
import { defaultTopicScript } from "../src/cli/cmd/pulse-topic-script"
import { defaultContactScript } from "../src/cli/cmd/pulse-contact-script"

type Q = { word: string }
const result = (hits: number, extra: Partial<SourceResult<string>> = {}): SourceResult<string> => ({
  hits,
  items: [],
  measured: true,
  provenance: ["fixture"],
  ...extra,
})
const source = (id: string, read: (q: Q) => Promise<SourceResult<string>>, isAvailable?: Source<Q>["isAvailable"]): Source<Q, SourceResult<string>> => ({
  id,
  label: id.toUpperCase(),
  read,
  isAvailable,
})
const stop = (src: Source<Q, SourceResult<string>>): Stop<Q, SourceResult<string>, number | null> => ({
  id: src.id,
  source: src,
  extract: (r) => r.hits,
  unavailable: () => null,
})

afterEach(() => resetExtensions())

describe("runner", () => {
  test("a shut stop is shut with its reason — never a 0", async () => {
    const script: PulseScript<Q, number | null> = {
      route: "topic",
      readOnly: true,
      stops: [
        stop(source("ok", async () => result(3))),
        stop(source("blind", async () => result(0, { measured: false, reason: "no access" }))),
        stop(source("absent", async () => result(9), () => ({ ok: false, reason: "not on this machine" }))),
      ],
    }
    const out = await runScript(script, { word: "x" })
    expect(out.map((o) => [o.id, o.shut, o.reason])).toEqual([
      ["ok", false, null],
      ["blind", true, "no access"],
      ["absent", true, "not on this machine"],
    ])
    expect(formatCount(out[1], 0)).toBe("shut — no access")
    expect(out[2].output).toBeNull() // never read: the source said it was unavailable
  })

  test("one stop throwing is isolated; the route goes on and says why", async () => {
    const script: PulseScript<Q, number | null> = {
      route: "topic",
      readOnly: true,
      stops: [stop(source("boom", async () => { throw new Error("disk on fire") })), stop(source("after", async () => result(2)))],
    }
    const [boom, after] = await runScript(script, { word: "x" })
    expect(boom.shut).toBe(true)
    expect(boom.reason).toBe("BOOM failed: disk on fire")
    expect(after.output).toBe(2)
  })

  test("a floor stays a floor", async () => {
    const script: PulseScript<Q, number | null> = { route: "topic", readOnly: true, stops: [stop(source("capped", async () => result(200, { floor: true })))] }
    const [o] = await runScript(script, { word: "x" })
    expect(o.floor).toBe(true)
    expect(formatCount(o, 200)).toBe("200+")
  })

  test("parallel mode returns outcomes in completion order; sequential in stop order", async () => {
    const wait = (ms: number, hits: number) => async () => new Promise<SourceResult<string>>((r) => setTimeout(() => r(result(hits)), ms))
    const stops = [stop(source("slow", wait(30, 1))), stop(source("fast", wait(5, 2)))]
    const par = await runScript({ route: "contact", readOnly: true, mode: "parallel", stops }, { word: "x" })
    expect(par.map((o) => o.id)).toEqual(["fast", "slow"])
    const seq = await runScript({ route: "contact", readOnly: true, stops }, { word: "x" })
    expect(seq.map((o) => o.id)).toEqual(["slow", "fast"])
  })

  test("a script that is not read-only does not run", async () => {
    await expect(runScript({ route: "topic", readOnly: false as any, stops: [] }, { word: "x" })).rejects.toThrow(/readOnly/)
  })
})

describe("registry", () => {
  test("the built-in routes are registered with their stops", () => {
    expect(scriptFor("topic").stops.map((s) => s.id)).toEqual(defaultTopicScript.stops.map((s) => s.id))
    expect(defaultTopicScript.stops.map((s) => s.id)).toEqual(["git", "diary", "files", "claude_code", "opencode", "iris_desktop", "imessage", "email", "gmail", "calendar", "drive", "bloq"])
    expect(scriptFor("contact")).toBe(defaultContactScript as any)
    expect(scriptFor("contact").stops.map((s) => s.id)).toEqual(["gmail", "imessage", "imessage_groups", "whatsapp_groups", "apple_mail", "calendar", "iris_desktop"])
    expect(scriptFor("contact").mode).toBe("parallel")
  })

  test("extend appends a new stop and replaces one with the same id", () => {
    const linear = stop(source("linear", async () => result(1)))
    const myGit = { ...stop(source("git", async () => result(1))) }
    extend("topic", linear as any, myGit as any)
    const ids = scriptFor("topic").stops.map((s) => s.id)
    expect(ids[0]).toBe("git")
    expect(scriptFor("topic").stops[0]).toBe(myGit as any)
    expect(ids.at(-1)).toBe("linear")
    resetExtensions("topic")
    expect(scriptFor("topic")).toBe(defaultTopicScript as any)
  })

  test("a default must be registered under its own route", () => {
    expect(() => registerDefault("contact", { route: "topic", readOnly: true, stops: [] })).toThrow()
  })
})
