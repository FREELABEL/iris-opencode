import { describe, expect, test } from "bun:test"
import { checksSummary, diffLines, isGithubPrUrl } from "./github-pr-model"

describe("isGithubPrUrl", () => {
  test("matches the same addresses the engine reads", () => {
    expect(isGithubPrUrl("https://github.com/FREELABEL/iris-code/pull/3")).toBe(true)
    expect(isGithubPrUrl("https://github.com/FREELABEL/iris-code/pull/3/files")).toBe(true)
    expect(isGithubPrUrl("https://github.com/a/b.c/pull/12#discussion_r1")).toBe(true)
  })
  test("everything else still goes through the frame check", () => {
    for (const u of [
      undefined,
      "https://github.com/FREELABEL/iris-code",
      "https://github.com/FREELABEL/iris-code/issues/3",
      "https://github.com/FREELABEL/iris-code/pull/0",
      "https://github.com.evil.com/a/b/pull/1",
      "https://heyiris.io/p/x",
    ])
      expect(isGithubPrUrl(u)).toBe(false)
  })
})

describe("checksSummary", () => {
  test("failing first, then pending, passed, other", () => {
    expect(
      checksSummary([
        { name: "a", state: "success" },
        { name: "b", state: "failure" },
        { name: "c", state: "pending" },
        { name: "d", state: "failure" },
        { name: "e", state: "skipped" },
      ]),
    ).toBe("2 failing · 1 pending · 1 passed · 1 other")
    expect(checksSummary([{ name: "a", state: "success" }])).toBe("1 passed")
  })
})

describe("diffLines", () => {
  test("colours by the first character", () => {
    expect(diffLines("@@ -1,2 +1,2 @@\n ctx\n-old\n+new").map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add"])
  })
})
