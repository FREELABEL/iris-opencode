import { describe, expect, test } from "bun:test"
import {
  insertMention,
  mentionQuery,
  mentionSuggestions,
  mentionedAgents,
  recipientsLine,
  sentToLine,
  sortMessages,
  type RoomAgent,
} from "./iris-rooms-model"

const a = (id: string, name: string, role = "participant", autoRespond = false): RoomAgent => ({
  id,
  name,
  role,
  autoRespond,
})
const room = [a("7", "Patty", "primary"), a("9", "Tobi"), a("11", "Tobi Research")]

describe("recipientsLine — the documented default for an unaddressed message", () => {
  test("names every @mentioned agent", () => {
    expect(recipientsLine("@Patty and @Tobi, sync up", room)).toEqual({ text: "to Patty, Tobi", warn: false })
  })
  test("@Tobi Research is not also @Tobi", () => {
    expect(recipientsLine("@Tobi Research go", room).text).toBe("to Tobi Research")
  })
  test("zero mentions → the primary answers, and the line says so", () => {
    expect(recipientsLine("status?", room)).toEqual({
      text: "no @mention — Patty will answer (room default)",
      warn: false,
    })
  })
  test("always-on agents take precedence over the primary", () => {
    expect(recipientsLine("status?", [a("7", "Patty", "primary"), a("9", "Tobi", "participant", true)]).text).toContain(
      "Tobi will answer",
    )
  })
  test("no primary and nobody always-on is a warning, not a silent drop", () => {
    expect(recipientsLine("status?", [a("9", "Tobi")]).warn).toBe(true)
  })
})

test("sentToLine reads the server's record, not the draft", () => {
  const m = {
    id: "1",
    sender: "user",
    senderId: "5",
    senderName: "You",
    text: "@x",
    at: "",
    addressees: ["9", "404"],
  } as const
  expect(sentToLine({ ...m, addressees: [...m.addressees] }, room)).toBe("to Tobi, agent 404")
  expect(sentToLine({ ...m, addressees: [], routing: "room-default" }, room)).toBe("to the room default")
})

describe("@ autocomplete", () => {
  test("triggers at a word-start @, not inside an email", () => {
    expect(mentionQuery("hey @pa")).toBe("pa")
    expect(mentionQuery("@")).toBe("")
    expect(mentionQuery("mail alex@pa")).toBeUndefined()
  })
  test("suggests by prefix or later word", () => {
    expect(mentionSuggestions("res", room).map((x) => x.id)).toEqual(["11"])
    expect(mentionSuggestions("to", room).map((x) => x.id)).toEqual(["9", "11"])
  })
  test("insertion replaces the query with the full name and moves the caret past it", () => {
    const r = insertMention("ask @to now", 7, "Tobi Research")
    expect(r.text).toBe("ask @Tobi Research  now")
    expect(r.caret).toBe("ask @Tobi Research ".length)
    expect(mentionedAgents(r.text, room).map((x) => x.id)).toEqual(["11"])
  })
})

test("sortMessages keeps send order within one second", () => {
  const at = "2026-09-22T18:00:01Z"
  const ids = ["0199-0003", "0199-0001", "0199-0002"]
  expect(sortMessages(ids.map((id) => ({ id, at }) as any)).map((m) => m.id)).toEqual([
    "0199-0001",
    "0199-0002",
    "0199-0003",
  ])
})
