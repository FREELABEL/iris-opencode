import { describe, expect, test } from "bun:test"
import {
  roomSessions,
  unseen,
  formatLine,
  openRoomBody,
  parseProjectId,
  HARNESS_HINT,
  sessionLines,
  parseAgentIds,
  createRoomBody,
  readRoomChain,
  chainLine,
  presentLine,
  agentLines,
  roleUpdateBody,
  readRoomRow,
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

describe("multi-agent rooms — a lead, teammates, hand-offs (#194603)", () => {
  test("agent ids are the numbers `iris agents list` shows; anything else is refused in words", () => {
    expect(parseAgentIds("101, 102,101")).toEqual({ ids: ["101", "102"] })
    expect(parseAgentIds(["101", "103"])).toEqual({ ids: ["101", "103"] })
    expect(parseAgentIds("101,abc")).toEqual({ error: expect.stringContaining('"abc" is not an agent id') })
  })

  test("a room with agents has exactly one lead, and a lead named on its own joins too", () => {
    expect(createRoomBody({ name: "Launch", agents: ["101", "102"], lead: "102" })).toEqual({
      name: "Launch",
      agent_ids: ["101", "102"],
      agent_roles: ["participant", "lead"],
      auto_respond: [false, false],
    })
    expect(createRoomBody({ name: "Launch", agents: ["102"], lead: "101", alwaysOn: true })).toEqual({
      name: "Launch",
      agent_ids: ["101", "102"],
      agent_roles: ["lead", "participant"],
      auto_respond: [true, true],
    })
  })

  test("a live chat and agents side by side: the chat always receives, agents wait for @mentions", () => {
    expect(createRoomBody({ name: "x", agents: ["101"], lead: "101", sessionId: "ses_1" })).toEqual({
      name: "x",
      agent_ids: ["session:ses_1", "101"],
      agent_roles: ["participant", "lead"],
      auto_respond: [true, false],
    })
    // The session-only room is exactly what `open --session` always sent.
    expect(createRoomBody({ name: "pricing-page", sessionId: "ses_1" })).toEqual(openRoomBody({ name: "pricing-page", sessionId: "ses_1" }))
  })

  test("an empty room, or a lead that is not an id, is refused before any call", () => {
    expect(createRoomBody({ name: "x" })).toEqual({ error: expect.stringContaining("--agents") })
    expect(createRoomBody({ name: "x", agents: ["1"], lead: "planner" })).toEqual({ error: '"planner" is not an agent id.' })
  })

  test("the chain reads as agents talking, N of the room's limit; no chain, no line", () => {
    expect(chainLine(readRoomChain({ depth: 1, turns: 3, max_turns: 6, max_hops: 3 }))).toBe("agents are talking · 3 of 6")
    expect(chainLine(readRoomChain(null))).toBeNull()
    expect(readRoomChain({ turns: "3" })).toEqual({ depth: 0, turns: 0, maxTurns: 0, maxHops: 0 })
  })

  test("who is here: typing beats away; nobody is no line", () => {
    expect(presentLine([{ name: "Flo", away: true, typing: true }, { name: "Mo", away: true, typing: false }, { name: "Al", away: false, typing: false }]))
      .toBe("here: Flo (typing…), Mo (away), Al")
    expect(presentLine([])).toBeNull()
  })

  test("the lead is listed first; other roles are named", () => {
    expect(agentLines([
      { id: "1", name: "Ana", role: "participant", alwaysOn: true },
      { id: "2", name: "Ben", role: "lead", alwaysOn: false },
      { id: "3", name: "Cy", role: "observer", alwaysOn: false },
    ])).toEqual([
      "Ben — lead (takes your request first, hands parts to the others)",
      "Ana — answers everything",
      "Cy — answers when @mentioned · observer",
    ])
  })

  test("a role change sends only what was asked for", () => {
    expect(roleUpdateBody({ role: "lead" })).toEqual({ role: "lead" })
    expect(roleUpdateBody({ role: "participant", alwaysOn: false })).toEqual({ role: "participant", auto_respond: false })
    expect(roleUpdateBody({ alwaysOn: null })).toEqual({})
  })

  test("a list row from a server without activity still reads: nothing here, nothing unread", () => {
    expect(readRoomRow({ id: "r", name: "old", participants: [{ agent_id: "session:s1" }] })).toEqual({
      id: "r", name: "old", sessions: ["s1"], agents: [], messages: null, present: [], unread: 0, working: false, last: null,
    })
  })
})
