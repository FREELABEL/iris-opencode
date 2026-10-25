import { describe, expect, test } from "bun:test"
import {
  REPORT_FRESH_MS,
  REPORT_WINDOW_MS,
  answerOutcome,
  answerTaskBody,
  askTaskBody,
  fleetFromNodes,
  labelOf,
  readOnlyReason,
  refusedAtCreate,
  reportOf,
  sessionsFromNodes,
  transcriptOf,
  waitingOf,
} from "@/iris/hive-sessions"

// #189446 — Hive › Sessions. Node shape is fl-iris-api ComputeNodeController::formatNode.

const NOW = Date.parse("2026-10-14T22:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  provider: "opencode",
  name: "Fix the login page",
  label: "server label, not used",
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

  test("a machine that stopped reporting cannot say active (a 2-day-quiet MacBook; past 7 days it is retired)", () => {
    const [n] = sessionsFromNodes({ nodes: [node({ sessions_updated_at: iso(2 * 86_400_000), connection_status: "offline" })] }, NOW)
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
    const waiting = { kind: "question", questions: [{ question: "Deploy to prod?", options: [{ label: "Yes" }, { label: "No" }] }] }
    const [fresh] = sessionsFromNodes({ nodes: [node({ active_sessions: [session("a", { status: "needs_you", waiting })] })] }, NOW)
    expect(fresh.sessions[0].question).toBe("Deploy to prod?")
    expect(fresh.sessions[0].questions).toEqual([{ question: "Deploy to prod?", header: null, options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] }])
    const [old] = sessionsFromNodes(
      { nodes: [node({ sessions_updated_at: iso(REPORT_FRESH_MS + 1000), active_sessions: [session("a", { status: "needs_you", waiting })] })] },
      NOW,
    )
    expect(old.sessions[0].question).toBeNull()
    expect(old.sessions[0].questions).toEqual([])
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

// #191171 — the same rows `iris hive sessions` prints (platform-hive-sessions.ts on main).
describe("parity with iris hive sessions", () => {
  test("an old record of a re-registered machine lists nothing, and is named with its row count", () => {
    const old = node({ id: "old", name: "MacBook", sessions_updated_at: iso(REPORT_WINDOW_MS + 60_000), active_sessions: [session("x"), session("y")] })
    const { nodes, retired } = fleetFromNodes({ nodes: [node(), old] }, NOW)
    expect(nodes.map((n) => n.id)).toEqual(["n1"])
    expect(retired).toEqual([{ name: "MacBook", rows: 2, at: iso(REPORT_WINDOW_MS + 60_000) }])
  })

  test("a session reported by two records is shown once, from the newest report", () => {
    const a = node({ id: "a", sessions_updated_at: iso(5 * 60_000), active_sessions: [session("dup"), session("only-a")] })
    const b = node({ id: "b", sessions_updated_at: iso(30_000), active_sessions: [session("dup")] })
    const { nodes } = fleetFromNodes({ nodes: [a, b] }, NOW)
    expect(nodes.find((n) => n.id === "a")!.sessions.map((s) => s.sessionId)).toEqual(["only-a"])
    expect(nodes.find((n) => n.id === "b")!.sessions.map((s) => s.sessionId)).toEqual(["dup"])
  })

  test("the same id under two providers is two sessions", () => {
    const n = node({ active_sessions: [session("same"), session("same", { provider: "claude_code" })] })
    expect(sessionsFromNodes({ nodes: [n] }, NOW)[0].sessions.map((s) => s.provider)).toEqual(["opencode", "claude_code"])
  })

  test("a node with no report time is kept: unknown is not old", () => {
    const n = node({ sessions_updated_at: null, last_heartbeat_at: null })
    expect(fleetFromNodes({ nodes: [n] }, NOW).nodes[0].sessions).toHaveLength(1)
  })

  test("labels are the CLI's: cleaned, cut at 46, unusable names fall back to folder · last 8", () => {
    expect(labelOf({ session_id: "s", name: "  Fix\tthe   login\u2500page  " })).toBe("Fix the login page")
    expect(labelOf({ session_id: "s", name: "x".repeat(60) })).toBe("x".repeat(45) + "…")
    expect(labelOf({ session_id: "abcdef0123456789", name: "\u2500\u2500\u2500", project_path: "/Users/alex/sites/freelabel" })).toBe("freelabel · 23456789")
    expect(labelOf({ session_id: "abcdef0123456789", name: "New session - 2026" })).toBe("? · 23456789")
  })

  test("waiting questions keep the agent's option numbers; malformed ones are dropped", () => {
    expect(waitingOf({ kind: "question", questions: [{ question: " Pick   one ", header: "Fruit", options: [{ label: "Apple" }, { label: " " }, { label: "Pear" }] }, { question: "" }] })).toEqual([
      { question: "Pick one", header: "Fruit", options: [{ n: 1, label: "Apple" }, { n: 3, label: "Pear" }] },
    ])
    expect(waitingOf({ kind: "permission", questions: [{ question: "x" }] })).toEqual([])
    expect(waitingOf(null)).toEqual([])
  })
})

describe("talking to a session", () => {
  test("Claude Code, opencode and ACP take messages; codex and ollama are read-only with a reason", () => {
    for (const p of ["claude_code", "opencode", "acp"]) expect(readOnlyReason(p)).toBeNull()
    expect(readOnlyReason("codex")).toContain("Codex")
    expect(readOnlyReason("ollama")).toContain("Ollama")
    const [n] = sessionsFromNodes({ nodes: [node({ active_sessions: [session("c", { provider: "codex" })] })] }, NOW)
    expect(n.sessions[0].readOnly).toContain("Codex")
  })

  test("ask is the CLI's session_message with submit", () => {
    expect(askTaskBody({ userId: 7, nodeId: "n1", sessionId: "s1", provider: "claude_code", label: "Deploy", message: "reply with the word pong", from: "hive" })).toEqual({
      user_id: 7,
      node_id: "n1",
      type: "session_message",
      title: "ask Deploy",
      prompt: "reply with the word pong",
      config: { session_id: "s1", provider: "claude_code", message: "reply with the word pong", from: "hive", submit: true },
    })
  })

  test("answer is the CLI's session_message with answers", () => {
    expect(answerTaskBody({ userId: 7, nodeId: "n1", sessionId: "abcdef0123456789", provider: "opencode", choices: ["2", "Pear"], from: "hive" })).toEqual({
      user_id: 7,
      node_id: "n1",
      type: "session_message",
      title: "answer 23456789",
      prompt: "2 | Pear",
      config: { session_id: "abcdef0123456789", provider: "opencode", answers: ["2", "Pear"], from: "hive" },
    })
  })

  test("a task the cloud failed at creation is a refusal, not a send", () => {
    expect(refusedAtCreate({ task: { status: "failed", result: { metadata: { reason: "is busy (CPU at 168%)" } } } })).toBe("is busy (CPU at 168%)")
    expect(refusedAtCreate({ task: { status: "pending" } })).toBeNull()
  })

  test("the node's last JSON line decides answered or refused; no terminal status is pending", () => {
    const done = answerOutcome("t", { status: "succeeded", result: { stdout: 'log\n{"delivered":"keystroke","answers":{"Which fruit?":"Pear"}}' } })
    expect(done).toEqual({ taskId: "t", status: "answered", via: "keystroke", answers: [{ question: "Which fruit?", answer: "Pear" }], error: null })
    expect(answerOutcome("t", { status: "failed", result: { stdout: '{"error":"not in tmux"}' } })).toMatchObject({ status: "refused", error: "not in tmux" })
    expect(answerOutcome("t", { status: "failed", error: "boom" })).toMatchObject({ status: "refused", error: "boom" })
    expect(answerOutcome("t", { status: "running" }).status).toBe("pending")
  })
})
