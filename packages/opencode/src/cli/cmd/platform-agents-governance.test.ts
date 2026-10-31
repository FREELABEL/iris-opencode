import { describe, test, expect } from "bun:test"
import { governanceRequest, sendGovernance, summarize } from "./platform-agents-governance"

/**
 * `iris agents pause|resume|stop` (#187908). The paths are the contract with iris-api's
 * AgentGovernanceController — a wrong one 404s, and a 404 there reads as "agent not found",
 * which is exactly the message that sends someone looking in the wrong place.
 */

describe("governanceRequest", () => {
  test("pause / resume hit the agent's own route", () => {
    expect(governanceRequest("pause", { id: 42 })).toEqual({ path: "/api/v1/agents/42/pause", scope: "agent" })
    expect(governanceRequest("resume", { id: "42" })).toEqual({ path: "/api/v1/agents/42/resume", scope: "agent" })
  })

  test("stop maps to terminate — the server has no /stop", () => {
    expect(governanceRequest("stop", { id: 42 })).toEqual({ path: "/api/v1/agents/42/terminate", scope: "agent" })
  })

  test("--all targets the workspace route and needs the bloq", () => {
    expect(governanceRequest("pause", { all: true, bloq: 550 })).toEqual({ path: "/api/v1/bloqs/550/agents/pause", scope: "bloq" })
    expect(governanceRequest("resume", { all: true, bloq: 550 })).toEqual({ path: "/api/v1/bloqs/550/agents/resume", scope: "bloq" })
    expect(governanceRequest("pause", { all: true })).toHaveProperty("error")
  })

  test("there is no stop --all: an irreversible action across a workspace is refused offline", () => {
    const r = governanceRequest("stop", { all: true, bloq: 550 })
    expect(r).toHaveProperty("error")
    expect((r as { error: string }).error).toContain("pause --all")
  })

  test("an id and --all together is ambiguous, and a missing or non-numeric id is a sentence", () => {
    expect(governanceRequest("pause", { id: 1, all: true, bloq: 2 })).toHaveProperty("error")
    expect(governanceRequest("pause", {})).toHaveProperty("error")
    expect(governanceRequest("pause", { id: "my-agent" })).toHaveProperty("error")
    expect(governanceRequest("pause", { id: -3 })).toHaveProperty("error")
  })
})

describe("round-trip against a fake iris-api", () => {
  // A minimal stand-in for AgentGovernanceController's state machine, so pause → resume → stop
  // is exercised as a sequence through the real request builder and sender.
  function fakeServer() {
    const agents: Record<number, string> = { 42: "healthy", 43: "healthy" }
    const calls: string[] = []
    const fetcher = async (path: string, init: RequestInit) => {
      calls.push(`${init.method} ${path}`)
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
      let m = path.match(/^\/api\/v1\/agents\/(\d+)\/(pause|resume|terminate)$/)
      if (m) {
        const id = Number(m[1])
        const verb = m[2]
        if (!(id in agents)) return json(404, { error: "Agent not found" })
        if (verb !== "terminate" && agents[id] === "terminated") return json(422, { error: `Cannot ${verb} a terminated agent` })
        agents[id] = verb === "pause" ? "paused_manual" : verb === "resume" ? "healthy" : "terminated"
        return json(200, { success: true, agent: { id, name: `agent ${id}`, health_status: agents[id] } })
      }
      m = path.match(/^\/api\/v1\/bloqs\/(\d+)\/agents\/(pause|resume)$/)
      if (m) {
        let count = 0
        for (const id of Object.keys(agents).map(Number)) {
          if (m[2] === "pause" && agents[id] === "healthy") { agents[id] = "paused_manual"; count++ }
          if (m[2] === "resume" && agents[id] === "paused_manual") { agents[id] = "healthy"; count++ }
        }
        return json(200, { success: true, bloq_id: Number(m[1]), count, agents: [] })
      }
      return json(404, { error: "no route" })
    }
    return { agents, calls, fetcher }
  }

  test("pause → resume → stop, then resume is refused", async () => {
    const srv = fakeServer()

    const p = await sendGovernance("pause", { id: 42 }, srv.fetcher)
    expect("res" in p && p.res.status).toBe(200)
    expect(srv.agents[42]).toBe("paused_manual")

    await sendGovernance("resume", { id: 42 }, srv.fetcher)
    expect(srv.agents[42]).toBe("healthy")

    const s = await sendGovernance("stop", { id: 42 }, srv.fetcher)
    expect("res" in s && (await s.res.json()).agent.health_status).toBe("terminated")

    const r = await sendGovernance("resume", { id: 42 }, srv.fetcher)
    expect("res" in r && r.res.status).toBe(422)

    expect(srv.calls).toEqual([
      "POST /api/v1/agents/42/pause",
      "POST /api/v1/agents/42/resume",
      "POST /api/v1/agents/42/terminate",
      "POST /api/v1/agents/42/resume",
    ])
  })

  test("pause --all / resume --all", async () => {
    const srv = fakeServer()

    const p = await sendGovernance("pause", { all: true, bloq: 550 }, srv.fetcher)
    expect("res" in p && (await p.res.json()).count).toBe(2)
    expect(Object.values(srv.agents)).toEqual(["paused_manual", "paused_manual"])

    await sendGovernance("resume", { all: true, bloq: 550 }, srv.fetcher)
    expect(Object.values(srv.agents)).toEqual(["healthy", "healthy"])
  })

  test("a refused request never reaches the network", async () => {
    const srv = fakeServer()
    const r = await sendGovernance("stop", { all: true, bloq: 550 }, srv.fetcher)
    expect(r).toHaveProperty("error")
    expect(srv.calls).toEqual([])
  })
})

describe("summarize", () => {
  test("single agent, with released approvals", () => {
    expect(summarize("resume", { agent: { id: 42, name: "Ops", health_status: "healthy" }, released_approvals: 2 }))
      .toBe("Agent #42 (Ops) resumed — status: healthy — 2 held approval(s) released")
  })

  test("workspace", () => {
    expect(summarize("pause", { bloq_id: 550, count: 3 })).toBe("3 agent(s) in bloq #550 paused")
  })
})
