import { describe, expect, test } from "bun:test"
import { draftPayload, lintSummary, documentLines, MAX_SOURCE_CHARS } from "./platform-newsroom"

describe("lintSummary", () => {
  test("separates blockers from warnings", () => {
    const { blockers, warnings } = lintSummary([
      { rule: "quote-fidelity", severity: "blocker", message: "not in the source" },
      { rule: "thin-section", severity: "warning", message: "two sentences" },
    ])
    expect(blockers).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(blockers[0]!.rule).toBe("quote-fidelity")
  })

  test("treats error and critical as blocking", () => {
    const { blockers } = lintSummary([{ severity: "error" }, { severity: "CRITICAL" }])
    expect(blockers).toHaveLength(2)
  })

  // A rule this CLI has never heard of is still something a reviewer should see. Dropping it
  // would make a newly-added backend rule invisible until an article it should have stopped got
  // published.
  test("keeps an unknown severity rather than discarding it", () => {
    const { blockers, warnings } = lintSummary([{ severity: "advisory", message: "hmm" }])
    expect(blockers).toHaveLength(0)
    expect(warnings).toHaveLength(1)
  })

  test("survives a missing or malformed lint payload", () => {
    for (const input of [undefined, null, {}, "nope", 7]) {
      const { blockers, warnings } = lintSummary(input)
      expect(blockers).toHaveLength(0)
      expect(warnings).toHaveLength(0)
    }
  })
})

describe("draftPayload", () => {
  test("omits unset options instead of sending nulls", () => {
    const body = draftPayload("some words", { bloq: 368 }, { filing: true })
    expect(body).toEqual({ text: "some words", bloq_id: 368 })
    expect("angle" in body).toBe(false)
    expect("publish" in body).toBe(false)
  })

  test("maps flags to the endpoint's snake_case contract", () => {
    const body = draftPayload("t", { bloq: 1, angle: "pricing", title: "T", lane: "Drafts", skipLint: true }, { filing: true })
    expect(body.skip_lint).toBe(true)
    expect(body.bloq_id).toBe(1)
    expect(body.lane).toBe("Drafts")
  })

  // /article/structure writes nothing, so filing-only flags are meaningless there — and `publish`
  // on a structure call would read as "this was published" to anyone reading the request log.
  test("drops filing-only flags when not filing", () => {
    const body = draftPayload("t", { bloq: 1, lane: "Drafts", publish: true, force: true }, { filing: false })
    expect("lane" in body).toBe(false)
    expect("publish" in body).toBe(false)
    expect("force" in body).toBe(false)
    expect(body.bloq_id).toBe(1)
  })

  test("carries bloq_id on a dry run so the PHI check can still run", () => {
    const body = draftPayload("t", { bloq: 368 }, { filing: false })
    expect(body.bloq_id).toBe(368)
  })
})

describe("documentLines", () => {
  test("reports the shape of a document", () => {
    const lines = documentLines({
      title: "A headline",
      dek: "A dek",
      sections: [{}, {}, {}],
      pullQuotes: [{}],
      wordCount: 412,
      gaps: ["no date given"],
    }).join("\n")
    expect(lines).toContain("A headline")
    expect(lines).toContain("3 section(s)")
    expect(lines).toContain("1 pull quote(s)")
    expect(lines).toContain("412 words")
    expect(lines).toContain("1 noted by the writer")
  })

  test("does not throw on an empty or partial document", () => {
    expect(documentLines(undefined).join("\n")).toContain("(untitled)")
    expect(documentLines({ title: "T" }).join("\n")).toContain("0 section(s)")
  })
})

describe("MAX_SOURCE_CHARS", () => {
  // Mirrors ArticleDraftController's `text` => 'required|string|max:200000'. If that validation
  // changes, this constant is wrong and the CLI will send a request it knows will 422.
  test("matches the endpoint's documented cap", () => {
    expect(MAX_SOURCE_CHARS).toBe(200000)
  })
})
