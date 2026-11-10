import { describe, expect, test } from "bun:test"
import { answerArgs, bridgeErrorText, fleetArgs, parseFleet, waitLoop, waitParams, waitPollArgs, waitingOf } from "../../src/cli/cmd/mcp-hive"

describe("hive_sessions reads the fleet the way the CLI does (#191981)", () => {
  test("runs iris hive sessions --json, with a status or --all", () => {
    expect(fleetArgs({})).toEqual(["hive", "sessions", "--json"])
    expect(fleetArgs({ status: "needs_you" })).toEqual(["hive", "sessions", "--json", "--status", "needs_you"])
    expect(fleetArgs({ all: true })).toEqual(["hive", "sessions", "--json", "--all"])
  })
  test("a status that is not one of the CLI's is dropped, never passed through as argv", () => {
    expect(fleetArgs({ status: "active; rm -rf /" })).toEqual(["hive", "sessions", "--json"])
    expect(fleetArgs({ status: 3, all: "yes" })).toEqual(["hive", "sessions", "--json"])
  })
  test("parses the CLI's JSON, even after a warning line", () => {
    const rows = [{ session_id: "a", provider: "claude_code", node: "iris-hive-001", status: "active" }]
    expect(parseFleet(JSON.stringify(rows))).toEqual({ rows })
    expect(parseFleet("iris: the local daemon is not running\n" + JSON.stringify(rows))).toEqual({ rows })
  })
  test("anything else is an error that says what came back, not an empty fleet", () => {
    expect(parseFleet("")).toEqual({ error: "iris hive sessions printed nothing" })
    expect(parseFleet("Not signed in")).toEqual({ error: "Not signed in" })
    expect(parseFleet("[not json")).toEqual({ error: "iris hive sessions returned output that is not JSON" })
  })
})

describe("a failed bridge call says why (#191981)", () => {
  test("no tmux reads as no tmux, and points at the fleet command — not as a dead bridge", () => {
    const text = bridgeErrorText(503, "Service Unavailable", { error: "tmux not available" }, "does-not-exist")
    expect(text).toContain("tmux is not installed on this machine")
    expect(text).toContain("hive send-input")
    expect(text).not.toContain("503")
  })
  test("a missing session says so", () => {
    expect(bridgeErrorText(404, "Not Found", { error: "session not found" }, "x")).toBe(
      'No tmux session named "x" on this machine. (session not found)',
    )
  })
  test("anything else keeps the status and adds the bridge's own words", () => {
    expect(bridgeErrorText(500, "Internal Server Error", { error: "boom" })).toBe("Bridge error: 500 Internal Server Error — boom")
    expect(bridgeErrorText(502, "Bad Gateway", null)).toBe("Bridge error: 502 Bad Gateway")
  })
  test("401 keeps the rotated-key advice", () => {
    expect(bridgeErrorText(401, "Unauthorized", null)).toContain("bridge-token rotates on restart")
  })
})

describe("hive_wait — a session needs you, as a call that returns (#193064)", () => {
  const row = (id: string, extra: any = {}) => ({ session_id: id, node: "iris-hive-002", provider: "claude_code", status: "needs_you", label: "fix the build", ...extra })
  test("timeout defaults to 60 s and is clamped to 0..600; seen and node are kept only when well-formed", () => {
    expect(waitParams({}).timeoutMs).toBe(60_000)
    expect(waitParams({ timeout_s: 9999 }).timeoutMs).toBe(600_000)
    expect(waitParams({ timeout_s: -5 }).timeoutMs).toBe(0)
    expect([...waitParams({ seen: ["a", 3, "b"] }).seen]).toEqual(["a", "b"])
    expect(waitParams({ node: "iris-hive-002" }).node).toBe("iris-hive-002")
    expect(waitParams({ node: "x; rm -rf" }).node).toBeUndefined()
  })
  test("polls only waiting sessions, on one machine when asked", () => {
    expect(waitPollArgs()).toEqual(["hive", "sessions", "--json", "--status", "needs_you"])
    expect(waitPollArgs("iris-hive-001")).toEqual(["hive", "sessions", "--json", "--status", "needs_you", "--node", "iris-hive-001"])
  })
  test("returns each waiting session with its questions numbered as the agent shows them, and how to answer", () => {
    const w = waitingOf(
      [
        row("s1", { waiting: { kind: "question", asked_at: "t", questions: [{ header: "PHI", question: "Which  fix?", options: [{ label: "A" }, { label: " " }, { label: "Leave it" }] }] } }),
        row("s2", { status: "active" }),
      ],
      new Set(),
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ session_id: "s1", node: "iris-hive-002", provider: "claude_code", name: "fix the build", asked_at: "t" })
    expect(w[0].questions).toEqual([{ header: "PHI", question: "Which fix?", options: [{ n: 1, label: "A" }, { n: 3, label: "Leave it" }] }])
    expect(w[0].answer_with).toContain('hive_answer {session_id: "s1"')
  })
  test("a session already handled is not handed back", () => {
    expect(waitingOf([row("s1"), row("s2")], new Set(["s1"])).map((x) => x.session_id)).toEqual(["s2"])
  })
})

