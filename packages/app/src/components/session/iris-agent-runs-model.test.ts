import { describe, expect, test } from "bun:test"
import {
  bar,
  buildNode,
  callLabel,
  folded,
  FOLD_AFTER_MS,
  isActive,
  money,
  recentRoots,
  runRoots,
  runStats,
  splitRuns,
  taskTitle,
  toCall,
  visibleCalls,
  type RunMessage,
  type RunNode,
  type RunPart,
} from "./iris-agent-runs-model"

const tool = (id: string, name: string, state: RunPart["state"]): RunPart => ({ id, type: "tool", tool: name, state })
const assistant = (parts: RunPart[], extra: Partial<RunMessage["info"]> = {}): RunMessage => ({
  info: { role: "assistant", agent: "explore", modelID: "claude-haiku-5-5", cost: 0.01, time: { created: 1000, completed: 9000 }, ...extra },
  parts,
})

describe("toCall / callLabel", () => {
  test("a completed call keeps its title, times and output tail", () => {
    const c = toCall(tool("p1", "read", { status: "completed", title: "src/report.ts", input: { filePath: "/a/src/report.ts" }, output: "ok", time: { start: 1000, end: 1400 } }))
    expect(c).toMatchObject({ tool: "read", label: "src/report.ts", status: "done", start: 1000, end: 1400, result: "ok" })
  })
  test("a failed call carries its error as the result", () => {
    const c = toCall(tool("p2", "bash", { status: "error", input: { command: "npm test" }, error: "2 of 31 failing", time: { start: 1, end: 2 } }))
    expect(c).toMatchObject({ status: "failed", label: "npm test", result: "2 of 31 failing" })
  })
  test("a shell command that exits non-zero is failed, with its output as the result", () => {
    const c = toCall(tool("p3", "bash", { status: "completed", title: "ls ./missing-folder", input: { command: "ls ./missing-folder" }, output: "No such file or directory", metadata: { exit: 1 }, time: { start: 1, end: 12 } }))
    expect(c).toMatchObject({ status: "failed", result: "No such file or directory" })
    const ok = toCall(tool("p4", "bash", { status: "completed", title: "ls", input: {}, output: "a b", metadata: { exit: 0 }, time: { start: 1, end: 2 } }))
    expect(ok?.status).toBe("done")
  })
  test("text and step parts are not calls", () => {
    expect(toCall({ id: "t", type: "text" })).toBeUndefined()
    expect(toCall({ id: "s", type: "step-start" })).toBeUndefined()
  })
  test("without a title the label is the most telling argument; a path shows only its file name", () => {
    expect(callLabel("read", undefined, { filePath: "/Users/a/x/AgentsPane.vue" })).toBe("AgentsPane.vue")
    expect(callLabel("task", "", { description: "Find session reports", prompt: "long…" })).toBe("Find session reports")
    expect(callLabel("todowrite", undefined, {})).toBe("todowrite")
  })
})

describe("buildNode", () => {
  test("a run is the chat's latest turn: an old chat asked again counts from the new message", () => {
    const day = 24 * 60 * 60 * 1000
    const now = 10 * day
    const user = (t: number): RunMessage => ({ info: { role: "user", time: { created: t } }, parts: [] })
    const old = assistant([tool("o", "bash", { status: "completed", title: "old ls", input: {}, output: "", time: { start: now - 2 * day + 10, end: now - 2 * day + 20 } })], { cost: 0.5, time: { created: now - 2 * day + 5, completed: now - 2 * day + 30 } })
    const fresh = assistant([tool("n", "bash", { status: "running", title: "mdfind jimmy", input: {}, time: { start: now - 5000 } })], { cost: 0.001, time: { created: now - 9000 } })
    const oldKid = buildNode({ session: { id: "ok", time: { created: now - 2 * day + 12 } }, messages: [], working: false, retrying: false, children: [] })
    const newKid = buildNode({ session: { id: "nk", time: { created: now - 4000 } }, messages: [], working: true, retrying: false, children: [] })
    const n = buildNode({
      session: { id: "w", title: "Watching", cost: 0.501, time: { created: now - 2 * day } },
      messages: [user(now - 2 * day), old, user(now - 10000), fresh],
      working: true, retrying: false, children: [oldKid, newKid],
    })
    expect(n.start).toBe(now - 10000)
    expect(n.calls.map((c) => c.label)).toEqual(["mdfind jimmy"])
    expect(n.children.map((c) => c.id)).toEqual(["nk"])
    expect(n.cost).toBe(0.001)
  })
  const session = { id: "child", title: "Find session reports (@explore subagent)", parentID: "root", time: { created: 500, updated: 9000 } }
  const messages = [
    assistant([
      tool("a", "grep", { status: "completed", title: "report", input: {}, output: "", time: { start: 1000, end: 2000 } }),
      tool("b", "read", { status: "running", input: { filePath: "/x/report.ts" }, time: { start: 2100 } }),
    ]),
  ]
  test("names the agent and strips the sub-agent tag from the task", () => {
    const n = buildNode({ session, messages, working: true, retrying: false, children: [] })
    expect(n.agent).toBe("Explore")
    expect(n.task).toBe("Find session reports")
    expect(n.model).toBe("claude-haiku-5-5")
    expect(n.calls.map((c) => c.status)).toEqual(["done", "running"])
  })
  test("running while the session works; open-ended until it stops", () => {
    const n = buildNode({ session, messages, working: true, retrying: false, children: [] })
    expect(n.state).toBe("running")
    expect(n.end).toBeUndefined()
  })
  test("done when it stops; failed only when its last turn ended on an error, not on a recovered call", () => {
    expect(buildNode({ session, messages, working: false, retrying: false, children: [] }).state).toBe("done")
    const errored = [assistant(messages[0].parts, { error: { name: "MessageAbortedError" } })]
    expect(buildNode({ session, messages: errored, working: false, retrying: false, children: [] }).state).toBe("failed")
  })
  test("retry wins over running", () => {
    expect(buildNode({ session, messages, working: true, retrying: true, children: [] }).state).toBe("retry")
  })
  test("children are ordered by when they started", () => {
    const late = buildNode({ session: { id: "l", time: { created: 900 } }, messages: [], working: false, retrying: false, children: [] })
    const early = buildNode({ session: { id: "e", time: { created: 100 } }, messages: [], working: false, retrying: false, children: [] })
    const n = buildNode({ session: { id: "root", time: { created: 1 } }, messages: [], working: true, retrying: false, children: [late, early] })
    expect(n.children.map((c) => c.id)).toEqual(["e", "l"])
  })
})

