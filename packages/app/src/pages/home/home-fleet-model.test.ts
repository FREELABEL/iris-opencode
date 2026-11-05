import { describe, expect, test } from "bun:test"
import type { HiveSession, HiveSessionNode } from "@/components/session/iris-hive-sessions-model"
import { byTool, fleetOf } from "./home-fleet-model"

const session = (id: string, over: Partial<HiveSession> = {}): HiveSession => ({
  sessionId: id,
  provider: "claude_code",
  label: `session ${id}`,
  status: "active",
  activity: null,
  model: null,
  branch: null,
  updatedAt: "2026-11-05T12:00:00Z",
  question: null,
  ...over,
})
const node = (id: string, sessions: HiveSession[], over: Partial<HiveSessionNode> = {}): HiveSessionNode => ({
  id,
  name: id,
  online: true,
  lastHeartbeat: null,
  report: "fresh",
  reportedAt: null,
  incomplete: [],
  sessions,
  ...over,
})

describe("fleetOf (#192626)", () => {
  test("lists live sessions from every machine, each with its tool and machine", () => {
    const f = fleetOf({
      measured: true,
      nodes: [
        node("iris-hive-001", [session("a")]),
        node("iris-hive-002", [session("b", { provider: "codex", status: "idle" })]),
      ],
    })
    expect(f.rows.map((r) => [r.sessionId, r.tool, r.machine])).toEqual([
      ["a", "Claude Code", "iris-hive-001"],
      ["b", "Codex", "iris-hive-002"],
    ])
    expect(f.machines).toBe(2)
    expect(f.tools).toEqual(["Claude Code", "Codex"])
  })

  test("stale rows and machines with an old report are counted, not listed", () => {
    const f = fleetOf({
      measured: true,
      nodes: [
        node("live", [session("a"), session("old", { status: "stale" })]),
        node("asleep", [session("x", { status: "unknown" }), session("y", { status: "active" })], { report: "stale" }),
      ],
    })
    expect(f.rows.map((r) => r.sessionId)).toEqual(["a"])
    expect(f.hidden).toBe(3)
    expect(f.machines).toBe(1)
  })

  test("needs you first, then working, active, idle; newest first within each", () => {
    const f = fleetOf({
      measured: true,
      nodes: [
        node("m1", [session("idle", { status: "idle", updatedAt: "2026-11-05T12:30:00Z" }), session("active-old", { updatedAt: "2026-11-05T10:00:00Z" })]),
        node("m2", [
          session("active-new", { updatedAt: "2026-11-05T11:00:00Z" }),
          session("working", { activity: "working", updatedAt: "2026-11-05T09:00:00Z" }),
          session("asks", { status: "needs_you", updatedAt: "2026-11-05T08:00:00Z" }),
        ]),
      ],
    })
    expect(f.rows.map((r) => r.sessionId)).toEqual(["asks", "working", "active-new", "active-old", "idle"])
  })

  test("a detached HEAD is not shown as a branch", () => {
    const f = fleetOf({ measured: true, nodes: [node("m", [session("a", { branch: "HEAD" }), session("b", { branch: "main" })])] })
    expect(f.rows.map((r) => r.branch)).toEqual([null, "main"])
  })

  test("nothing read yet is an empty list, not an error", () => {
    expect(fleetOf(undefined)).toEqual({ rows: [], hidden: 0, machines: 0, tools: [] })
  })

  test("byTool filters by the tool's name; null keeps everything", () => {
    const { rows } = fleetOf({ measured: true, nodes: [node("m", [session("a"), session("b", { provider: "opencode" })])] })
    expect(byTool(rows, "IRIS / opencode").map((r) => r.sessionId)).toEqual(["b"])
    expect(byTool(rows, null)).toHaveLength(2)
  })
})
