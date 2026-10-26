import { describe, expect, test } from "bun:test"
import { submitState } from "./submit-state"

describe("submitState", () => {
  test("nothing to send: idle", () => {
    expect(submitState({ stopping: false, disabled: true })).toBe("idle")
  })
  test("something to send: ready", () => {
    expect(submitState({ stopping: false, disabled: false })).toBe("ready")
  })
  test("a reply is running: stop, even when the box is empty", () => {
    expect(submitState({ stopping: true, disabled: true })).toBe("stop")
  })
})