const node = (id: string, state: RunNode["state"], extra: Partial<RunNode> = {}): RunNode => ({
  id, agent: id, task: id, state, cost: 0.01, calls: [], children: [], start: 0, ...extra,
})

describe("runs", () => {
  test("a run is Active while ANY agent in it works, even if the root is idle", () => {
    expect(isActive(node("r", "done", { children: [node("c", "running")] }))).toBe(true)
    expect(isActive(node("r", "done", { children: [node("c", "done")] }))).toBe(false)
  })
  test("stats add up across the whole tree", () => {
    const failed = { id: "x", tool: "bash", label: "npm test", status: "failed" as const, args: "", result: "" }
    const ok = { ...failed, id: "y", status: "done" as const }
    const s = runStats(node("r", "running", { calls: [ok], children: [node("c", "done", { calls: [failed, ok], end: 50 })] }))
    expect(s).toMatchObject({ agents: 2, running: 1, calls: 3, errors: 1, cost: 0.02 })
  })
  test("split: active newest-first above, finished runs below", () => {
    const { active, inactive } = splitRuns([
      node("old", "running", { start: 1 }),
      node("new", "running", { start: 5 }),
      node("gone", "done", { end: 10 }),
    ])
    expect(active.map((r) => r.id)).toEqual(["new", "old"])
    expect(inactive.map((r) => r.id)).toEqual(["gone"])
  })
  test("recent runs: top ancestors of sub-agents touched in the window, newest first; plain chats are not runs", () => {
    const day = 24 * 60 * 60 * 1000
    const now = 10 * day
    const sessions = [
      { id: "chat", time: { created: now - 1000, updated: now - 1000 } },
      { id: "run1", time: { created: now - 5000 } },
      { id: "kid1", parentID: "run1", time: { created: now - 4000, updated: now - 3000 } },
      { id: "grand", parentID: "kid1", time: { created: now - 2000, updated: now - 2000 } },
      { id: "run2", time: { created: now - 9000 } },
      { id: "kid2", parentID: "run2", time: { created: now - 8000, updated: now - 8000 } },
      { id: "old", time: { created: now - 3 * day } },
      { id: "oldkid", parentID: "old", time: { created: now - 3 * day, updated: now - 2 * day } },
    ]
    expect(recentRoots(sessions, now)).toEqual(["run1", "run2"])
  })
  test("roots are the top ancestors of working sessions, plus the open chat, without duplicates", () => {
    const info = (id: string) => ({ a: { id: "a" }, b: { id: "b", parentID: "a" }, c: { id: "c", parentID: "b" }, me: { id: "me" } })[id]
    expect(runRoots({ working: ["c", "b"], info, current: "me" })).toEqual(["a", "me"])
  })
})

describe("display rules", () => {
  test("a finished sub-agent keeps its box for a moment, then folds; a running one never folds", () => {
    const done = node("c", "done", { end: 1000 })
    expect(folded(done, 1000 + FOLD_AFTER_MS - 1)).toBe(false)
    expect(folded(done, 1000 + FOLD_AFTER_MS + 1)).toBe(true)
    expect(folded(node("r", "running"), 10 ** 9)).toBe(false)
  })
  test("only the newest calls show; the rest fold behind a count", () => {
    const calls = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, tool: "read", label: `${i}`, status: "done" as const, args: "", result: "" }))
    const v = visibleCalls(calls, false)
    expect(v.hidden).toBe(3)
    expect(v.shown.map((c) => c.id)).toEqual(["3", "4", "5", "6"])
    expect(visibleCalls(calls, true).hidden).toBe(0)
  })
  test("a bar sits where the call ran on its agent's timeline, never thinner than 4%", () => {
    const n = node("a", "done", { start: 0, end: 1000 })
    const call = { id: "c", tool: "read", label: "", status: "done" as const, args: "", result: "", start: 500, end: 501 }
    expect(bar(call, n, 2000)).toEqual({ left: 50, width: 4 })
    const whole = { ...call, start: 0, end: 1000 }
    expect(bar(whole, n, 2000)).toEqual({ left: 0, width: 100 })
  })
  test("a running call stretches to now", () => {
    const n = node("a", "running", { start: 0 })
    const call = { id: "c", tool: "bash", label: "", status: "running" as const, args: "", result: "", start: 500 }
    expect(bar(call, n, 1000)).toEqual({ left: 50, width: 50 })
  })
  test("money never shows a run that cost something as $0.000", () => {
    expect([money(0), money(0.0004), money(0.004), money(0.58)]).toEqual(["$0", "<$0.001", "$0.004", "$0.58"])
  })
  test("the sub-agent tag is stripped; an empty title says so", () => {
    expect(taskTitle("Lay out the pane (@general subagent)")).toBe("Lay out the pane")
    expect(taskTitle(undefined)).toBe("Untitled")
  })
})
