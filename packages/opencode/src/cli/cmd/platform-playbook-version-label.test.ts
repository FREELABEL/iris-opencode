import { describe, expect, test } from "bun:test"
import { versionLabel } from "./platform-playbook"

// #189894 — "Version: 2" was printed for a file that says version: 3.
describe("versionLabel", () => {
  test("matching version prints just the number", () => {
    expect(versionLabel({ version: 2, declaredVersion: 2 })).toBe("2")
    expect(versionLabel({ version: 1, declaredVersion: 1 })).toBe("1")
  })
  test("a version promoted by its steps says what the file has", () => {
    expect(versionLabel({ version: 2, declaredVersion: 3 })).toBe("2 (file has version: 3 — runs as v2)")
  })
  test("a missing field is named, not shown as a number", () => {
    expect(versionLabel({ version: 1, declaredVersion: undefined })).toBe("1 (file has no version field — runs as v1)")
  })
  test('the string "2" counts as 2 for display', () => {
    expect(versionLabel({ version: 2, declaredVersion: "2" })).toBe("2")
  })
})
