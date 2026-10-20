import { describe, expect, test } from "bun:test"
import { readCardNotice } from "../../src/iris/atlas-live"
import { cardFace, readNotifySettings } from "../../src/iris/platform"

describe("your own card notices (#189799)", () => {
  test("reads Pusher's JSON-string data into a notice", () => {
    const data = JSON.stringify({
      notification: { kind: "mention", text: "Alex mentioned you on \"Ship\" on Ops.", excerpt: "can you take this?", bloq_id: 7, item_id: 42, title: "Ship", by: "Alex" },
    })
    expect(readCardNotice(data)).toEqual({
      kind: "mention",
      text: "Alex mentioned you on \"Ship\" on Ops.",
      excerpt: "can you take this?",
      bloqId: 7,
      itemId: 42,
      title: "Ship",
      by: "Alex",
    })
  })

  test("a PHI board's notice stays without title or excerpt", () => {
    const n = readCardNotice({ notification: { kind: "assign", text: "Alex assigned you a card on Clinic.", excerpt: null, bloq_id: 1, item_id: 2, title: null } })
    expect(n).toEqual({ kind: "assign", text: "Alex assigned you a card on Clinic.", bloqId: 1, itemId: 2 })
  })

  test("anything else is not a notice", () => {
    expect(readCardNotice("not json")).toBeUndefined()
    expect(readCardNotice({ notification: { kind: "spam", text: "x", bloq_id: 1, item_id: 2 } })).toBeUndefined()
    expect(readCardNotice({ notification: { kind: "due", text: "x", bloq_id: "a", item_id: 2 } })).toBeUndefined()
  })
})

describe("notification settings", () => {
  test("everything is on unless turned off", () => {
    expect(readNotifySettings({})).toEqual({ emailAssign: true, emailMention: true, emailDue: true, push: true })
    expect(readNotifySettings({ push: false, email_due: false })).toEqual({ emailAssign: true, emailMention: true, emailDue: false, push: false })
  })
})

describe("card cover (#189797)", () => {
  test("carries an http(s) cover from the summary and nothing else", () => {
    expect(cardFace({ summary: { cover: "https://cdn.test/a.png" } }).cover).toBe("https://cdn.test/a.png")
    expect(cardFace({ summary: { cover: "javascript:alert(1)" } }).cover).toBeUndefined()
    expect(cardFace({ summary: { cover: null } }).cover).toBeUndefined()
  })
})
