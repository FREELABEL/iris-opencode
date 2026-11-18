import { describe, expect, test } from "bun:test"
import { backgroundShellEnd } from "./background-shell"

const store = (texts: string[]) => ({
  message: { ses_1: texts.map((_, i) => ({ id: `m${i}` })) },
  part: Object.fromEntries(texts.map((t, i) => [`m${i}`, [{ type: "text", text: t }]])),
})

describe("backgroundShellEnd (#188641)", () => {
  test("no end message yet: still running", () => {
    expect(backgroundShellEnd(store(["hello"]), "ses_1", "job_a")).toBeUndefined()
  })
  test("reads completed, error and cancelled", () => {
    for (const state of ["completed", "error", "cancelled"] as const)
      expect(backgroundShellEnd(store([`<background_shell id="job_a" state="${state}">\nx`]), "ses_1", "job_a")).toBe(state)
  })
  test("another job's end is not this one's", () => {
    expect(backgroundShellEnd(store([`<background_shell id="job_b" state="completed">`]), "ses_1", "job_a")).toBeUndefined()
  })
  test("no session or no job id: unknown, not ended", () => {
    expect(backgroundShellEnd(store([]), undefined, "job_a")).toBeUndefined()
    expect(backgroundShellEnd(store([]), "ses_1", "")).toBeUndefined()
  })
})
