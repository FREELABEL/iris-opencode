import { describe, expect, test } from "bun:test"
import {
  groupByProject,
  sessionLine,
  initials,
  ago,
  sayNote,
  canStopNow,
  composerHint,
  type SharedRoom,
  type SharedMessage,
  roleWords,
  homeSharedRows,
} from "./iris-shared-rooms-model"

const room = (over: Partial<SharedRoom>): SharedRoom => ({
  id: "r",
  name: "room",
  project: { id: 1, name: "Pricing launch" },
  ownerName: "Alex",
  you: { role: "editor", canPost: true, canStop: false, isOwner: false },
  sessionIds: ["s1"],
  ...over,
})
const NOW = new Date("2026-11-26T20:00:00Z")

describe("shared rooms — what the Desktop panel draws (#194307)", () => {
  test("rooms are grouped under their project, the most recently active project first, newest room first", () => {
    const g = groupByProject([
      room({ id: "a", project: { id: 1, name: "Pricing launch" }, updatedAt: "2026-11-26T18:00:00Z" }),
      room({ id: "b", project: { id: 2, name: "Client: Vanguard" }, updatedAt: "2026-11-26T19:30:00Z" }),
      room({ id: "c", project: { id: 1, name: "Pricing launch" }, updatedAt: "2026-11-26T19:00:00Z" }),
    ])
    expect(g.map((x) => x.project.name)).toEqual(["Client: Vanguard", "Pricing launch"])
    expect(g[1].rooms.map((r) => r.id)).toEqual(["c", "a"])
  })

  test("a session line says what runs where, and how long a sleeping computer has been away", () => {
    expect(sessionLine({ sessionId: "s", provider: "claude-code", machine: "alex-mbp", online: true, lastSeen: null }, NOW)).toEqual({
      tone: "live",
      text: "Claude Code on alex-mbp",
      detail: "online",
    })
    expect(sessionLine({ sessionId: "s", provider: "acp", machine: "flo-pc", online: false, lastSeen: "2026-11-26T18:20:00Z" }, NOW)).toEqual({
      tone: "away",
      text: "Codex / Gemini on flo-pc",
      detail: "asleep for 1 h 40 min — messages wait for it",
    })
    expect(sessionLine({ sessionId: "s", provider: null, machine: null, online: false, lastSeen: null }, NOW).tone).toBe("gone")
    expect(sessionLine({ sessionId: "s", provider: "claude-code", machine: "m", online: false, lastSeen: "2026-11-26T19:59:30Z" }, NOW).detail).toBe(
      "just went to sleep — messages wait for it",
    )
  })

  test("initials for a person, never more than two letters, never empty", () => {
    expect(initials("Alex Mayo")).toBe("AM")
    expect(initials("flo")).toBe("F")
    expect(initials("  ")).toBe("?")
    expect(initials("Mary Ann Lee")).toBe("ML")
  })

  test("times read like a person says them", () => {
    expect(ago("2026-11-26T19:59:40Z", NOW)).toBe("now")
    expect(ago("2026-11-26T19:56:00Z", NOW)).toBe("4 min")
    expect(ago("2026-11-26T17:00:00Z", NOW)).toBe("3 h")
    expect(ago("2026-11-24T10:00:00Z", NOW)).toBe("Nov 24")
    expect(ago("", NOW)).toBe("")
  })

  test("after sending, say what happened in plain words", () => {
    expect(sayNote({ outcome: "delivered", delivered: 1, note: null, agentsNote: null }, "Alex")).toBe("Sent to Alex's chat.")
    expect(sayNote({ outcome: "parked", delivered: 0, note: "x", agentsNote: null }, "Alex")).toBe("Alex's computer is asleep — it gets this when it wakes.")
    expect(sayNote({ outcome: "held", delivered: 0, note: "x", agentsNote: null }, "Alex")).toBe("Saved here. The chat is busy — it was not typed in this minute.")
    expect(sayNote({ outcome: "saved", delivered: 0, note: null, agentsNote: null }, "Alex")).toBe("Saved here. No live chat is connected right now.")
  })

  test("Stop shows for owners, and for whoever sent the message the chat is working on — never a viewer", () => {
    const msgs: SharedMessage[] = [
      { id: "1", kind: "person", senderId: "2", senderName: "Flo", text: "go", at: "a", deliveredTo: ["s1"] },
      { id: "2", kind: "person", senderId: "3", senderName: "Sam", text: "chat", at: "b", deliveredTo: [] },
    ]
    expect(canStopNow(room({ you: { role: "owner", canPost: true, canStop: true, isOwner: true } }), msgs, 9)).toBe(true)
    expect(canStopNow(room({}), msgs, 2)).toBe(true) // Flo sent the turn that is running
    expect(canStopNow(room({}), msgs, 3)).toBe(false) // Sam's message reached no session
    expect(canStopNow(room({ you: { role: "viewer", canPost: false, canStop: false, isOwner: false } }), msgs, 2)).toBe(false)
  })

  test("the composer invites a member in, and tells a viewer how to get in", () => {
    expect(composerHint(room({}))).toBe("Type to Alex's chat…")
    expect(composerHint(room({ you: { role: "owner", canPost: true, canStop: true, isOwner: true } }))).toBe("Type to your chat…")
    expect(composerHint(room({ you: { role: "viewer", canPost: false, canStop: false, isOwner: false } }))).toBe(
      "You can watch this chat. Ask Alex for editor access to type in it.",
    )
  })
})