describe("hive_answer builds the iris hive answer argv (#193064)", () => {
  test("one choice per question, numbers or words", () => {
    expect(answerArgs({ session_id: "abc-123", choices: ["1", 2, "ship it"] })).toEqual({ args: ["hive", "answer", "--json", "abc-123", "1", "2", "ship it"] })
  })
  test("refuses what the CLI would misread or that is not an answer", () => {
    expect(answerArgs({ choices: ["1"] })).toMatchObject({ error: expect.stringContaining("session_id") })
    expect(answerArgs({ session_id: "a b", choices: ["1"] })).toMatchObject({ error: expect.stringContaining("session_id") })
    expect(answerArgs({ session_id: "a", choices: [] })).toMatchObject({ error: expect.stringContaining("choices") })
    expect(answerArgs({ session_id: "a", choices: ["1", " "] })).toMatchObject({ error: expect.stringContaining("non-empty") })
    expect(answerArgs({ session_id: "a", choices: ["--json"] })).toMatchObject({ error: expect.stringContaining("'-'") })
    expect(answerArgs({ session_id: "a", choices: ["1", "2", "3", "4", "5"] })).toMatchObject({ error: expect.stringContaining("at most 4") })
  })
})

describe("hive_wait waits the time it was asked (#193064)", () => {
  // A fake clock: each poll takes `pollMs`, sleep advances time exactly.
  const clock = (pollMs: number) => {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => void (t += ms), polled: [] as number[], tick: () => (t += pollMs) }
  }
  test("asked for 12 s with nothing waiting, it keeps polling until 12 s have passed — not 7", async () => {
    const c = clock(2000)
    const out = await waitLoop(async () => (c.polled.push(c.now()), c.tick(), { rows: [] }), { timeoutMs: 12_000, everyMs: 5000, now: c.now, sleep: c.sleep })
    expect(out).toMatchObject({ waiting: [], timed_out: true })
    expect(c.now()).toBeGreaterThanOrEqual(12_000)
    expect(c.now()).toBeLessThan(12_000 + 2000 + 1) // overshoots by at most one poll
  })
  test("returns at the first poll that finds someone waiting", async () => {
    const c = clock(1000)
    let n = 0
    const out = await waitLoop(async () => (c.tick(), ++n < 3 ? { rows: [] } : { rows: [{ session_id: "s9", status: "needs_you" }] }), {
      timeoutMs: 60_000, everyMs: 5000, now: c.now, sleep: c.sleep,
    })
    expect("waiting" in out && out.waiting.map((w: any) => w.session_id)).toEqual(["s9"])
    expect(n).toBe(3)
  })
  test("timeout 0 polls exactly once", async () => {
    const c = clock(500)
    let n = 0
    await waitLoop(async () => (n++, c.tick(), { rows: [] }), { timeoutMs: 0, everyMs: 5000, now: c.now, sleep: c.sleep })
    expect(n).toBe(1)
  })
  test("a fleet that cannot be read is reported, but one good poll clears an earlier error", async () => {
    const c = clock(100)
    const bad = await waitLoop(async () => (c.tick(), { error: "Not signed in" }), { timeoutMs: 1000, everyMs: 400, now: c.now, sleep: c.sleep })
    expect(bad).toMatchObject({ error: "Not signed in" })
    let n = 0
    const ok = await waitLoop(async () => (c.tick(), ++n === 1 ? { error: "blip" } : { rows: [] }), { timeoutMs: 1000, everyMs: 400, now: c.now, sleep: c.sleep })
    expect(ok).toMatchObject({ timed_out: true })
  })
})
