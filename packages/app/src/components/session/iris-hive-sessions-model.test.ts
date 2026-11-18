import { describe, expect, test } from "bun:test"
import { continueText, mergeTranscript, replyAfter, replyMode, reportLine, shortAge, summaryOf, type HiveSessionNode } from "./iris-hive-sessions-model"

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
const s = (provider: string, status = "active", activity: string | null = null, readOnly: string | null = null) => ({
  sessionId: "s",
  provider,
  label: "l",
  status,
  activity,
  model: null,
  branch: null,
  updatedAt: null,
  question: null,
  readOnly,
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
  test("Claude Code, opencode and ACP talk; a read-only provider says so; an old report offers nothing", () => {
    expect(replyMode(s("opencode"), node("fresh"))).toBe("talk")
    expect(replyMode(s("claude_code"), node("fresh"))).toBe("talk")
    expect(replyMode(s("acp"), node("fresh"))).toBe("talk")
    expect(replyMode(s("codex", "active", null, "Codex sessions are listed, not driven"), node("fresh"))).toBe("readonly")
    expect(replyMode(s("opencode"), node("stale"))).toBe("stale")
    expect(replyMode(s("opencode", "unknown"), node("fresh"))).toBe("stale")
  })
})

describe("replyAfter — the reply to what we sent, as `iris hive ask` reads it", () => {
  const msg = (role: string, type: string, text: string | null, tool: string | null = null) => ({ role, type, text, tool, at: null })
  test("not landed yet: no anchor", () => {
    expect(replyAfter([msg("user", "text", "earlier")], "reply with the word pong")).toEqual({ anchored: false, answered: false, parts: [] })
  })
  test("anchors on the LAST matching user text (the bridge adds a prefix), then reads what follows", () => {
    const t = [
      msg("user", "text", "reply with the word pong"),
      msg("assistant", "text", "old pong"),
      msg("user", "text", "[via iris · hive] reply with the word pong"),
      msg("assistant", "tool_use", null, "bash"),
      msg("assistant", "text", "pong"),
    ]
    expect(replyAfter(t, "reply with the word pong")).toEqual({
      anchored: true,
      answered: true,
      parts: [
        { kind: "tool", text: "bash" },
        { kind: "text", text: "pong" },
      ],
    })
  })
  test("landed but no assistant text yet is not answered", () => {
    expect(replyAfter([msg("user", "text", "hi there")], "hi there")).toEqual({ anchored: true, answered: false, parts: [] })
  })
})

describe("shortAge", () => {
  test("the CLI's age column", () => {
    expect(shortAge(new Date(NOW - 15 * 60_000).toISOString(), NOW)).toBe("15m")
    expect(shortAge(new Date(NOW - 21 * 3_600_000).toISOString(), NOW)).toBe("21h")
    expect(shortAge(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe("2d")
    expect(shortAge(null, NOW)).toBe("—")
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

// #191492 — "Continue here": a chat from another machine, picked up as a new chat on this one.
describe("continueText", () => {
  const msg = (role: string, type: string, text: string | null, tool: string | null = null) => ({ role, type, text, tool, at: null })
  const from = { label: "Hive chat fixes verified under load", provider: "opencode", sessionId: "ses_e86c" }

  test("names where it came from, keeps the conversation in order, and says where it runs now", () => {
    const t = continueText(from, "Alexs-MacBook-Pro", [
      msg("user", "text", "fix the hive chat"),
      msg("assistant", "tool_use", "git status", "bash"),
      msg("assistant", "text", "Done: 23 tests pass."),
    ])
    expect(t).toContain('Continued from "Hive chat fixes verified under load" on Alexs-MacBook-Pro')
    expect(t).toContain("this chat runs here")
    expect(t.indexOf("User: fix the hive chat")).toBeLessThan(t.indexOf("· bash: git status"))
    expect(t.indexOf("· bash: git status")).toBeLessThan(t.indexOf("Assistant: Done: 23 tests pass."))
    expect(t.endsWith("Pick up where it left off.")).toBe(true)
  })

  test("drops the oldest entries to fit, and says so", () => {
    const many = Array.from({ length: 200 }, (_, i) => msg("user", "text", `entry ${i} ` + "x".repeat(100)))
    const t = continueText(from, "Mac", many, 3000)
    expect(t.length).toBeLessThanOrEqual(3000)
    expect(t).toMatch(/\(\d+ earlier entries not shown\)/)
    expect(t).toContain("entry 199")
    expect(t).not.toContain("entry 0 ")
  })

  test("skips empty entries", () => {
    const t = continueText(from, "Mac", [msg("assistant", "text", "  "), msg("user", "text", "hi")])
    expect(t).toContain("User: hi")
    expect(t).not.toContain("Assistant: \n")
  })
})
