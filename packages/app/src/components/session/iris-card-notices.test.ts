import { describe, expect, test } from "bun:test"
import { noticeCopy } from "./iris-card-notices"

describe("card notice copy (#189799)", () => {
  test("each kind has a plain title, and a mention quotes the comment", () => {
    expect(noticeCopy({ kind: "assign", text: "Alex assigned you \"Ship\" on Ops.", bloqId: 1, itemId: 2 })).toEqual({
      title: "Assigned to you",
      body: "Alex assigned you \"Ship\" on Ops.",
    })
    expect(noticeCopy({ kind: "mention", text: "Alex mentioned you.", excerpt: "take this?", bloqId: 1, itemId: 2 }).body).toBe(
      "Alex mentioned you.\n“take this?”",
    )
    expect(noticeCopy({ kind: "due", text: "\"Ship\" is due tomorrow.", bloqId: 1, itemId: 2 }).title).toBe("Due tomorrow")
  })
})
