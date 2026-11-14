import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"
import { resetExtensions, scriptFor } from "../../pulse/core"
import { sweepAll, toObservations, type SweepOptions } from "./pulse-check-sweep"
import "./pulse-topic-script"
import {
  CUSTOM_SOURCES_DIR,
  loadCustomSources,
  parseCustomOutput,
  registerCustomSources,
  resetCustomSources,
  sweepCustom,
  type CustomSourceDef,
} from "./pulse-custom-sources"

// #190626 — "Pulse is completely programmable: swap iMessage for something else" (M42 demo,
// 2026-10-22). It was not: --sources only chose among nine built-ins. These pin the contract of a
// source a person adds with a JSON file, and the two rules every built-in already keeps.

const opts = (o: Partial<SweepOptions> = {}): SweepOptions => ({ keyword: "vanguard", repo: ".", windowDays: 7, limit: 2, sources: [], ...o })

/** A source whose command is a script run by this same runtime, printing whatever `body` does. */
function scripted(dir: string, id: string, body: string, extra: Record<string, unknown> = {}): string {
  const script = join(dir, `${id}.mjs`)
  writeFileSync(script, body)
  const file = join(dir, `${id}.json`)
  writeFileSync(file, JSON.stringify({ id, label: id.toUpperCase(), command: [process.execPath, script], ...extra }))
  return file
}

const def = (dir: string, id: string): CustomSourceDef => loadCustomSources(dir).sources.find((s) => s.id === id)!

afterEach(() => {
  resetExtensions("topic")
  resetCustomSources()
})

describe("loading ~/.iris/pulse/sources", () => {
  test("a missing folder is no sources and no errors", () => {
    expect(loadCustomSources(join(tmpdir(), "does-not-exist-190626"))).toEqual({ sources: [], errors: [] })
  })

  test("a good file loads; ~ expands; a built-in's id is marked as replacing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    writeFileSync(join(dir, "whatsapp.json"), JSON.stringify({ id: "whatsapp", label: "WhatsApp", command: ["python3", "~/bin/wa.py"] }))
    writeFileSync(join(dir, "imessage.json"), JSON.stringify({ id: "imessage", command: ["true"] }))
    const { sources, errors } = loadCustomSources(dir)
    expect(errors).toEqual([])
    const wa = sources.find((s) => s.id === "whatsapp")!
    expect(wa.command).toEqual(["python3", join(homedir(), "bin/wa.py")])
    expect(wa.replaces).toBe(false)
    expect(wa.timeoutMs).toBe(20000)
    expect(sources.find((s) => s.id === "imessage")!.replaces).toBe(true)
    expect(sources.find((s) => s.id === "imessage")!.label).toBe("imessage")
  })

  test("a bad file is reported with why, and does not stop the good ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    writeFileSync(join(dir, "a.json"), "{ not json")
    writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "Bad Id", command: ["x"] }))
    writeFileSync(join(dir, "c.json"), JSON.stringify({ id: "shell", command: "grep -r foo ~ | head" }))
    writeFileSync(join(dir, "d.json"), JSON.stringify({ id: "slow", command: ["x"], timeout_ms: 999999 }))
    writeFileSync(join(dir, "e.json"), JSON.stringify({ id: "slack", command: ["x"] }))
    writeFileSync(join(dir, "f.json"), JSON.stringify({ id: "slack", command: ["y"] }))
    writeFileSync(join(dir, "notes.txt"), "ignored")
    const { sources, errors } = loadCustomSources(dir)
    expect(sources.map((s) => s.id)).toEqual(["slack"])
    expect(errors.map((e) => e.file.split("/").pop())).toEqual(["a.json", "b.json", "c.json", "d.json", "f.json"])
    expect(errors.find((e) => e.file.endsWith("c.json"))!.error).toContain("without a shell")
  })

  test("only the home folder is read — never the repo being swept", () => {
    expect(CUSTOM_SOURCES_DIR).toBe(join(homedir(), ".iris", "pulse", "sources"))
  })
})

describe("what a custom source's command prints", () => {
  const d = { id: "mine", file: "/x/mine.json" }

  test("items count, the list is trimmed to --limit, and the newest date is kept", () => {
    const s = parseCustomOutput(
      d,
      JSON.stringify({ items: [{ where: "a", when: "2026-10-01T00:00:00Z" }, { where: "b", when: "2026-10-20T00:00:00Z", text: "t" }, { where: "c" }] }),
      2,
    )
    expect(s.searched).toBe(true)
    expect(s.hits).toBe(3)
    expect(s.items).toHaveLength(2)
    expect(s.lastHitEpoch).toBe(Date.parse("2026-10-20T00:00:00Z") / 1000)
  })

  test("rule 2: no hits_prior from the command means none is invented", () => {
    expect(parseCustomOutput(d, JSON.stringify({ items: [{ where: "a" }] }), 5).hitsPrior).toBeUndefined()
    expect(parseCustomOutput(d, JSON.stringify({ items: [], hits_prior: 4 }), 5).hitsPrior).toBe(4)
  })

  test("a declared count above the listed items wins; a capped count is a floor with no momentum", () => {
    const s = parseCustomOutput(d, JSON.stringify({ items: [{ where: "a" }], hits: 500, hits_prior: 10, capped: true }), 5)
    expect(s.hits).toBe(500)
    expect(s.capped).toBe(true)
    expect(s.hitsPrior).toBeUndefined()
  })

  test("rule 1: anything that is not the contract is NOT SEARCHED, with why — never zero hits", () => {
    for (const out of ["", "hello", "[]", JSON.stringify({ found: 3 })]) {
      const s = parseCustomOutput(d, out, 5)
      expect(s.searched).toBe(false)
      expect(s.unavailableReason).toContain("/x/mine.json")
    }
    const said = parseCustomOutput(d, JSON.stringify({ unavailable: "WhatsApp export is older than the window" }), 5)
    expect(said).toMatchObject({ searched: false, unavailableReason: "WhatsApp export is older than the window" })
  })
})

