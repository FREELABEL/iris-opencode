import { describe, expect, test } from "bun:test"
import { parseFindJson, sanitiseQuery, searchCliCommands } from "./cli-commands"

// #186546 — the palette showed three app commands; the CLI's 1,664 live in another binary.

const SAMPLE = `
  ◈ IRIS
  {"query":"leads","matched":2,"results":[
    {"kind":"command","name":"leads","describe":"manage CRM leads","aliases":["crm"],"run":"iris leads","score":565},
    {"kind":"playbook","name":"lead-outreach","describe":"Draft outreach","run":"iris playbook run lead-outreach"},
    {"kind":"command","name":"pages","score":1}
  ]}
  Done
`

describe("parseFindJson", () => {
  test("keeps commands, drops playbooks, and never invents a run string", () => {
    const rows = parseFindJson(SAMPLE)
    expect(rows.map((r) => r.name)).toEqual(["leads", "pages"])
    expect(rows[0]).toMatchObject({ describe: "manage CRM leads", run: "iris leads", aliases: ["crm"] })
    // no `run` in the payload — derived, not blank
    expect(rows[1]!.run).toBe("iris pages")
  })

  test("junk in, empty out — never a throw", () => {
    expect(parseFindJson("")).toEqual([])
    expect(parseFindJson("no json here")).toEqual([])
    expect(parseFindJson("{ not json")).toEqual([])
  })
})

describe("sanitiseQuery", () => {
  test("a typed query is one argv item, not a shell fragment", () => {
    expect(sanitiseQuery("leads; rm -rf /")).toBe("leads  rm -rf /")
    expect(sanitiseQuery("`whoami`")).toBe("whoami")
    expect(sanitiseQuery("$(id)")).toBe("id")
    expect(sanitiseQuery("x".repeat(200)).length).toBe(80)
  })
})

describe("searchCliCommands", () => {
  test("no CLI installed is a REASON, never an empty list that reads as 'no commands'", async () => {
    const r = await searchCliCommands("leads", { cli: null })
    expect(r).toMatchObject({ measured: false, commands: [] })
    expect(r.reason).toContain("not installed")
  })

  test("an empty query still asks for something — the palette opens before anyone types", async () => {
    let seen: string[] = []
    await searchCliCommands("", {
      cli: "/fake/iris",
      exec: async (_f, args) => {
        seen = args
        return { code: 0, stdout: SAMPLE }
      },
    })
    expect(seen[0]).toBe("find")
    expect(seen[1]).toBe("iris")
    expect(seen).toContain("--kind")
    expect(seen).toContain("command")
  })

  test("it passes the query as ONE argv item and caps the limit", async () => {
    let seen: string[] = []
    const r = await searchCliCommands("leads", {
      limit: 5000,
      cli: "/fake/iris",
      exec: async (_f, args) => {
        seen = args
        return { code: 0, stdout: SAMPLE }
      },
    })
    expect(seen[1]).toBe("leads")
    expect(seen[seen.indexOf("--limit") + 1]).toBe("100")
    expect(r.commands).toHaveLength(2)
  })

  test("a failing CLI with no parsable output is not measured", async () => {
    const r = await searchCliCommands("x", { cli: "/fake/iris", exec: async () => ({ code: 1, stdout: "boom" }) })
    expect(r.measured).toBe(false)
  })
})
