import { describe, expect, test } from "bun:test"
import { expectedVersionField } from "./page-base"

/**
 * The version number alone cannot see an UNVERSIONED write.
 *
 * `Page::saveJsonToGcs` writes json_content, updates json_hash, rotates cache_key — and never
 * touches current_version. Six artisan seed commands call it directly, and `rollback` calls it
 * too. So the live content can move while the version stands still, and `expected_version`
 * matches happily while the document underneath is not the one that was pulled. That is the
 * same class of silent loss as #183600, through a door the version check does not watch.
 *
 * `_base.hash` is the server's own `json_hash`, stored verbatim at pull time (never recomputed
 * client-side — reproducing PHP's JSON_PRETTY_PRINT in JS is a bug farm). Sending it back lets
 * the SERVER answer "is the document you based this on still the document that is here?"
 *
 * Server-side deliberately, not a client-side warning: a CLI-only guard is skippable by the
 * builder, by MCP, by an agent, by an older binary — the same argument that put
 * expected_version in the endpoint rather than in the CLI.
 */
describe("expectedVersionField — version and hash travel together", () => {
  const base = (over: any = {}) => ({
    _base: { version: 7, hash: "abc123", pulled_at: "2026-09-04T00:00:00Z", ...over },
  })

  test("it sends both the version and the hash", () => {
    expect(expectedVersionField(base())).toEqual({ expected_version: 7, expected_hash: "abc123" })
  })

  test("a base with no hash sends the version alone, not a null hash", () => {
    // A page that has never been saved has json_hash = null. Sending `expected_hash: null`
    // would make the server compare against nothing and could read as "matches".
    expect(expectedVersionField(base({ hash: null }))).toEqual({ expected_version: 7 })
  })

  test("no base sends neither", () => {
    expect(expectedVersionField({})).toEqual({})
  })

  test("version 0 sends nothing at all, hash included", () => {
    // min:1 on the server means 0 is a 422, not the 409 the caller needs to see. The hash must
    // not leak out on its own — a hash with no version is a check the server cannot anchor.
    expect(expectedVersionField(base({ version: 0 }))).toEqual({})
  })

  test("a non-string hash is dropped rather than sent", () => {
    expect(expectedVersionField(base({ hash: 12345 }))).toEqual({ expected_version: 7 })
  })
})

import { handleVersionConflictResponse } from "./page-base"

describe("handleVersionConflictResponse — a content conflict is not a version conflict", () => {
  const body = {
    error_code: "content_conflict",
    expected_version: 7,
    current_version: 7,
    changed_by: 42,
    changed_at: "2026-09-04T12:00:00+00:00",
    changed_components: ["hero-0"],
    base_available: true,
  }

  test("it does not claim the version moved when it did not", () => {
    const out = handleVersionConflictResponse("probe", 409, body as any)
    const text = out.lines.join("\n")
    // "you pulled v7 / live now v7" reads as a bug in the tool, not a finding about the page.
    expect(text).not.toContain("live now:    v7")
    expect(text).toMatch(/still v7|without a new version|content changed/i)
  })

  test("it still refuses, still exits 1, and still points at merge", () => {
    const out = handleVersionConflictResponse("probe", 409, body as any)
    expect(out.conflicted).toBe(true)
    expect(out.exitCode).toBe(1)
    expect(out.lines.join("\n")).toContain("iris pages merge probe")
  })

  test("it names the components that moved", () => {
    expect(handleVersionConflictResponse("probe", 409, body as any).lines.join("\n")).toContain("hero-0")
  })

  test("a plain version conflict is unchanged", () => {
    const out = handleVersionConflictResponse("probe", 409, {
      ...body,
      error_code: "version_conflict",
      current_version: 9,
    } as any)
    expect(out.lines.join("\n")).toContain("live now:    v9")
  })
})
