import { describe, expect, test } from "bun:test"
import { MAX_SPLIT, leaveSplit, shownTerminals, splitWith } from "./terminal-split"

describe("terminals side by side (#193785)", () => {
  test("no group: the active terminal alone", () => {
    expect(shownTerminals([], ["a", "b"], "a")).toEqual(["a"])
  })
  test("the active terminal in the group: the whole group, in its order", () => {
    expect(shownTerminals(["a", "b"], ["a", "b", "c"], "b")).toEqual(["a", "b"])
  })
  test("a terminal outside the group: it alone, and the group is still there for later", () => {
    const group = ["a", "b"]
    expect(shownTerminals(group, ["a", "b", "c"], "c")).toEqual(["c"])
    expect(shownTerminals(group, ["a", "b", "c"], "a")).toEqual(["a", "b"])
  })
  test("a closed terminal drops out; one left is not a split", () => {
    expect(shownTerminals(["a", "b", "c"], ["a", "c"], "a")).toEqual(["a", "c"])
    expect(shownTerminals(["a", "b"], ["a"], "a")).toEqual(["a"])
  })
  test("nothing open, or the active one gone: nothing", () => {
    expect(shownTerminals(["a"], [], undefined)).toEqual([])
    expect(shownTerminals(["a", "b"], ["b"], "a")).toEqual([])
  })
  test("split adds the new terminal beside what is shown, up to the cap", () => {
    expect(splitWith(["a"], "b")).toEqual(["a", "b"])
    const full = Array.from({ length: MAX_SPLIT }, (_, i) => `t${i}`)
    expect(splitWith(full, "x")).toEqual(full)
  })
  test("unsplit takes one pane out and keeps the rest together", () => {
    expect(leaveSplit(["a", "b", "c"], "b")).toEqual(["a", "c"])
  })
})
