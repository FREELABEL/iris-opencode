import { describe, expect, test } from "bun:test"
import { argv, commandLines, commandOf, needsArgument, type Candidate } from "./platform-intent-select"

const c = (name: string): Candidate => ({ name, describe: "", run: `iris ${name}`, score: 0 })
const cands = [c("atlas"), c("atlas search"), c("web-search"), c("leads")]

describe("iris intent — tool selection", () => {
  test("a command line maps to the LONGEST candidate it starts with", () => {
    expect(commandOf('iris atlas search "family"', cands)?.name).toBe("atlas search")
    expect(commandOf("iris atlas", cands)?.name).toBe("atlas")
    expect(commandOf('iris web-search "places to eat"', cands)?.name).toBe("web-search")
  })
  test("the planner cannot invent a command", () => {
    expect(commandOf("iris rm-everything", cands)).toBeUndefined()
    expect(commandOf("rm -rf /", cands)).toBeUndefined()
    expect(commandOf("iris atlass search x", cands)).toBeUndefined()
  })
  test("reads commands through the proxy's <think> block and a lost JSON opening (#186551)", () => {
    const reply =
      '<think>they want food</think>\n":["iris web-search \\"places to eat in austin\\"","iris atlas search \\"family\\""]}'
    expect(commandLines(reply)).toEqual(['iris web-search "places to eat in austin"', 'iris atlas search "family"'])
  })
  test("quoted arguments stay one argument", () => {
    expect(argv('iris atlas search "favorite foods"')).toEqual(["iris", "atlas", "search", "favorite foods"])
  })
  test("a <placeholder> is not runnable", () => {
    expect(needsArgument("iris integrations connect <type>")).toBe(true)
    expect(needsArgument('iris web-search "x"')).toBe(false)
  })
})
