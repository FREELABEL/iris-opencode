import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createReplyReader } from "./spoken-replies"

const user = (id: string) => ({ id, role: "user", sessionID: "s", time: { created: 0 } }) as unknown as Message
const reply = (id: string, completed?: number, error?: { name: string }) =>
  ({ id, role: "assistant", sessionID: "s", time: { created: 0, completed }, error }) as unknown as Message
const text = (messageID: string, value: string, extra = {}) =>
  ({ id: `${messageID}-p`, type: "text", messageID, sessionID: "s", text: value, ...extra }) as unknown as Part

function harness() {
  const said: string[] = []
  const calls: string[] = []
  const reader = createReplyReader({
    speak: (t) => (said.push(t), calls.push("speak")),
    finish: () => calls.push("finish"),
    stop: () => calls.push("stop"),
  })
  return { said, calls, reader }
}

describe("reply reader", () => {
  test("does not read a reply that was already complete when first seen (history)", () => {
    const h = harness()
    h.reader.update([user("u1"), reply("a1", 5)], () => [text("a1", "Old answer. From before.")])
    expect(h.calls).toEqual([])
  })

  test("reads a streaming reply sentence by sentence, then the tail and finish when complete", () => {
    const h = harness()
    const parts: Record<string, Part[]> = {}
    const msgs = [user("u1"), reply("a1")]
    parts.a1 = [text("a1", "Sure. Let me che")]
    h.reader.update(msgs, (id) => parts[id])
    parts.a1 = [text("a1", "Sure. Let me check **that** for you. Done")]
    h.reader.update(msgs, (id) => parts[id])
    h.reader.update([user("u1"), reply("a1", 9)], (id) => parts[id])
    expect(h.said).toEqual(["Sure.", "Let me check that for you.", "Done"])
    expect(h.calls.at(-1)).toBe("finish")
  })

  test("skips synthetic and ignored text parts and tool parts", () => {
    const h = harness()
    const parts = [
      text("a1", "Hidden note.", { synthetic: true }),
      { id: "t", type: "tool", messageID: "a1" } as unknown as Part,
      text("a1", "Spoken.", { id: "x" }),
    ]
    h.reader.update([user("u1"), reply("a1", 1)], () => parts)
    expect(h.said).toEqual([])
    h.reader.reset()
    h.reader.update([user("u1"), reply("a2")], () => parts.map((p) => ({ ...p, messageID: "a2" }) as Part))
    h.reader.update([user("u1"), reply("a2", 2)], () => parts.map((p) => ({ ...p, messageID: "a2" }) as Part))
    expect(h.said).toEqual(["Spoken."])
  })

  test("a new user message stops the reply being spoken", () => {
    const h = harness()
    h.reader.update([user("u1"), reply("a1")], () => [text("a1", "Talking. And talking")])
    h.reader.update([user("u1"), reply("a1"), user("u2")], () => [text("a1", "Talking. And talking")])
    expect(h.calls).toEqual(["speak", "stop"])
  })

  test("an aborted reply stops speech and is not finished", () => {
    const h = harness()
    h.reader.update([user("u1"), reply("a1")], () => [text("a1", "Working on it. ")])
    h.reader.update([user("u1"), reply("a1", 3, { name: "MessageAbortedError" })], () => [text("a1", "Working on it. More.")])
    expect(h.calls).toEqual(["speak", "stop"])
  })

  test("the next reply in the same session is read too", () => {
    const h = harness()
    h.reader.update([user("u1"), reply("a1", 1)], () => [text("a1", "Old.")])
    h.reader.update([user("u1"), reply("a1", 1), user("u2"), reply("a2")], (id) => [text(id, "New one. ")])
    expect(h.said).toEqual(["New one."])
  })

  test("a manual stop silences the reply and the rest of it is never resumed", () => {
    const h = harness()
    h.reader.update([user("u1"), reply("a1")], () => [text("a1", "One. ")])
    h.reader.stop()
    h.reader.update([user("u1"), reply("a1")], () => [text("a1", "One. Two. Three.")])
    h.reader.update([user("u1"), reply("a1", 4)], () => [text("a1", "One. Two. Three. End")])
    expect(h.said).toEqual(["One."])
    expect(h.calls).toEqual(["speak", "stop"])
  })

  test("stop also silences a reply that finished streaming but is still playing", () => {
    const h = harness()
    h.reader.update([user("u1"), reply("a1")], () => [text("a1", "Hi. ")])
    h.reader.update([user("u1"), reply("a1", 2)], () => [text("a1", "Hi. Bye.")])
    h.reader.stop()
    expect(h.calls).toEqual(["speak", "speak", "finish", "stop"])
  })
})
