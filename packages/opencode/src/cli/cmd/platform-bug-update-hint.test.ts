import { describe, expect, test } from "bun:test"
import { bugUpdateNotFoundHint } from "./platform-bug"

// #189895 — "Bug report not found" on an epic id read like "this id does not exist".
describe("bugUpdateNotFoundHint", () => {
  test("a 404 names the commands that edit any Atlas item", () => {
    const lines = bugUpdateNotFoundHint(404, "Bug report not found", 189589).join("\\n")
    expect(lines).toContain("#189589 is not on a bug board")
    expect(lines).toContain("iris atlas use 189589")
    expect(lines).toContain("iris bloqs update-item 189589 --content=")
  })
  test("the server's not-found text alone is enough", () => {
    expect(bugUpdateNotFoundHint(422, "Bug report not found.", 1).length).toBe(3)
  })
  test("other failures get no hint", () => {
    expect(bugUpdateNotFoundHint(500, "Server error", 1)).toEqual([])
    expect(bugUpdateNotFoundHint(403, "Forbidden", 1)).toEqual([])
  })
})
