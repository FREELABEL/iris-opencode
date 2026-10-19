/**
 * `iris hive room` — one message, several sessions, one thread (eval #189927 gap 3).
 *
 * Every test here drives the real exported decisions with a mocked transport. No test sends to
 * a real session: the transport records what WOULD have been sent, and the assertions about
 * "nothing was sent" are made against that record.
 */
import { describe, test, expect } from "bun:test"
import {
  parseMention,
  resolveMention,
  resolveRoom,
  readReply,
  runRoom,
  roomExitCode,
  type RoomTransport,
  type Target,
} from "../../src/cli/cmd/platform-hive-room"

const ID_HERMES = "a1b2c3d4-0000-4000-8000-0000004e4e4e"
const ID_GROK = "a1b2c3d4-0000-4000-8000-000000009r0k"
const ID_CLAW1 = "a1b2c3d4-0000-4000-8000-0000000c1aw1"
const ID_CLAW2 = "a1b2c3d4-0000-4000-8000-0000000c1aw2"
const ID_OLD = "a1b2c3d4-0000-4000-8000-000000000o1d"

function sess(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: id,
    provider: "claude_code",
    name,
    status: "active",
    model: null,
    git_branch: null,
    project_path: null,
    updated_at: new Date().toISOString(),
    ...extra,
  }
}

const NODES = [
  {
    id: "node-1",
    name: "hive-001",
    active_sessions: [
      sess(ID_HERMES, "Hermes launch planning"),
      sess(ID_GROK, "Grokbot", { provider: "opencode" }),
      sess(ID_CLAW1, "OpenClaw frontend"),
    ],
  },
  {
    id: "node-2",
    name: "macbook",
    active_sessions: [
      sess(ID_CLAW2, "OpenClaw backend"),
      sess(ID_OLD, "Archivist", { status: "stale" }),
    ],
  },
]

describe("parseMention", () => {
  test("strips @ and whitespace", () => {
    expect(parseMention("@Hermes")).toBe("Hermes")
    expect(parseMention("  @@grok ")).toBe("grok")
    expect(parseMention(ID_GROK)).toBe(ID_GROK)
  })
})

describe("resolveMention", () => {
  test("full session id resolves by id", () => {
    const r = resolveMention(NODES, "@" + ID_CLAW2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.s.session_id).toBe(ID_CLAW2)
      expect(r.by).toBe("id")
      expect(r.node.name).toBe("macbook")
    }
  })

  test("id suffix (>=6) resolves, the send-input rule", () => {
    const r = resolveMention(NODES, "9r0k")
    // 4 chars: too short for a suffix, and not a name either
    expect(r.ok).toBe(false)
    const r2 = resolveMention(NODES, "0009r0k")
    expect(r2.ok && r2.s.session_id).toBe(ID_GROK)
  })

  test("exact name, case-insensitive", () => {
    const r = resolveMention(NODES, "@grokbot")
    expect(r.ok && r.s.session_id).toBe(ID_GROK)
    expect(r.ok && r.by).toBe("name")
  })

  test("unique partial name resolves", () => {
    const r = resolveMention(NODES, "@Hermes")
    expect(r.ok && r.s.session_id).toBe(ID_HERMES)
  })

  test("ambiguous name refuses and lists every candidate", () => {
    const r = resolveMention(NODES, "@OpenClaw")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous")
      expect(r.candidates.map((c) => c.s.session_id).sort()).toEqual([ID_CLAW1, ID_CLAW2].sort())
    }
  })

  test("an exact name beats partial matches of the same text", () => {
    const nodes = [{ id: "n", name: "n", active_sessions: [sess("x".repeat(36), "ops"), sess("y".repeat(36), "ops dashboard")] }]
    const r = resolveMention(nodes, "@ops")
    expect(r.ok && r.s.session_id).toBe("x".repeat(36))
  })

  test("unknown name refuses and lists the live sessions as candidates", () => {
    const r = resolveMention(NODES, "@Zeus")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("not_found")
      expect(r.candidates.length).toBe(4) // the stale one is not offered
      expect(r.candidates.some((c) => c.s.session_id === ID_OLD)).toBe(false)
    }
  })

  test("too-short partial is never a match", () => {
    const r = resolveMention(NODES, "@he")
    expect(r.ok).toBe(false)
  })

  test("a stale-only match is refused as stale, not sent and not 'not found'", () => {
    const byName = resolveMention(NODES, "@archivist")
    expect(byName.ok).toBe(false)
    if (!byName.ok) expect(byName.reason).toBe("stale")
    const byId = resolveMention(NODES, ID_OLD)
    expect(byId.ok).toBe(false)
    if (!byId.ok) expect(byId.reason).toBe("stale")
  })

  test("empty mention refuses", () => {
    const r = resolveMention(NODES, "@")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("empty")
  })
})

describe("resolveRoom", () => {
  test("two mentions of one session become one target", () => {
    const { targets, problems } = resolveRoom(NODES, ["@grokbot", ID_GROK])
    expect(problems).toEqual([])
    expect(targets.length).toBe(1)
    expect(targets[0].mentions).toEqual(["grokbot", ID_GROK])
  })

  test("one bad name is reported while the good ones still resolve", () => {
    const { targets, problems } = resolveRoom(NODES, ["@hermes", "@openclaw", "@grokbot"])
    expect(targets.length).toBe(2)
    expect(problems.map((p) => p.mention)).toEqual(["openclaw"])
  })
})

