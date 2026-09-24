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

test("related: ranked by Decide, p ≥ 0.25 kept, at least 5, never the pick itself, capped at top", async () => {
  const { rankRelated } = await import("./platform-intent-select")
  const pool = ["a", "b", "c", "d", "e", "f", "g"].map(c)
  const probs = [0.9, 0.1, 0.8, 0.05, 0.3, 0.02, 0.6]
  expect(rankRelated(pool, probs, 10, new Set(["a"])).map((x) => x.name)).toEqual(["c", "g", "e", "b", "d"])
  expect(rankRelated(pool, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 3, new Set()).length).toBe(3)
})

test("the fallback query is the request's topic, not its verb", async () => {
  const { topicOf, heuristicFill } = await import("./platform-intent-select")
  expect(topicOf("find places to eat in austin texas")).toBe("places to eat in austin texas")
  expect(topicOf("can you show me my leads?")).toBe("my leads")
  expect(
    heuristicFill(
      { name: "web-search", describe: "", run: "iris web-search [query]", score: 0 },
      "search for coffee grinders",
    ),
  ).toBe('iris web-search "coffee grinders"')
})
test("promotion needs an unsure pick and a clearly surer ranking", async () => {
  const m = await import("./platform-intent-select")
  expect(m.PROMOTE_UNSURE).toBeLessThanOrEqual(0.6)
  expect(m.PROMOTE_MIN).toBeGreaterThanOrEqual(0.7)
})

describe("speed — local work must stay small next to Decide's ~180ms round trip", () => {
  test("one ranking per step: pick is the top of pool, from a single search", async () => {
    const { candidatePools } = await import("./platform-intent-select")
    const { pick, pool } = candidatePools("build a website for my coffee shop", 12)
    const cmdPick = pick.filter(
      (x) => !x.name.startsWith("playbook run ") && !["web-search", "atlas search"].includes(x.name),
    )
    const cmdPool = pool.filter(
      (x) => !x.name.startsWith("playbook run ") && !["web-search", "atlas search"].includes(x.name),
    )
    expect(cmdPick.map((x) => x.name)).toEqual(cmdPool.slice(0, cmdPick.length).map((x) => x.name))
  })
  test("warm local selection for a 3-step request is well under a Decide round trip", async () => {
    const { candidatePools, splitSteps } = await import("./platform-intent-select")
    candidatePools("warm up", 12) // first call parses the index
    const t = performance.now()
    for (const step of splitSteps("transcribe this video and build a website from it then email it to my team"))
      candidatePools(step, 12)
    // Measured ~95ms per step before the one-ranking change; the budget catches a regression back
    // to per-step re-parsing and double searches without flaking on a busy CI box.
    expect(performance.now() - t).toBeLessThan(400)
  })
})

test("an optional input the request did not give stays visible as <url>, and is not runnable", async () => {
  const { heuristicFill, needsArgument } = await import("./platform-intent-select")
  const t = { name: "transcribe", describe: "", run: "iris transcribe [url]", score: 0 }
  expect(heuristicFill(t, "transcribe this video")).toBe("iris transcribe <url>")
  expect(needsArgument(heuristicFill(t, "transcribe this video"))).toBe(true)
  expect(heuristicFill(t, "transcribe https://youtu.be/x")).toBe("iris transcribe https://youtu.be/x")
  // optional non-inputs still drop
  expect(
    heuristicFill(
      { name: "genesis export", describe: "", run: "iris genesis export <slug> [out]", score: 0 },
      "export it",
    ),
  ).toBe("iris genesis export <slug>")
})

describe("agent discovery (#186666)", () => {
  const agents = [
    {
      id: 1,
      name: "Good Deals — Outreach Agent",
      type: "chat",
      active: true,
      description: "Manages LinkedIn founder outreach, drafts messages to prospects",
    },
    {
      id: 2,
      name: "Newsroom Agent",
      type: "chat",
      active: true,
      description: "Researches and drafts portfolio articles",
      last_active_at: "2026-09-20",
    },
    { id: 3, name: "Jane Doe", type: "human", active: true, description: "team member" },
    { id: 4, name: "BENCH grok", type: "chat", active: true, description: "Model benchmark scratch agent" },
    { id: 5, name: "Uniqueness Test 17", type: "chat", active: true, description: "test" },
    { id: 6, name: "Old Agent", type: "chat", active: false, description: "retired" },
  ]
  test("humans, inactive, bench and test agents are never candidates", async () => {
    const { isDiscoverable } = await import("./platform-intent-agents")
    expect(agents.filter(isDiscoverable).map((a) => a.id)).toEqual([1, 2])
  })
  test("ranking puts the matching agent first; the run line hands it the request", async () => {
    const { rankAgents } = await import("./platform-intent-agents")
    const r = rankAgents("draft outreach to founders", agents, {}, 8)
    expect(r[0].id).toBe(1)
    expect(r[0].run).toBe('iris agents chat 1 "draft outreach to founders"')
    expect(r.map((x) => x.id).sort()).toEqual([1, 2])
  })
  test("hand off only when Decide is sure it's an agent's job AND sure which agent", async () => {
    const { agentFrom, handsOff } = await import("./platform-intent-select")
    const cands = [
      { id: 1, name: "agent 1 · A", describe: "", run: 'iris agents chat 1 "x"', score: 0 },
      { id: 2, name: "agent 2 · B", describe: "", run: 'iris agents chat 2 "x"', score: 0 },
    ]
    const sure = agentFrom(
      { agent: { value: "agent 1 · A", confidence: 0.9 }, delegate: { probabilities: { true: 0.8 } } },
      cands,
    )
    expect(handsOff(sure)).toBe(true)
    expect(
      handsOff(
        agentFrom(
          { agent: { value: "agent 1 · A", confidence: 0.9 }, delegate: { probabilities: { true: 0.58 } } },
          cands,
        ),
      ),
    ).toBe(false)
    expect(agentFrom({ agent: { value: "__none__", confidence: 0.9 } }, cands)).toBeUndefined()
  })
})
