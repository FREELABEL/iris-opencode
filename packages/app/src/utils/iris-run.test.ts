import { describe, expect, test } from "bun:test"
import { firstLine, formatIrisLine, hasUnquotedSeparator, lastLine, outcomeOf, parseIrisLine, runIris } from "./iris-run"

describe("parseIrisLine (#194581)", () => {
  test("an iris line becomes argv, quotes kept as one word", () => {
    expect(parseIrisLine(`iris drives scan "/Volumes/Hive archive"`)).toEqual({ argv: ["drives", "scan", "/Volumes/Hive archive"] })
    expect(parseIrisLine("  iris leads list --json ")).toEqual({ argv: ["leads", "list", "--json"] })
    expect(parseIrisLine("~/.iris/bin/iris hive connect")).toEqual({ argv: ["hive", "connect"] })
  })

  test("only one iris command, nothing a shell would do", () => {
    expect(parseIrisLine("")).toEqual({ error: "empty" })
    expect(parseIrisLine("iris")).toEqual({ error: "empty" })
    expect(parseIrisLine("rm -rf ~")).toEqual({ error: "not-iris" })
    expect(parseIrisLine("iris leads list; rm -rf ~")).toEqual({ error: "chained" })
    expect(parseIrisLine("iris leads list && echo hi")).toEqual({ error: "chained" })
    expect(parseIrisLine("iris leads search $(whoami)")).toEqual({ error: "chained" })
    expect(parseIrisLine("iris leads search `id`")).toEqual({ error: "chained" })
  })

  test("separators inside quotes are just characters", () => {
    expect(hasUnquotedSeparator(`iris leads search "a; b && c"`)).toBe(false)
    expect(parseIrisLine(`iris leads search 'x | y'`)).toEqual({ argv: ["leads", "search", "x | y"] })
  })
})

describe("formatIrisLine", () => {
  test("round-trips through parse", () => {
    const argv = ["drives", "scan", "/Volumes/A B", `say "hi"`, ""]
    const line = formatIrisLine(argv)
    expect(line).toBe(`iris drives scan "/Volumes/A B" "say \\"hi\\"" ""`)
    expect(parseIrisLine(line)).toEqual({ argv })
  })
})

describe("outcomeOf", () => {
  test("done, failed, refused, timed out", () => {
    expect(outcomeOf({ ran: true, kind: "read", code: 0, stdout: "Found 2 drives\nAll good\n" })).toEqual({ tone: "success", title: "done", detail: "All good" })
    expect(outcomeOf({ ran: true, kind: "read", code: 1, stderr: "\nNot signed in\nmore" })).toEqual({ tone: "critical", title: "failed", detail: "Not signed in" })
    expect(outcomeOf({ ran: true, kind: "read", code: 3 }).detail).toBe("exit 3")
    expect(outcomeOf({ ran: false, kind: "write", refused: "no" })).toEqual({ tone: "critical", title: "refused", detail: "no" })
    expect(outcomeOf({ ran: true, kind: "read", code: 124, timedOut: true }).title).toBe("timedOut")
  })

  test("lines skip blanks and banner rules", () => {
    expect(firstLine("\n──────\n  hello \n")).toBe("hello")
    expect(lastLine("done\n======\n")).toBe("done")
    expect(firstLine("x".repeat(300)).length).toBe(160)
  })
})

describe("runIris", () => {
  test("posts argv and the confirm to the engine", async () => {
    const seen: { url: string; body: unknown }[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ran: false, kind: "write", needsConfirm: true }), { status: 200 })
    }
    const r = await runIris(fetch, "http://127.0.0.1:4096/", ["hive", "connect"], false)
    expect(r.needsConfirm).toBe(true)
    expect(seen).toEqual([{ url: "http://127.0.0.1:4096/iris/run", body: { argv: ["hive", "connect"], confirmed: false } }])
  })

  test("an engine that is not there is a refusal, not a throw", async () => {
    const r = await runIris(async () => Promise.reject(new Error("ECONNREFUSED")), "", ["leads", "list"], false)
    expect(r.ran).toBe(false)
    expect(r.refused).toBeTruthy()
  })
})
