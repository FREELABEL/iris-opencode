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

test("Decide's yes/no answers add web-search and atlas search beside its pick", async () => {
  const { extrasFrom } = await import("./platform-intent-select")
  const pool = [c("geo nearby"), c("web-search"), c("atlas search")]
  expect(
    extrasFrom(
      { web: { value: true, probabilities: { true: 0.8 } }, atlas: { value: true, probabilities: { true: 0.7 } } },
      "geo nearby",
      pool,
    ),
  ).toEqual(["web-search", "atlas search"])
  expect(
    extrasFrom({ web: { value: true, probabilities: { true: 0.8 } }, atlas: { value: false } }, "web-search", pool),
  ).toEqual([])
})
test("no model: the request fills the first placeholder", async () => {
  const { heuristicFill } = await import("./platform-intent-select")
  expect(
    heuristicFill({ name: "web-search", describe: "", run: "iris web-search [query]", score: 0 }, "places to eat"),
  ).toBe('iris web-search "places to eat"')
  expect(heuristicFill({ name: "monitor", describe: "", run: "iris monitor", score: 0 }, "x")).toBe("iris monitor")
})

test("a barely-yes (p=0.52) adds nothing", async () => {
  const { extrasFrom } = await import("./platform-intent-select")
  expect(
    extrasFrom({ web: { value: true, probabilities: { true: 0.52 } } }, "transcribe", [
      c("transcribe"),
      c("web-search"),
    ]),
  ).toEqual([])
})
test("multi-step requests split before a verb, not on every 'and'", async () => {
  const { splitSteps } = await import("./platform-intent-select")
  expect(splitSteps("transcribe this video and build a website from it")).toEqual([
    "transcribe this video",
    "build a website from it",
  ])
  expect(splitSteps("salt and pepper shaker ideas")).toEqual(["salt and pepper shaker ideas"])
})
test("a command group is not an answer when a real command matched", async () => {
  const { leafOnly } = await import("./platform-intent-select")
  expect(leafOnly([c("genesis"), c("genesis create")], ["genesis", "genesis create"]).map((x) => x.name)).toEqual([
    "genesis create",
  ])
})
test("the no-model fill uses a URL for <url> and never pastes the sentence where it does not belong", async () => {
  const { heuristicFill } = await import("./platform-intent-select")
  const t = { name: "transcribe", describe: "", run: "iris transcribe [url]", score: 0 }
  expect(heuristicFill(t, "transcribe https://youtu.be/x please")).toBe("iris transcribe https://youtu.be/x")
  expect(heuristicFill({ ...t, run: "iris transcribe <url>" }, "transcribe this video")).toBe("iris transcribe <url>")
})
