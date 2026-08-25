import { describe, expect, test } from "bun:test"
import { parseRef, pageTier } from "./platform-exposure"

/**
 * #182344 G-09 — one address grammar across nouns, and one honest answer for
 * "what tier is this page actually on".
 */
describe("parseRef", () => {
  test("an explicit kind is taken at its word", () => {
    expect(parseRef("page:atlas-console")).toEqual({ noun: "page", id: "atlas-console", inferred: false })
    expect(parseRef("note:182260")).toEqual({ noun: "note", id: "182260", inferred: false })
    expect(parseRef("playbook:genesis-regression")).toEqual({ noun: "playbook", id: "genesis-regression", inferred: false })
  })

  test("a bare value is inferred — and says so", () => {
    // Inference is fine. Inference you cannot see is how you answer a question
    // nobody asked, so `inferred` has to reach the caller.
    expect(parseRef("182260")).toEqual({ noun: "note", id: "182260", inferred: true })
    expect(parseRef("atlas-console")).toEqual({ noun: "page", id: "atlas-console", inferred: true })
  })

  test("an unknown kind is refused by name, not silently treated as a slug", () => {
    const r = parseRef("widget:thing") as { error: string }
    expect(r.error).toContain("widget")
    expect(r.error).toContain("page")
  })

  test("empty and colon-only inputs are refused", () => {
    expect((parseRef("") as any).error).toBeTruthy()
    expect((parseRef("   ") as any).error).toBeTruthy()
    expect((parseRef("page:") as any).error).toBeTruthy()
  })

  test("a slug containing a dash is not mistaken for a kind", () => {
    expect(parseRef("design-philosophy-and-page-audit")).toEqual({
      noun: "page",
      id: "design-philosophy-and-page-audit",
      inferred: true,
    })
  })
})

describe("pageTier", () => {
  test("an OTP gate outranks a public visibility column", () => {
    // /p/exposure-architecture is exactly this: visibility=public, gate on, and a
    // stranger gets nothing. Reporting "public" would be true about a column and
    // false about the world.
    expect(pageTier({ status: "published", visibility: "public", requires_auth: true })).toBe("gated")
    expect(pageTier({ status: "published", visibility: "public", json_content: { requireOtp: true } })).toBe("gated")
  })

  test("a draft is not reachable whatever its visibility says", () => {
    expect(pageTier({ status: "draft", visibility: "public" })).toBe("private")
  })

  test("declared visibility is honoured on a published page", () => {
    expect(pageTier({ status: "published", visibility: "private" })).toBe("private")
    expect(pageTier({ status: "published", visibility: "unlisted" })).toBe("unlisted")
    expect(pageTier({ status: "published", visibility: "public" })).toBe("public")
  })

  test("absent visibility follows the server's fail-open default", () => {
    // The server treats unset as fully public. Reporting anything narrower here
    // would be a comforting answer rather than a true one.
    expect(pageTier({ status: "published" })).toBe("public")
  })

  test("effective_visibility is used when visibility is absent", () => {
    expect(pageTier({ status: "published", effective_visibility: "unlisted" })).toBe("unlisted")
  })
})