import { speakerOf, toolLine, mergeTimeline, type TranscriptEntry } from "./iris-shared-rooms-model"
describe("the live chat — the agent's side, with every person named", () => {
  test("a labelled turn is the teammate who typed it; an unlabelled one is the owner at their keyboard", () => {
    expect(speakerOf("[room · pricing page · Flo] check the failing test", "Alex")).toEqual({ speaker: "Flo", text: "check the failing test", viaRoom: true })
    expect(speakerOf("[via iris · Flo] hello", "Alex")).toEqual({ speaker: "Flo", text: "hello", viaRoom: true })
    expect(speakerOf("[room · pricing page] note", "Alex")).toEqual({ speaker: "Someone", text: "note", viaRoom: true })
    expect(speakerOf("let's ship it", "Alex")).toEqual({ speaker: "Alex", text: "let's ship it", viaRoom: false })
  })

  test("tool steps read as what happened, not as tool names", () => {
    const t = (tool: string, detail: string | null): TranscriptEntry => ({ role: "assistant", kind: "tool", text: "", tool, detail, at: "" })
    expect(toolLine(t("Edit", "src/pricing.ts"))).toBe("Edited pricing.ts")
    expect(toolLine(t("Write", "docs/a.md"))).toBe("Wrote a.md")
    expect(toolLine(t("Read", "/x/y/README.md"))).toBe("Read README.md")
    expect(toolLine(t("Bash", "npm test"))).toBe("Ran npm test")
    expect(toolLine(t("Grep", "TODO"))).toBe("Searched for TODO")
    expect(toolLine(t("WebFetch", null))).toBe("Used WebFetch")
  })

  test("one timeline: the chat, plus room-only moments (a Stop, a held message) in time order, never a typed message twice", () => {
    const transcript: TranscriptEntry[] = [
      { role: "user", kind: "text", text: "start on pricing", tool: null, detail: null, at: "2026-11-26T20:00:00Z" },
      { role: "user", kind: "text", text: "[room · pricing · Flo] check the test", tool: null, detail: null, at: "2026-11-26T20:01:00Z" },
      { role: "assistant", kind: "text", text: "Looking.", tool: null, detail: null, at: "2026-11-26T20:01:05Z" },
    ]
    const room: SharedMessage[] = [
      { id: "1", kind: "person", senderId: "2", senderName: "Flo", text: "check the test", at: "2026-11-26T20:01:00Z", deliveredTo: ["s1"] },
      { id: "2", kind: "person", senderId: "3", senderName: "Sam", text: "too busy, held", at: "2026-11-26T20:01:30Z", deliveredTo: [] },
      { id: "3", kind: "event", senderId: "1", senderName: "IRIS", text: "Stopped by Alex.", at: "2026-11-26T20:02:00Z", deliveredTo: [] },
    ]
    const items = mergeTimeline(transcript, room, "Alex")
    expect(items.map((i) => [i.kind, i.speaker, i.text])).toEqual([
      ["person", "Alex", "start on pricing"],
      ["person", "Flo", "check the test"],
      ["agent", "Agent", "Looking."],
      ["note", "Sam", "too busy, held"],
      ["event", "IRIS", "Stopped by Alex."],
    ])
  })
})

