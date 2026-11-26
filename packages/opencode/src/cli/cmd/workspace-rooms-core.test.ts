import { describe, expect, test } from "bun:test"
import {
  roomSessions,
  unseen,
  formatLine,
  openRoomBody,
  parseProjectId,
  HARNESS_HINT,
  sessionLines,
} from "./workspace-rooms-core"

describe("workspace rooms — shared workspaces on Atlas projects (#194307)", () => {
  test("a room's sessions are its session: participants, in order, nothing else", () => {
    const parts = [
      { agent_id: "session:ses_claude" },
      { agent_id: "node:01a1" },
      { agent_id: "42" },
      { agent_id: "session:acp_codex" },
      { agent_id: null },
    ]
    expect(roomSessions(parts)).toEqual(["ses_claude", "acp_codex"])
    expect(roomSessions(undefined)).toEqual([])
  })

  test("watch prints each message once, oldest first, across overlapping polls", () => {
    const seen = new Set<string>()
    const first = unseen(seen, [{ id: "b", created_at: "2026-11-26T10:00:02Z" }, { id: "a", created_at: "2026-11-26T10:00:01Z" }])
    expect(first.map((m) => m.id)).toEqual(["a", "b"])
    const second = unseen(seen, [{ id: "c", created_at: "2026-11-26T10:00:03Z" }, { id: "b", created_at: "2026-11-26T10:00:02Z" }])
    expect(second.map((m) => m.id)).toEqual(["c"])
    expect(unseen(seen, [])).toEqual([])
  })

  test("a line names who spoke, and a Stop reads as an event, not as someone talking", () => {
    expect(formatLine({ sender_type: "user", sender_name: "Flo", content: "check the test", created_at: "2026-11-26T15:04:00Z" }, "UTC"))
      .toBe("15:04  Flo: check the test")
    expect(formatLine({ sender_type: "system", content: "Stopped by Alex.", created_at: "2026-11-26T15:05:00Z" }, "UTC"))
      .toBe("15:05  — Stopped by Alex.")
    expect(formatLine({ sender_type: "agent", sender_name: "", content: "done", created_at: "2026-11-26T15:06:00Z" }, "UTC"))
      .toBe("15:06  agent: done")
  })

  test("opening a room with a session links it as an always-on receiver, so members reach it without @mentions", () => {
    expect(openRoomBody({ name: "pricing-page", sessionId: "ses_1" })).toEqual({
      name: "pricing-page",
      agent_ids: ["session:ses_1"],
      agent_roles: ["participant"],
      auto_respond: [true],
    })
  })

  test("a project is an Atlas project id; anything else is refused in words", () => {
    expect(parseProjectId("652")).toBe(652)
    expect(parseProjectId(" 12 ")).toBe(12)
    for (const bad of ["", "abc", "0", "-3", "1.5", undefined]) expect(parseProjectId(bad as any)).toBeNull()
  })

  test("the harness hint names every harness a shared room can steer today", () => {
    for (const h of ["Claude Code", "opencode", "Codex", "Gemini", "iris acp run --keep"]) expect(HARNESS_HINT).toContain(h)
  })
  test("each session says where it runs and, when the machine is asleep, since when", () => {
    const now = new Date("2026-11-26T18:00:00Z")
    expect(
      sessionLines(
        [
          { session_id: "ses_1", provider: "claude-code", machine: "alex-mbp", online: true, last_seen: "2026-11-26T17:59:40Z" },
          { session_id: "acp_2", provider: "acp", machine: "flo-pc", online: false, last_seen: "2026-11-26T16:20:00Z" },
          { session_id: "ses_3", provider: null, machine: null, online: false, last_seen: null },
        ],
        now,
      ),
    ).toEqual([
      "Claude Code on alex-mbp · online",
      "Codex/Gemini (ACP) on flo-pc · offline for 1 h 40 min — messages wait until it is back",
      "a session no computer reports right now",
    ])
    expect(sessionLines(undefined, now)).toEqual(["no live session in this room"])
  })
})