describe("readReply", () => {
  const done = (output: string, status = "completed") => ({ status, result: { output } })

  test("claude-code: response text is the reply", () => {
    const r = readReply(done(JSON.stringify({ response: "On it — moved to 10am.", model: "x", tokens_used: 5 })))
    expect(r).toEqual({ status: "replied", reply: "On it — moved to 10am.", error: null })
  })

  test("opencode live delivery: delivered, never a fabricated reply", () => {
    const r = readReply(done(JSON.stringify({ status: "delivered", response: null })))
    expect(r.status).toBe("delivered")
    expect(r.reply).toBeNull()
  })

  test("bridge error body is an error", () => {
    const r = readReply(done(JSON.stringify({ error: "Ollama session x not found" })))
    expect(r.status).toBe("error")
    expect(r.error).toContain("not found")
  })

  test("failed task carries stderr as the reason", () => {
    const r = readReply({ status: "failed", result: { output: "", stderr: "curl: (22) 401" } })
    expect(r.status).toBe("error")
    expect(r.error).toContain("401")
  })

  test("node-side timeout is a timeout", () => {
    expect(readReply({ status: "timeout", result: null }).status).toBe("timeout")
  })

  test("non-JSON output is passed through as the reply", () => {
    expect(readReply(done("plain words")).reply).toBe("plain words")
  })
})

/** A fake clock + scripted task store. `script[sessionId]` is either a send error, or the
 * task the hub returns once `afterMs` has elapsed. */
function fakeTransport(script: Record<string, { sendError?: string; afterMs?: number; task?: any; pollThrows?: boolean }>) {
  let clock = 0
  const sent: Array<{ session_id: string; node: string; message: string }> = []
  const born: Record<string, { sid: string; at: number }> = {}
  const t: RoomTransport = {
    async send(target: Target, message: string) {
      const sc = script[target.s.session_id] ?? {}
      if (sc.sendError) throw new Error(sc.sendError)
      sent.push({ session_id: target.s.session_id, node: target.node.name, message })
      const id = `task-${target.s.session_id.slice(-6)}`
      born[id] = { sid: target.s.session_id, at: clock }
      return id
    },
    async getTask(id: string) {
      const b = born[id]
      const sc = script[b.sid]
      if (sc.pollThrows) throw new Error("hub 502")
      if (sc.task && clock - b.at >= (sc.afterMs ?? 0)) return sc.task
      return { status: "running" }
    },
    async sleep(ms: number) {
      clock += ms
    },
    now: () => clock,
  }
  return { t, sent }
}

describe("runRoom", () => {
  const reply = (text: string) => ({ status: "completed", result: { output: JSON.stringify({ response: text }) } })

  test("fans out to every target and collects each reply", async () => {
    const { targets } = resolveRoom(NODES, ["@hermes", "@grokbot", ID_CLAW2])
    const { t, sent } = fakeTransport({
      [ID_HERMES]: { task: reply("Hermes: noted, 10am."), afterMs: 4000 },
      [ID_GROK]: { task: { status: "completed", result: { output: JSON.stringify({ status: "delivered", response: null }) } } },
      [ID_CLAW2]: { task: reply("Backend ready for 10am."), afterMs: 2000 },
    })
    const out = await runRoom(targets, "launch moved to 10am", t, { timeoutMs: 60_000, pollMs: 1000 })
    expect(sent.map((s) => s.session_id)).toEqual([ID_HERMES, ID_GROK, ID_CLAW2])
    expect(sent.every((s) => s.message === "launch moved to 10am")).toBe(true)
    expect(sent.find((s) => s.session_id === ID_CLAW2)!.node).toBe("macbook") // pinned to its node
    expect(out.map((r) => r.status)).toEqual(["replied", "delivered", "replied"])
    expect(out[0].reply).toBe("Hermes: noted, 10am.")
    expect(out[0].task_id).toBe(`task-${ID_HERMES.slice(-6)}`)
    expect(roomExitCode(out)).toBe(0)
  })

  test("one failure does not hide the others", async () => {
    const { targets } = resolveRoom(NODES, ["@hermes", "@grokbot", ID_CLAW2])
    const { t } = fakeTransport({
      [ID_HERMES]: { sendError: "HTTP 500 boom" },
      [ID_GROK]: { task: { status: "failed", result: { stderr: "curl: (22) The requested URL returned error: 401" } } },
      [ID_CLAW2]: { task: reply("still here") },
    })
    const out = await runRoom(targets, "m", t, { timeoutMs: 10_000, pollMs: 1000 })
    expect(out.map((r) => r.status)).toEqual(["error", "error", "replied"])
    expect(out[0].error).toContain("not sent")
    expect(out[0].task_id).toBeNull()
    expect(out[1].error).toContain("401")
    expect(out[2].reply).toBe("still here")
    expect(roomExitCode(out)).toBe(1)
  })

  test("a slow session times out on its own; the fast one still replies", async () => {
    const { targets } = resolveRoom(NODES, ["@hermes", ID_CLAW2])
    const { t } = fakeTransport({
      [ID_HERMES]: { task: reply("too late"), afterMs: 999_999 },
      [ID_CLAW2]: { task: reply("fast") },
    })
    const out = await runRoom(targets, "m", t, { timeoutMs: 5000, pollMs: 1000 })
    expect(out[0].status).toBe("timeout")
    expect(out[0].error).toContain("iris hive tasks get task-")
    expect(out[1].status).toBe("replied")
    expect(roomExitCode(out)).toBe(124)
  })

  test("a poll that throws is retried, not reported as the answer", async () => {
    const { targets } = resolveRoom(NODES, ["@hermes"])
    const { t } = fakeTransport({ [ID_HERMES]: { pollThrows: true } })
    const out = await runRoom(targets, "m", t, { timeoutMs: 3000, pollMs: 1000 })
    expect(out[0].status).toBe("timeout")
  })
})