import { chatTrouble } from "./iris-shared-rooms-model"
describe("why the chat cannot be shown — in words, never node ids", () => {
  test("translates what the machine said", () => {
    expect(chatTrouble("Could not read session x on alex-mbp: Pinned to node 01a2…, which is busy (at capacity 2/2 tasks).", "Alex Mayo")).toBe("Alex's computer is busy right now.")
    expect(chatTrouble("the machine did not answer within 45s", "Alex")).toBe("Alex's computer isn't answering.")
    expect(chatTrouble("No machine of this account has checked in recently", "Alex")).toBe("Alex's computer is off or offline.")
    expect(chatTrouble("Session abc not found", "Alex")).toBe("That chat isn't open on Alex's computer anymore.")
    expect(chatTrouble("not signed in to IRIS — run `iris auth login`", "Alex")).toBe("You're not signed in to IRIS.")
    expect(chatTrouble("something odd 01a21990-1e67-71f3-ac8c-1d03a3db0cfd", "Alex")).toBe("Alex's computer couldn't share the chat right now.")
  })
})

import { pillSummary, roomForSession } from "./iris-shared-rooms-model"
describe("telling you, anywhere in the app, that something is shared", () => {
  const r = (id: string, sessionIds: string[], updatedAt: string, project = "Pricing launch"): SharedRoom => ({
    id, name: id, project: { id: 1, name: project }, ownerName: "Alex", you: { role: "editor", canPost: true, canStop: false, isOwner: false }, sessionIds, updatedAt,
  })
  test("the titlebar pill counts what is live now, and stays away when nothing is shared", () => {
    expect(pillSummary([], NOW)).toBeNull()
    const rooms = [r("a", ["s1"], "2026-11-26T19:58:00Z"), r("b", ["s2"], "2026-11-26T19:55:00Z"), r("c", ["s3"], "2026-11-26T12:00:00Z")]
    expect(pillSummary(rooms, NOW)).toEqual({ count: 3, active: 2, label: "2 live", hint: "Shared with your team: 3 chats, 2 active now" })
    expect(pillSummary([r("c", ["s3"], "2026-11-26T12:00:00Z")], NOW)).toEqual({ count: 1, active: 0, label: "1 shared", hint: "Shared with your team: 1 chat, none active now" })
  })
  test("a chat knows the room that shares it", () => {
    const rooms = [r("a", ["ses_1"], "t"), r("b", ["ses_2", "ses_3"], "t", "Client: Vanguard")]
    expect(roomForSession(rooms, "ses_3")?.id).toBe("b")
    expect(roomForSession(rooms, "ses_9")).toBeNull()
    expect(roomForSession(rooms, undefined)).toBeNull()
  })
})

describe("joining and Home", () => {
  test("an invite's role in plain words, least access when unknown", () => {
    expect(roleWords("editor")).toMatch(/type into them/)
    expect(roleWords("owner")).toMatch(/stop them/)
    expect(roleWords("viewer")).toBe("watch its shared chats")
    expect(roleWords(null)).toBe("watch its shared chats")
  })
  test("Home lists the shared chat that moved last first", () => {
    const r = (id: string, updatedAt?: string) => ({ id, name: id, project: null, ownerName: null, you: { role: null, canPost: false, canStop: false, isOwner: false }, sessionIds: [], updatedAt })
    expect(homeSharedRows([r("a", "2026-11-27T10:00:00Z"), r("b", "2026-11-27T11:00:00Z"), r("c")]).map((x) => x.id)).toEqual(["b", "a", "c"])
  })
})