describe("running the command", () => {
  test("it gets the question in its environment and its answer comes back as a sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    scripted(
      dir,
      "echoer",
      `const e = process.env
console.log(JSON.stringify({ items: [{ where: e.PULSE_KEYWORD + "|" + e.PULSE_WINDOW_DAYS + "|" + e.PULSE_LIMIT + "|" + JSON.parse(e.PULSE_VARIANTS).length + "|" + (Date.parse(e.PULSE_SINCE) > Date.parse(e.PULSE_PRIOR_SINCE)) }] }))`,
    )
    const s = await sweepCustom(def(dir, "echoer"), opts({ keyword: "creator os", windowDays: 30, limit: 3 }))
    expect(s.searched).toBe(true)
    const [kw, days, limit, variants, ordered] = s.items[0].where.split("|")
    expect([kw, days, limit, ordered]).toEqual(["creator os", "30", "3", "true"])
    expect(Number(variants)).toBeGreaterThan(0)
  })

  test("a command that fails, is missing or hangs is not searched, and says which file to fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    scripted(dir, "boom", `console.error("token expired"); process.exit(3)`)
    scripted(dir, "hang", `setTimeout(() => {}, 60000)`, { timeout_ms: 1000 })
    writeFileSync(join(dir, "gone.json"), JSON.stringify({ id: "gone", command: ["/no/such/binary-190626"] }))

    const boom = await sweepCustom(def(dir, "boom"), opts())
    expect(boom.searched).toBe(false)
    expect(boom.unavailableReason).toContain("exited 3")
    expect(boom.unavailableReason).toContain("token expired")
    expect(boom.unavailableReason).toContain("boom.json")

    expect((await sweepCustom(def(dir, "gone"), opts())).unavailableReason).toContain("command not found")
    expect((await sweepCustom(def(dir, "hang"), opts())).unavailableReason).toContain("timed out")
  })
})

describe("on the topic route", () => {
  test("a new source is added after the built-ins; a built-in's id replaces it IN PLACE", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    scripted(dir, "whatsapp", `console.log(JSON.stringify({ items: [] }))`)
    scripted(dir, "imessage", `console.log(JSON.stringify({ items: [] }))`)
    const before = scriptFor("topic").stops.map((s) => s.id)
    registerCustomSources(dir)
    const after = scriptFor("topic").stops
    expect(after.map((s) => s.id)).toEqual([...before, "whatsapp"])
    expect(after.find((s) => s.id === "imessage")!.source.label).toBe("IMESSAGE")
  })

  test("one process reads the folder once: a file added mid-run does not change what this run sweeps", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    scripted(dir, "whatsapp", `console.log(JSON.stringify({ items: [] }))`)
    const first = registerCustomSources(dir)
    scripted(dir, "slack", `console.log(JSON.stringify({ items: [] }))`)
    expect(registerCustomSources(dir)).toBe(first)
    expect(scriptFor("topic").stops.filter((s) => s.id === "whatsapp")).toHaveLength(1)
    expect(scriptFor("topic").stops.some((s) => s.id === "slack")).toBe(false)
  })

  test("sweepAll runs it like any other source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-"))
    scripted(dir, "slack", `console.log(JSON.stringify({ items: [{ where: "#vanguard", when: "2026-10-21T09:00:00Z", text: "secret plan" }], hits_prior: 1 }))`)
    registerCustomSources(dir)
    const [s] = await sweepAll(opts({ sources: ["slack"] }))
    expect(s).toMatchObject({ source: "slack", searched: true, hits: 1, hitsPrior: 1 })
  })

  test("its text is not uploaded unless --include-context — like messages, not like commits", () => {
    const sweep = parseCustomOutput({ id: "slack", file: "f" }, JSON.stringify({ items: [{ where: "#vanguard", text: "secret plan" }] }), 5)
    const [off] = toObservations("vanguard", [sweep], { includeContext: false, windowDays: 7 })
    expect(off.text).toBeNull()
    expect(off.payload.locators).toEqual([{ when: undefined, where: "#vanguard" }])
    expect(off.metrics).toEqual({ slack_hits: 1 })
    const [on] = toObservations("vanguard", [sweep], { includeContext: true, windowDays: 7 })
    expect(on.text).toContain("secret plan")
  })
})
