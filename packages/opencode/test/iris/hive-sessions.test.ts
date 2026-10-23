import { describe, expect, test } from "bun:test"
import { REPORT_FRESH_MS, REPLY_IN_PLACE, reportOf, sessionsFromNodes, transcriptOf } from "@/iris/hive-sessions"

// #189446 — Hive › Sessions. Node shape is fl-iris-api ComputeNodeController::formatNode.

const NOW = Date.parse("2026-10-14T22:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  provider: "opencode",
  name: "raw",
  label: "Fix the login page",
  status: "active",
  activity: "working",
  model: "iris/gpt-4.1-nano",
  git_branch: "main",
  updated_at: iso(60_000),
  project_path: "/Users/alex/private/project",
  ...extra,
})

const node = (extra: Record<string, unknown> = {}) => ({
  id: "n1",
  name: "MacBook",
  connection_status: "online",
  last_heartbeat_at: iso(30_000),
  sessions_updated_at: iso(30_000),
  active_sessions: [session("ses_1")],
  sessions_truncated: [],
  sessions_unreachable: [],
  ...extra,
})

describe("sessionsFromNodes", () => {
  test("a fresh machine's sessions keep their status and measured activity", () => {
    const [n] = sessionsFromNodes({ nodes: [node()] }, NOW)
    expect(n.report).toBe("fresh")
    expect(n.online).toBe(true)
    expect(n.sessions[0]).toMatchObject({
      sessionId: "ses_1",
      label: "Fix the login page",
      status: "active",
      activity: "working",
      model: "iris/gpt-4.1-nano",
      branch: "main",
    })
  })

  test("a machine that stopped reporting cannot say active — the 31-day MacBook", () => {
    const [n] = sessionsFromNodes({ nodes: [node({ sessions_updated_at: iso(31 * 86_400_000), connection_status: "offline" })] }, NOW)
    expect(n.report).toBe("stale")
    expect(n.sessions[0].status).toBe("unknown")
    expect(n.sessions[0].activity).toBeNull()
  })

  test("the server's own verdict wins when it sends one", () => {
    const [n] = sessionsFromNodes({ nodes: [node({ sessions_report: "stale" })] }, NOW)
    expect(n.report).toBe("stale")
    expect(n.sessions[0].status).toBe("unknown")
  })

  test("a local path with the OS username never leaves the sidecar", () => {
    const out = JSON.stringify(sessionsFromNodes({ nodes: [node()] }, NOW))
    expect(out).not.toContain("/Users/alex")
    expect(out).not.toContain("project_path")
  })

  test("a list cut at the cap or missing a provider says so", () => {
    const [n] = sessionsFromNodes({ nodes: [node({ sessions_truncated: ["claude_code"], sessions_unreachable: ["codex", "claude_code"] })] }, NOW)
    expect(n.incomplete).toEqual(["claude_code", "codex"])
  })

  test("the waiting question travels only on a fresh needs_you session", () => {
    const waiting = { kind: "question", questions: [{ question: "Deploy to prod?" }] }
    const [fresh] = sessionsFromNodes({ nodes: [node({ active_sessions: [session("a", { status: "needs_you", waiting })] })] }, NOW)
    expect(fresh.sessions[0].question).toBe("Deploy to prod?")
    const [old] = sessionsFromNodes(
      { nodes: [node({ sessions_updated_at: iso(REPORT_FRESH_MS + 1000), active_sessions: [session("a", { status: "needs_you", waiting })] })] },
      NOW,
    )
    expect(old.sessions[0].question).toBeNull()
  })

  test("rows without an id are dropped; a machine with nothing reported is 'never'", () => {
    const [n] = sessionsFromNodes({ nodes: [node({ sessions_updated_at: null, active_sessions: [{ name: "no id" }] })] }, NOW)
    expect(n.sessions).toEqual([])
    expect(n.report).toBe("never")
  })

  test("garbage in, empty out", () => {
    expect(sessionsFromNodes(null, NOW)).toEqual([])
    expect(sessionsFromNodes({ nodes: "x" }, NOW)).toEqual([])
  })
})

describe("reportOf", () => {
  test("same boundary as the server's REPORT_FRESH_S", () => {
    expect(reportOf(undefined, iso(REPORT_FRESH_MS), NOW)).toBe("fresh")
    expect(reportOf(undefined, iso(REPORT_FRESH_MS + 1), NOW)).toBe("stale")
    expect(reportOf(undefined, iso(-2 * REPORT_FRESH_MS), NOW)).toBe("unknown")
    expect(reportOf(undefined, null, NOW)).toBe("never")
  })
})

describe("transcriptOf", () => {
  test("rows, cursor, and whether they append", () => {
    const t = transcriptOf({
      ran_on: "MacBook",
      offset: 2048,
      incremental: true,
      messages: [
        { role: "user", type: "text", text: "fix it", timestamp: "2026-10-14T21:00:00Z" },
        { role: "assistant", type: "tool_use", tool: "edit" },
      ],
    })
    expect(t.ranOn).toBe("MacBook")
    expect(t.offset).toBe(2048)
    expect(t.incremental).toBe(true)
    expect(t.messages.map((m) => m.text ?? m.tool)).toEqual(["fix it", "edit"])
  })

  test("a reset means replace, even if the server also said incremental", () => {
    expect(transcriptOf({ incremental: true, reset: true, messages: [] }).incremental).toBe(false)
  })
})

describe("replies", () => {
  test("only providers whose reply lands in the open window", () => {
    expect(REPLY_IN_PLACE.has("opencode")).toBe(true)
    expect(REPLY_IN_PLACE.has("claude_code")).toBe(false)
  })
})
