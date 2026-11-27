import { describe, expect, test } from "bun:test"
import { readSharedRoom, readSharedMessage, readSessionState, readSayResult, isShared, parseInviteToken, inviteTrouble, readPresence, readActivity, readCloudAgent, readChain } from "./shared-rooms"

// Shared workspaces (#194307): what Desktop draws for a room filed under an Atlas project.

describe("readSharedRoom", () => {
  test("reads project, owner, the caller's rights and the sessions the room delivers to", () => {
    const r = readSharedRoom({
      id: "r1",
      name: "pricing page",
      bloq_id: 958,
      project: { id: 958, name: "Pricing launch" },
      owner_name: "Alex",
      you: { role: "editor", can_post: true, can_stop: false, is_owner: false },
      participants: [{ agent_id: "session:ses_claude" }, { agent_id: "node:01a1" }, { agent_id: "7" }],
      messages_count: 12,
      updated_at: "2026-11-26T19:00:00Z",
    })
    expect(r).toEqual({
      id: "r1",
      name: "pricing page",
      project: { id: 958, name: "Pricing launch" },
      ownerName: "Alex",
      you: { role: "editor", canPost: true, canStop: false, isOwner: false },
      sessionIds: ["ses_claude"],
      messageCount: 12,
      updatedAt: "2026-11-26T19:00:00Z",
    })
  })

  test("a server without the room facts (#456 not deployed) still reads: project from bloq_id, rights unknown = safest", () => {
    const r = readSharedRoom({ id: "r2", name: "", bloq_id: 12, participants: [] })
    expect(r.project).toEqual({ id: 12, name: "Project" })
    expect(r.name).toBe("Untitled room")
    expect(r.you).toEqual({ role: null, canPost: false, canStop: false, isOwner: false })
  })

  test("a personal room is not shared", () => {
    expect(isShared(readSharedRoom({ id: "p", bloq_id: null }))).toBe(false)
    expect(isShared(readSharedRoom({ id: "s", project: { id: 1, name: "x" } }))).toBe(true)
  })
})

describe("readSharedMessage", () => {
  test("names people, and reads a Stop as an event rather than as someone talking", () => {
    expect(readSharedMessage({ id: "m1", sender_type: "user", sender_id: "2", sender_name: "Flo", content: "check the test", created_at: "t" })).toMatchObject({
      kind: "person",
      senderName: "Flo",
      senderId: "2",
      text: "check the test",
    })
    expect(readSharedMessage({ id: "m2", sender_type: "system", sender_name: "User", content: "Stopped by Alex.", metadata: { event: "room.stopped" } })).toMatchObject({
      kind: "event",
      senderName: "IRIS",
      text: "Stopped by Alex.",
    })
    expect(readSharedMessage({ id: "m3", sender_type: "agent", sender_name: "", content: "done" })).toMatchObject({ kind: "agent", senderName: "Agent" })
  })

  test("says which sessions a message reached", () => {
    expect(readSharedMessage({ id: "m", sender_type: "user", metadata: { delivered_to: ["ses_1"] } }).deliveredTo).toEqual(["ses_1"])
    expect(readSharedMessage({ id: "m", sender_type: "user" }).deliveredTo).toEqual([])
  })
})

describe("readSessionState", () => {
  test("reads where a session runs and whether that computer is on", () => {
    expect(readSessionState({ session_id: "s", provider: "claude-code", machine: "alex-mbp", online: false, last_seen: "2026-11-26T18:00:00Z" })).toEqual({
      sessionId: "s",
      provider: "claude-code",
      machine: "alex-mbp",
      online: false,
      lastSeen: "2026-11-26T18:00:00Z",
      hostUserId: null,
      hostName: null,
    })
    expect(readSessionState({ session_id: "s" })).toEqual({ sessionId: "s", provider: null, machine: null, online: false, lastSeen: null, hostUserId: null, hostName: null })
  })
})

describe("readSayResult", () => {
  test("tells held, parked and delivered apart, with the server's own words", () => {
    expect(readSayResult({ node_deliveries: [{ session_id: "s", task_id: "t" }] })).toMatchObject({ outcome: "delivered", delivered: 1 })
    expect(readSayResult({ node_deliveries: [{ session_id: "s", task_id: "t", parked: true }], delivery_note: "offline…" })).toMatchObject({ outcome: "parked", note: "offline…" })
    expect(readSayResult({ node_deliveries: [], delivery_held: true, delivery_note: "this minute" })).toMatchObject({ outcome: "held", note: "this minute" })
    expect(readSayResult({ node_deliveries: [] })).toMatchObject({ outcome: "saved", delivered: 0 })
    expect(readSayResult({ node_deliveries: [], agents_note: "owner" }).agentsNote).toBe("owner")
  })
})

