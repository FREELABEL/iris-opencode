import { describe, expect, test } from "bun:test"
import { markOf } from "./agent-mark-model"

describe("markOf (#192985)", () => {
  test("each tool the daemon reports wears its own mark", () => {
    expect(markOf("claude_code")).toBe("claude")
    expect(markOf("codex")).toBe("codex")
    expect(markOf("opencode")).toBe("iris")
    expect(markOf("ollama")).toBe("ollama")
  })
  test("Gemini is ready for when the daemon reports it, under either name", () => {
    expect(markOf("gemini")).toBe("gemini")
    expect(markOf("gemini_cli")).toBe("gemini")
  })
  test("an unknown tool gets the neutral tile, never another tool's logo", () => {
    expect(markOf("acp")).toBe("other")
    expect(markOf("amp")).toBe("other")
    expect(markOf("")).toBe("other")
  })
  test("case does not matter", () => {
    expect(markOf("Claude_Code")).toBe("claude")
  })
})
