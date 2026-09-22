import { describe, expect, test } from "bun:test"
import { readRoom, readRoomMessage, sortRoomMessages } from "./rooms"

describe("readRoomMessage", () => {
  test("reads the server's addressees, routing and in_reply_to", () => {
    const m = readRoomMessage({
      id: "019a-2",
      sender_type: "agent",
      sender_id: "7",
      sender_name: "Patty",
      content: "On it.",
      created_at: "2026-09-22T18:00:01.000000Z",
      in_reply_to: "019a-1",
      metadata: { addressees: [7, "9"], routing: "mention" },
    })
    expect(m).toMatchObject({
      sender: "agent",
      senderName: "Patty",
      inReplyTo: "019a-1",
      addressees: ["7", "9"],
      routing: "mention",
    })
  })

  test("falls back to metadata.in_response_to for replies written before the column was set", () => {
    expect(readRoomMessage({ id: "x", sender_type: "agent", metadata: { in_response_to: "q1" } }).inReplyTo).toBe("q1")
  })

  test("an unknown routing value is dropped, not passed through", () => {
    expect(readRoomMessage({ id: "x", metadata: { routing: "broadcast" } }).routing).toBeUndefined()
  })
})

describe("sortRoomMessages", () => {
  test("same-second messages keep send order by id (UUIDv7)", () => {
    const at = "2026-09-22T18:00:01.000000Z"
    const q = { id: "0199aa00-0000-7000-8000-000000000001", at } as any
    const r1 = { id: "0199aa00-0000-7000-8000-000000000002", at } as any
    const r2 = { id: "0199aa00-0000-7000-8000-000000000003", at } as any
    expect(sortRoomMessages([r2, q, r1]).map((m) => m.id)).toEqual([q.id, r1.id, r2.id])
  })
  test("time wins over id", () => {
    const a = { id: "zzz", at: "2026-09-22T18:00:00Z" } as any
    const b = { id: "aaa", at: "2026-09-22T18:00:05Z" } as any
    expect(sortRoomMessages([b, a]).map((m) => m.id)).toEqual(["zzz", "aaa"])
  })
})

test("readRoom takes names and roles from the hydrated agents", () => {
  const r = readRoom({
    id: "t1",
    name: "War room",
    agents: [{ id: 7, name: "Patty", pivot: { role: "primary", auto_respond: false } }],
  })
  expect(r.agents).toEqual([{ id: "7", name: "Patty", role: "primary", autoRespond: false }])
})
