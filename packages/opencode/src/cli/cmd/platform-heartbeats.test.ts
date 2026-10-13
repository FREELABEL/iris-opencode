import { describe, expect, test } from "bun:test"
import raw from "../../../../pulse-core/test/fixtures/heartbeats.raw.json"
import { fetchHeartbeatRows, formatHeartbeatQuery, heartbeatQueryJson, parseStates } from "./platform-heartbeats"
import { queryHeartbeats } from "@heyiris/pulse-core"

// fl-api answers from the anonymised 18-heartbeat snapshot (#193, 2026-10-12): the list, then
// each job's executions — the same two calls Desktop's panel makes.
const jobs = raw.rows.map((r: any) => r.job)
const runsOf = new Map(raw.rows.map((r: any) => [String(r.job.id), r.runs]))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function flApi(opts: { list?: number; brokenRuns?: number } = {}) {
  const calls: string[] = []
  const get = async (path: string) => {
    calls.push(path)
    if (path === "/api/v1/users/193/bloqs/scheduled-jobs?agent_jobs_only=1")
      return opts.list ? json({ message: "Unauthenticated." }, opts.list) : json({ data: [...jobs, { id: 1, agent_id: null, task_name: "heartbeat", status: "scheduled" }] })
    const m = /scheduled-jobs\/(\d+)\/executions\?limit=50$/.exec(path)
    if (m && Number(m[1]) === opts.brokenRuns) return json({ message: "boom" }, 500)
    if (m) return json({ data: runsOf.get(m[1]) ?? [] })
    return json({}, 404)
  }
  return { get, calls }
}
const now = Date.parse(raw.capturedAt)

describe("fetchHeartbeatRows", () => {
  test("reads the live heartbeat jobs and each one's runs", async () => {
    const api = flApi()
    const res = await fetchHeartbeatRows(193, api.get)
    expect(res.measured).toBe(true)
    expect(res.rows.length).toBe(18) // the agentless job is not a heartbeat
    expect(res.rows.every((r) => r.runsMeasured)).toBe(true)
    expect(api.calls.filter((c) => c.includes("/executions")).length).toBe(18)
  })

  test("a list that cannot be read is NOT MEASURED, with fl-api's reason — never an empty fleet", async () => {
    const res = await fetchHeartbeatRows(193, flApi({ list: 401 }).get)
    expect(res).toMatchObject({ measured: false, rows: [] })
    expect(res.reason).toBe("fl-api 401: Unauthenticated.")
  })

  test("one job's runs failing leaves that row unread, not 'never ran'", async () => {
    const res = await fetchHeartbeatRows(193, flApi({ brokenRuns: jobs[0].id }).get)
    const row = res.rows.find((r) => r.jobId === jobs[0].id)!
    expect(row.runsMeasured).toBe(false)
    expect(res.rows.filter((r) => r.runsMeasured).length).toBe(17)
  })
})

describe("parseStates", () => {
  test("comma lists, any case; a state that does not exist is an error", () => {
    expect(parseStates("late,Silent , failing")).toEqual(["late", "silent", "failing"])
    expect(parseStates(undefined)).toBeUndefined()
    expect(() => parseStates("late,held")).toThrow(/held/)
  })
})

describe("output", () => {
  test("text leads with the counts of everything read, then one line per match", async () => {
    const { rows } = await fetchHeartbeatRows(193, flApi().get)
    const q = queryHeartbeats(rows, { now, states: ["failing"] })
    const text = formatHeartbeatQuery(q, { measured: true }).join("\n")
    expect(text).toContain("0 late")
    expect(text).toContain("6 silent")
    expect(text).toContain("Chief of Staff")
    expect(text).toContain("Newsroom Agent")
    expect(text).not.toContain("Lead Monitor")
  })

  test("not measured says so — it never prints a count", () => {
    const text = formatHeartbeatQuery(null, { measured: false, reason: "fl-api 401: Unauthenticated." }).join("\n")
    expect(text).toContain("not measured")
    expect(text).toContain("fl-api 401")
    expect(text).not.toMatch(/\b0 (late|silent|failing)/)
  })

  test("json is the query result without the raw rows — ids, state, since, line, problems", async () => {
    const { rows } = await fetchHeartbeatRows(193, flApi().get)
    const out = heartbeatQueryJson(queryHeartbeats(rows, { now, agents: ["Newsroom"] }), { measured: true })
    expect(out.measured).toBe(true)
    expect(out.counts?.failing).toBe(2)
    expect(out.matches).toEqual([
      expect.objectContaining({ jobId: 900, agentId: 702, agentName: "Newsroom Agent", state: "failing", since: expect.stringMatching(/^2026-10-12T19/) }),
    ])
    expect(out.matches[0].problems[0]).toHaveProperty("kind")
    expect(out.matches[0]).not.toHaveProperty("row")
    expect(heartbeatQueryJson(null, { measured: false, reason: "x" })).toEqual({ measured: false, reason: "x", now: null, counts: null, matches: [] })
  })
})
