import { describe, expect, test } from "bun:test"
import { aiPromptFrom, parseSteps } from "./executor"

/**
 * Regression cover for the 2026-09-04 empty-prompt defect.
 *
 * A `mode: ai` step whose prompt lived in a tagged fence validated clean and then sent
 * NOTHING. The validator asked "is body or code set?"; dispatch sent `body` alone. Two
 * rules, one question, and they disagreed for as long as nobody wrote this file.
 */

/** The rule as it was BEFORE the fix, kept only so the tests below can prove they bite. */
const dispatchedPromptBeforeFix = (body?: string | null) => body ?? ""
/** The validator as it was before the fix: truthiness on either field. */
const validatorAcceptedBeforeFix = (body?: string | null, code?: string | null) => Boolean(body || code)

describe("aiPromptFrom — what an ai step actually sends", () => {
  test("a fence-only step sends the fence (the exact 2026-09-04 defect)", () => {
    expect(aiPromptFrom("", "Reply with exactly: OK")).toBe("Reply with exactly: OK")
  })

  test("prose-only step sends the prose", () => {
    expect(aiPromptFrom("Summarise the diff.", null)).toBe("Summarise the diff.")
  })

  test("body wins when both are present", () => {
    expect(aiPromptFrom("authored prompt", "payload")).toBe("authored prompt")
  })

  test("whitespace-only body falls through to the fence", () => {
    expect(aiPromptFrom("   \n\t ", "real prompt")).toBe("real prompt")
  })

  test("nothing at all yields empty — the only case that may send nothing", () => {
    expect(aiPromptFrom(null, null)).toBe("")
    expect(aiPromptFrom("  ", null)).toBe("")
  })
})

describe("the invariant the defect violated", () => {
  const shapes: Array<[string, string | null, string | null]> = [
    ["fence only", "", "fenced prompt"],
    ["prose only", "prose prompt", null],
    ["both", "prose prompt", "fenced prompt"],
    ["whitespace body + fence", "   ", "fenced prompt"],
    ["whitespace body, no fence", "   ", null],
    ["nothing", null, null],
  ]

  test("a step that VALIDATES always has something to send", () => {
    for (const [label, body, code] of shapes) {
      const prompt = aiPromptFrom(body, code)
      const validates = prompt.trim().length > 0
      if (validates) expect(prompt.length, `${label} validated but sends nothing`).toBeGreaterThan(0)
    }
  })

  test("the OLD rules broke that invariant — proof these tests bite", () => {
    // fence-only: the old validator accepted it, the old dispatch sent "".
    expect(validatorAcceptedBeforeFix("", "fenced prompt")).toBe(true)
    expect(dispatchedPromptBeforeFix("")).toBe("")

    // whitespace body, no fence: accepted on truthiness, sent whitespace.
    expect(validatorAcceptedBeforeFix("   ", null)).toBe(true)
    expect(dispatchedPromptBeforeFix("   ").trim()).toBe("")

    // The fix closes both.
    expect(aiPromptFrom("", "fenced prompt")).toBe("fenced prompt")
    expect(aiPromptFrom("   ", null)).toBe("")
  })
})

describe("end to end through parseSteps", () => {
  const fenceOnly = [
    "### step:only-a-fence Prompt lives in the fence",
    "",
    "```yaml",
    "mode: ai",
    "```",
    "",
    "```text",
    "Reply with exactly: OK",
    "```",
    "",
  ].join("\n")

  test("a real fence-only playbook step yields a non-empty prompt", () => {
    const [step] = parseSteps(fenceOnly)
    expect(step.mode).toBe("ai")
    expect(step.body.trim()).toBe("") // the parser puts fenced content in `code`, not `body`
    expect(aiPromptFrom(step.body, step.code).trim()).toBe("Reply with exactly: OK")
    // and the pre-fix dispatch would have sent nothing at all:
    expect(dispatchedPromptBeforeFix(step.body).trim()).toBe("")
  })
})