import { readTranscriptEntry } from "./shared-rooms"
describe("readTranscriptEntry — the agent's side of a shared chat", () => {
  test("reads text turns and tool steps as the machine reports them", () => {
    expect(readTranscriptEntry({ role: "assistant", type: "text", text: "Fixed it.", timestamp: "2026-11-26T20:01:00Z" })).toEqual({
      role: "assistant",
      kind: "text",
      text: "Fixed it.",
      tool: null,
      detail: null,
      at: "2026-11-26T20:01:00Z",
    })
    expect(readTranscriptEntry({ role: "assistant", type: "tool_use", tool: "Edit", file_path: "src/pricing.ts", timestamp: "t" })).toMatchObject({
      kind: "tool",
      tool: "Edit",
      detail: "src/pricing.ts",
    })
    expect(readTranscriptEntry({ role: "assistant", type: "tool_use", tool: "Bash", command: "npm test" })).toMatchObject({ detail: "npm test", at: "" })
    expect(readTranscriptEntry({ role: "user", type: "text", text: "hi" }).role).toBe("user")
  })
})

describe("joining from an invite link", () => {
  test("takes the token out of a full link, a link with extras, or the bare token", () => {
    expect(parseInviteToken("https://heyiris.io/invite/AbC123xyz_-9")).toBe("AbC123xyz_-9")
    expect(parseInviteToken("  https://freelabel.net/invite/AbC123xyz9/?ref=x ")).toBe("AbC123xyz9")
    expect(parseInviteToken("AbC123xyz9")).toBe("AbC123xyz9")
  })
  test("refuses what is not an invite", () => {
    expect(parseInviteToken("")).toBeNull()
    expect(parseInviteToken("hello there")).toBeNull()
    expect(parseInviteToken("https://heyiris.io/p/pricing")).toBeNull()
    expect(parseInviteToken("abc")).toBeNull()
  })
  test("says why an invite was refused in plain words", () => {
    expect(inviteTrouble(410, {})).toMatch(/expired/)
    expect(inviteTrouble(403, {})).toMatch(/different email/)
    expect(inviteTrouble(404, {})).toMatch(/not valid/)
    expect(inviteTrouble(400, { error: "You cannot redeem your own share link" })).toMatch(/already in it/)
  })
})

describe("multiplayer rooms", () => {
  test("a session says whose computer runs it, and an older server reads as unknown", () => {
    const s = readSessionState({ session_id: "ses_flo", provider: "acp", machine: "flo-laptop", online: true, host_user_id: 2, host_name: "Flo Rivera" })
    expect(s.hostUserId).toBe(2)
    expect(s.hostName).toBe("Flo Rivera")
    const old = readSessionState({ session_id: "ses_a", machine: "alex-mbp", online: true })
    expect(old.hostUserId).toBeNull()
    expect(old.hostName).toBeNull()
  })
  test("presence: active unless it says background, typing only when it says so", () => {
    expect(readPresence({ user_id: 2, name: "Flo", state: "active", typing: true })).toEqual({ userId: 2, name: "Flo", state: "active", typing: true })
    expect(readPresence({ user_id: 3, name: "Maya", state: "background" })).toEqual({ userId: 3, name: "Maya", state: "background", typing: false })
    expect(readPresence({}).name).toBe("Someone")
  })
})

describe("a room's row (#194490)", () => {
  test("reads who is here, the latest agent step, unread and working", () => {
    const a = readActivity({
      present: [{ user_id: 2, name: "Flo", state: "active", typing: false }],
      last: { kind: "agent", host_user_id: 2, host_name: "Flo Rivera", provider: "acp", is_you: false, text: "", tool: "Edit", detail: "emails/launch.md", at: "2026-11-27T12:00:00Z" },
      unread: 3,
      working: true,
    })
    expect(a.present[0].name).toBe("Flo")
    expect(a.last?.kind).toBe("agent")
    expect(a.unread).toBe(3)
    expect(a.working).toBeTrue()
  })
  test("an older server reads as no activity, and junk as nothing", () => {
    expect(readSharedRoom({ id: "r", name: "x" }).activity).toBeUndefined()
    expect(readActivity({ unread: -4, last: { kind: "person", text: "hi", at: "t" } })).toEqual({
      present: [],
      last: { kind: "person", name: "Someone", isYou: false, text: "hi", at: "t" },
      unread: 0,
      working: false,
    })
  })
})

describe("cloud agents in a room (#194496)", () => {
  test("reads an agent's model from wherever the agent keeps it, and its role in the room", () => {
    expect(readCloudAgent({ id: 7, name: "Researcher", config: { model: "gpt-4.1-nano" }, pivot: { role: "lead", auto_respond: false } })).toEqual({
      id: "7", name: "Researcher", model: "gpt-4.1-nano", role: "lead", autoRespond: false,
    })
    expect(readCloudAgent({ id: 8, settings: { model: "claude-haiku" } }).model).toBe("claude-haiku")
    expect(readCloudAgent({ id: 9 }).name).toBe("Agent 9")
  })
  test("reads the hand-off chain, or nothing", () => {
    expect(readChain({ depth: 2, turns: 3, max_turns: 6, max_hops: 3 })).toEqual({ depth: 2, turns: 3, maxTurns: 6, maxHops: 3 })
    expect(readChain(null)).toBeNull()
  })
})
