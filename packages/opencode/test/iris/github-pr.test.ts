import { describe, expect, test } from "bun:test"
import { capPatch, checkState, parsePrUrl, PATCH_LINES, readPr, shapePr } from "../../src/iris/github-pr"

describe("parsePrUrl", () => {
  test("a PR address, and its sub-pages", () => {
    const want = { owner: "FREELABEL", repo: "iris-code", number: 3 }
    expect(parsePrUrl("https://github.com/FREELABEL/iris-code/pull/3")).toEqual(want)
    expect(parsePrUrl("https://github.com/FREELABEL/iris-code/pull/3/files")).toEqual(want)
    expect(parsePrUrl("https://github.com/FREELABEL/iris-code/pull/3/")).toEqual(want)
    expect(parsePrUrl("https://github.com/FREELABEL/iris-code/pull/3#issuecomment-1")).toEqual(want)
    expect(parsePrUrl("https://github.com/a/b.c_d-e/pull/12?w=1")).toEqual({ owner: "a", repo: "b.c_d-e", number: 12 })
  })

  test("anything that is not a github.com PR is not a PR", () => {
    for (const u of [
      undefined,
      "",
      "not a url",
      "https://github.com/FREELABEL/iris-code",
      "https://github.com/FREELABEL/iris-code/issues/3",
      "https://github.com/FREELABEL/iris-code/pull/abc",
      "https://github.com/FREELABEL/iris-code/pull/0",
      "https://gitlab.com/FREELABEL/iris-code/pull/3",
      "https://evil.com/github.com/FREELABEL/iris-code/pull/3",
      "https://github.com.evil.com/FREELABEL/iris-code/pull/3",
      "javascript:alert(1)//github.com/a/b/pull/1",
    ])
      expect(parsePrUrl(u)).toBeUndefined()
  })
})

describe("capPatch", () => {
  test("a short diff passes through untouched", () => {
    expect(capPatch("@@ -1 +1 @@\n-a\n+b")).toEqual({ patch: "@@ -1 +1 @@\n-a\n+b" })
    expect(capPatch(undefined)).toEqual({})
  })
  test("a long diff is cut and says so", () => {
    const long = Array.from({ length: PATCH_LINES + 50 }, (_, i) => `+${i}`).join("\n")
    const r = capPatch(long)
    expect(r.truncated).toBe(true)
    expect(r.patch!.split("\n")).toHaveLength(PATCH_LINES)
  })
})

describe("checkState", () => {
  test("maps GitHub's conclusions to five states", () => {
    expect(checkState("in_progress", null)).toBe("pending")
    expect(checkState("queued", null)).toBe("pending")
    expect(checkState("completed", "success")).toBe("success")
    expect(checkState("completed", "failure")).toBe("failure")
    expect(checkState("completed", "timed_out")).toBe("failure")
    expect(checkState("completed", "cancelled")).toBe("failure")
    expect(checkState("completed", "skipped")).toBe("skipped")
    expect(checkState("completed", "neutral")).toBe("neutral")
    // commit statuses arrive as state, not conclusion
    expect(checkState("completed", "pending")).toBe("pending")
    expect(checkState("completed", "error")).toBe("failure")
  })
})

const ref = { owner: "FREELABEL", repo: "iris-code", number: 3 }
const pr = {
  html_url: "https://github.com/FREELABEL/iris-code/pull/3",
  title: "fix(hive): script list",
  body: "What it fixes",
  state: "open",
  draft: false,
  merged_at: null,
  user: { login: "mayoalexander" },
  base: { ref: "main" },
  head: { ref: "wt/192932-hive-script-list", sha: "abc123" },
  created_at: "2026-11-09T01:00:00Z",
  updated_at: "2026-11-09T02:00:00Z",
  additions: 29,
  deletions: 9,
  changed_files: 2,
  commits: 1,
  mergeable_state: "clean",
}

describe("shapePr", () => {
  test("state: merged beats closed, draft beats open", () => {
    expect(shapePr(ref, { ...pr, merged_at: "x", state: "closed" }, [], [], [], [], []).state).toBe("merged")
    expect(shapePr(ref, { ...pr, state: "closed" }, [], [], [], [], []).state).toBe("closed")
    expect(shapePr(ref, { ...pr, draft: true }, [], [], [], [], []).state).toBe("draft")
    expect(shapePr(ref, pr, [], [], [], [], []).state).toBe("open")
  })

  test("checks from both check-runs and commit statuses; thread in time order; empty reviews dropped", () => {
    const v = shapePr(
      ref,
      pr,
      [{ filename: "a.ts", status: "modified", additions: 4, deletions: 1, patch: "@@\n+x" }],
      [{ user: { login: "b" }, body: "second", created_at: "2026-11-09T03:00:00Z" }],
      [
        { user: { login: "c" }, body: "", state: "COMMENTED", submitted_at: "2026-11-09T01:30:00Z" },
        { user: { login: "d" }, body: "", state: "APPROVED", submitted_at: "2026-11-09T02:30:00Z" },
      ],
      [{ name: "typecheck", status: "completed", conclusion: "success", html_url: "u" }],
      [{ context: "vercel", state: "failure", target_url: "v" }],
    )
    expect(v.checks).toEqual([
      { name: "typecheck", state: "success", url: "u" },
      { name: "vercel", state: "failure", url: "v" },
    ])
    expect(v.comments.map((c) => c.author)).toEqual(["d", "b"])
    expect(v.files).toEqual([{ path: "a.ts", status: "modified", additions: 4, deletions: 1, patch: "@@\n+x" }])
    expect(v).toMatchObject({ head: "wt/192932-hive-script-list", base: "main", author: "mayoalexander", additions: 29 })
  })
})

describe("readPr", () => {
  test("a private repo GitHub will not show says why, never throws", async () => {
    const r = await readPr("https://github.com/FREELABEL/secret/pull/1", async () => ({ status: 404, json: undefined }))
    expect(r.state).toBe("no-access")
  })

  test("not a PR address is never fetched", async () => {
    let called = false
    const r = await readPr("https://example.com/", async () => {
      called = true
      return { status: 200, json: {} }
    })
    expect(r.state).toBe("invalid")
    expect(called).toBe(false)
  })

  test("reads the PR, then its parts, keyed off the head sha", async () => {
    const seen: string[] = []
    const r = await readPr("https://github.com/FREELABEL/iris-code/pull/3", async (path) => {
      seen.push(path)
      if (path.endsWith("/pulls/3")) return { status: 200, json: pr }
      if (path.includes("/check-runs")) return { status: 200, json: { check_runs: [] } }
      if (path.endsWith("/status")) return { status: 200, json: { statuses: [] } }
      return { status: 200, json: [] }
    })
    expect(r.state).toBe("ok")
    expect(seen).toContain("/repos/FREELABEL/iris-code/commits/abc123/check-runs?per_page=100")
  })
})
