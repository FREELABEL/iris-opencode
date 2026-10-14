import { describe, expect, test } from "bun:test"
import { LARGE_PASTE_CHARS, LARGE_PASTE_LINES, largePaste, pastedTextFile } from "./attachments"

// #189434: a large paste in the editor slowed every keystroke after it, so it becomes an attachment.
describe("largePaste", () => {
  test("a short paste stays inline", () => {
    expect(largePaste("hello world")).toBe(false)
    expect(largePaste("a\nb\nc")).toBe(false)
  })

  test("the character threshold is inclusive", () => {
    expect(largePaste("x".repeat(LARGE_PASTE_CHARS - 1))).toBe(false)
    expect(largePaste("x".repeat(LARGE_PASTE_CHARS))).toBe(true)
  })

  test("the line threshold counts lines, not newlines", () => {
    const lines = (n: number) => Array.from({ length: n }, () => "l").join("\n")
    expect(largePaste(lines(LARGE_PASTE_LINES - 1))).toBe(false)
    expect(largePaste(lines(LARGE_PASTE_LINES))).toBe(true)
  })
})

describe("pastedTextFile", () => {
  test("is a text file that carries the whole paste and says how long it is", async () => {
    const text = Array.from({ length: 312 }, (_, i) => `line ${i}`).join("\n")
    const file = pastedTextFile(text)
    expect(file.type.split(";")[0]).toBe("text/plain")
    expect(file.name).toBe("Pasted text · 312 lines.txt")
    expect(await file.text()).toBe(text)
  })

  test("one line reads as singular", () => {
    expect(pastedTextFile("x".repeat(5000)).name).toBe("Pasted text · 1 line.txt")
  })
})
