import { describe, expect, test } from "bun:test"
import { mergeTranscript, replyMode, reportLine, summaryOf, type HiveSessionNode } from "./iris-hive-sessions-model"

const NOW = Date.parse("2026-10-14T22:00:00Z")
const m = (text: string) => ({ role: "user", type: "text", text, tool: null, at: null })
const node = (report: string, sessions: HiveSessionNode["sessions"] = []): HiveSessionNode => ({
  id: "n",
  name: "n",
  online: true,
  lastHeartbeat: null,
  report,
  reportedAt: new Date(NOW - 31 * 86_400_000).toISOString(),
  incomplete: [],
  sessions,
})
const s = (provider: string, status = "active", activity: string | null = null) => ({
  sessionId: "s",
  provider,
  label: "l",
  status,
  activity,
  model: null,
  branch: null,
  updatedAt: null,
  question: null,
})

describe("mergeTranscript", () => {
  test("incremental rows append; a page replaces", () => {
    expect(mergeTranscript([m("a")], [m("b")], true).map((x) => x.text)).toEqual(["a", "b"])
    expect(mergeTranscript([m("a")], [m("b")], false).map((x) => x.text)).toEqual(["b"])
  })
  test("capped to the newest", () => {
    expect(mergeTranscript([m("a"), m("b")], [m("c")], true, 2).map((x) => x.text)).toEqual(["b", "c"])
  })
})

describe("replyMode", () => {
  test("opencode replies in place; Claude Code goes to Claude; an old report offers nothing", () => {
    expect(replyMode(s("opencode"), node("fresh"))).toBe("reply")
    expect(replyMode(s("claude_code"), node("fresh"))).toBe("claude")
    expect(replyMode(s("codex"), node("fresh"))).toBe("none")
    expect(replyMode(s("opencode"), node("stale"))).toBe("stale")
    expect(replyMode(s("opencode", "unknown"), node("fresh"))).toBe("stale")
  })
})

describe("summary and report line", () => {
  test("working counts only MEASURED activity on a fresh machine", () => {
    const sum = summaryOf([node("fresh", [s("opencode", "active", "working"), s("opencode", "active")]), node("stale", [s("opencode", "unknown")])])
    expect(sum).toEqual({ sessions: 3, machines: 2, needs: 0, working: 1, staleMachines: 1 })
  })
  test("a stale list says it is not current", () => {
    expect(reportLine(node("stale"), NOW)).toEqual({ tone: "stale", text: "last report 31 days ago — not current" })
  })
})
