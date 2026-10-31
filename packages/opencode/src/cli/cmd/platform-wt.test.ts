import { describe, expect, test } from "bun:test"
import { resolveWtScript, wtArgs } from "./platform-wt"
import { loadIndex, searchCapabilities } from "./platform-find"

// #190212 — agents could not find `wt`: not an iris command, not on PATH.
describe("resolveWtScript", () => {
  const home = "/h"
  test("~/.iris/bin/wt wins", () => {
    const r = resolveWtScript({ cwd: "/w/repo/sub", home, gitToplevel: "/w/repo", exists: (p) => p === "/h/.iris/bin/wt" || p === "/w/repo/scripts/wt" })
    expect(r.path).toBe("/h/.iris/bin/wt")
  })
  test("then <git toplevel>/scripts/wt", () => {
    const r = resolveWtScript({ cwd: "/w/repo/sub", home, gitToplevel: "/w/repo", exists: (p) => p === "/w/repo/scripts/wt" })
    expect(r.path).toBe("/w/repo/scripts/wt")
  })
  test("then walks up the parents (fl-iris-api inside fl-docker-dev inside freelabel)", () => {
    const r = resolveWtScript({ cwd: "/w/freelabel/fl-docker-dev/fl-iris-api", home, gitToplevel: "/w/freelabel/fl-docker-dev/fl-iris-api", exists: (p) => p === "/w/freelabel/scripts/wt" })
    expect(r.path).toBe("/w/freelabel/scripts/wt")
  })
  test("not found: every place it looked, in order", () => {
    const r = resolveWtScript({ cwd: "/a/b", home, gitToplevel: null, exists: () => false })
    expect(r.path).toBeNull()
    expect(r.looked).toEqual(["/h/.iris/bin/wt", "/a/b/scripts/wt", "/a/scripts/wt", "/scripts/wt"])
  })
})

describe("wtArgs", () => {
  test("passes everything after wt verbatim, flags included", () => {
    expect(wtArgs(["/usr/bin/iris", "wt", "new", "190214", "slug", "--x"])).toEqual(["new", "190214", "slug", "--x"])
    expect(wtArgs(["bun", "src/index.ts", "worktree", "list"])).toEqual(["list"])
  })
})

describe("iris find surfaces it", () => {
  test('"make a worktree" ranks iris wt first', () => {
    const hits = searchCapabilities(loadIndex(), "make a worktree", undefined, 3)
    expect(hits[0]?.e.name).toBe("wt")
  })
})
