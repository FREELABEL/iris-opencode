import { describe, expect, test } from "bun:test"
import {
  baseFromPage,
  readBase,
  stripBase,
  expectedVersionField,
  handleVersionConflictResponse,
} from "./page-base"

/**
 * GLD-01 — local file provenance for `iris pages pull` / `push`.
 *
 * #183600: `pages pull` wrote 12 keys and not one of them was a version, hash or timestamp,
 * and `pages push` sent an unconditional full-document PUT. A stale local file therefore
 * reverted a client dashboard through three newer versions on 2026-09-03 and printed "Done".
 *
 * The guard is the integer `version`, checked SERVER-side. Deliberately not a timestamp and
 * deliberately not a locally recomputed hash: #181984 records a stale-file guard whose two
 * inputs shared a failure mode (it compared a local value against the same endpoint the pull
 * had just read) and so went blind exactly when it was needed. `current_version` is
 * incremented by the transaction that writes, so it cannot agree with a stale read.
 */

describe("baseFromPage — what `pull` stamps on the file", () => {
  const NOW = "2026-09-04T10:00:00.000Z"

  test("reads current_version and stores the server's json_hash VERBATIM", () => {
    const b = baseFromPage({ current_version: 89, json_hash: "9f8b7c6d5e4f" }, NOW)
    expect(b).toEqual({ version: 89, hash: "9f8b7c6d5e4f", pulled_at: NOW })
  })

  test("does NOT compute a hash of its own when the server sent none", () => {
    // Reproducing PHP's JSON_PRETTY_PRINT byte-for-byte in JS is a bug farm. hash is
    // diagnostic only; the check is on `version`.
    const b = baseFromPage({ current_version: 4, json_content: { components: [] } }, NOW)
    expect(b!.hash).toBeNull()
    expect(b!.version).toBe(4)
  })

  test("returns null when the server exposes no current_version — no marker, no guard", () => {
    // The server half of the contract may not be deployed yet. Writing a marker we cannot
    // trust would be worse than writing none: push would send an expected_version the
    // server has no opinion about, or worse, a wrong one.
    expect(baseFromPage({ id: 12, json_content: {} }, NOW)).toBeNull()
  })

  test("never mistakes json_content.version (a SCHEMA version) for the page version", () => {
    // json_content.version is "1.0"/2 style schema metadata on every Genesis page.
    expect(baseFromPage({ id: 12, json_content: { version: 2 } }, NOW)).toBeNull()
  })

  test("refuses a non-integer current_version rather than stamping nonsense", () => {
    expect(baseFromPage({ current_version: "not-a-number" }, NOW)).toBeNull()
    expect(baseFromPage({ current_version: 1.5 }, NOW)).toBeNull()
  })
})

describe("readBase — what `push` trusts on the way back out", () => {
  test("reads a well-formed top-level _base", () => {
    expect(readBase({ _base: { version: 89, hash: "abc", pulled_at: "x" } })).toEqual({
      version: 89,
      hash: "abc",
      pulled_at: "x",
    })
  })

  test("accepts a hand-edited numeric string version", () => {
    expect(readBase({ _base: { version: "89" } })?.version).toBe(89)
  })

  test("returns null with no _base — absence of a marker is not a reason to refuse", () => {
    // Same call `bloqs publish` makes on a missing frontmatter marker: proceed.
    expect(readBase({ title: "hand written" })).toBeNull()
  })

  test("returns null for a garbage _base rather than sending a garbage expected_version", () => {
    expect(readBase({ _base: {} })).toBeNull()
    expect(readBase({ _base: "89" })).toBeNull()
    expect(readBase({ _base: { version: null } })).toBeNull()
  })

  test("IGNORES a _base hiding inside json_content — provenance is not content", () => {
    // json_content renders. A _base in there would be shipped to the browser, and reading
    // it here would legitimise writing it there.
    expect(readBase({ json_content: { _base: { version: 89 } } })).toBeNull()
  })
})

describe("stripBase / expectedVersionField — what actually goes on the wire", () => {
  test("strips the top-level _base from the pushed document", () => {
    // "The server ignoring an unknown key is not a licence to send it."
    const doc = { _base: { version: 89 }, title: "T", json_content: { components: [] } }
    expect(stripBase(doc)).toEqual({ title: "T", json_content: { components: [] } } as any)
  })

  test("does not mutate the caller's document", () => {
    const doc: any = { _base: { version: 89 }, title: "T" }
    stripBase(doc)
    expect(doc._base).toEqual({ version: 89 })
  })

  test("leaves json_content alone", () => {
    const doc = { _base: { version: 1 }, json_content: { components: [{ id: "a" }], theme: "dark" } }
    expect(stripBase(doc).json_content).toEqual({ components: [{ id: "a" }], theme: "dark" })
  })

  test("sends expected_version when a base is present", () => {
    expect(expectedVersionField({ _base: { version: 89 } })).toEqual({ expected_version: 89 })
  })

  test("sends NOTHING when there is no base — backward compatible with hand-written files", () => {
    expect(expectedVersionField({ title: "hand written" })).toEqual({})
  })
})

describe("handleVersionConflictResponse — the 409", () => {
  const BODY = {
    success: false,
    message: "This page changed since you pulled it.",
    error_code: "version_conflict",
    expected_version: 89,
    current_version: 91,
    changed_by: 193,
    changed_at: "2026-09-04T01:27:40+00:00",
    changed_components: ["cmp_a1b2c3", "cmp_d4e5f6"],
  }

  test("a 409 is a conflict", () => {
    expect(handleVersionConflictResponse("docs", 409, BODY).conflicted).toBe(true)
  })

  test("a 200 is not", () => {
    expect(handleVersionConflictResponse("docs", 200, {}).conflicted).toBe(false)
  })

  test("a 422 is not — that is validation, and it has its own message", () => {
    expect(handleVersionConflictResponse("docs", 422, { message: "bad" }).conflicted).toBe(false)
  })

  test("EXITS NON-ZERO — a refusal that exits 0 is read by a script as success (#181601)", () => {
    expect(handleVersionConflictResponse("docs", 409, BODY).exitCode).toBeGreaterThan(0)
  })

  test("prints who, when, and which components moved", () => {
    const out = handleVersionConflictResponse("docs", 409, BODY).lines.join("\n")
    expect(out).toContain("89")
    expect(out).toContain("91")
    expect(out).toContain("193")
    expect(out).toContain("2026-09-04T01:27:40+00:00")
    expect(out).toContain("cmp_a1b2c3")
    expect(out).toContain("cmp_d4e5f6")
  })

  test("points at `pages merge` — it never merges implicitly", () => {
    const out = handleVersionConflictResponse("docs", 409, BODY).lines.join("\n")
    expect(out).toContain("iris pages merge docs")
  })

  test("does not invent a changed_by / changed_at the server sent as null", () => {
    const out = handleVersionConflictResponse(
      "docs",
      409,
      { ...BODY, changed_by: null, changed_at: null },
    ).lines.join("\n")
    expect(out).toContain("unknown")
    expect(out).not.toContain("193")
  })

  test("says so plainly when the change was page-level only (empty changed_components)", () => {
    // AMENDED 2026-09-04: an empty list alone no longer means "page-level only" — it also
    // means "could not load the base snapshot". `base_available` is what separates the two.
    // See the base_available block below.
    const out = handleVersionConflictResponse(
      "docs",
      409,
      { ...BODY, changed_components: [], base_available: true },
    ).lines.join("\n")
    expect(out).toMatch(/page-level/i)
  })

  test("still refuses when the body is unparseable — the STATUS is the check", () => {
    const r = handleVersionConflictResponse("docs", 409, null)
    expect(r.conflicted).toBe(true)
    expect(r.exitCode).toBeGreaterThan(0)
    expect(r.lines.join("\n")).toContain("iris pages merge docs")
  })
})

/**
 * CONTRACT AMENDMENT (2026-09-04) — `base_available: boolean` on the 409 body.
 *
 * `changed_components: []` was ambiguous: it meant BOTH "the change was page-level only" and
 * "I could not load the expected_version snapshot, so I could not compute the diff". Versions
 * written before database snapshotting carry a `db://` gcs_path with a null json_content, and
 * pruned versions are simply gone.
 *
 * A value that cannot tell ABSENT from EQUAL is the exact defect this epic exists to fix, so
 * reporting "page-level only" off an empty array would reintroduce it one layer up.
 */
describe("handleVersionConflictResponse — base_available", () => {
  const BODY = {
    error_code: "version_conflict",
    expected_version: 89,
    current_version: 91,
    changed_by: 193,
    changed_at: "2026-09-04T01:27:40+00:00",
    changed_components: [],
  }

  test("base_available:false says it could not tell — never 'page-level only'", () => {
    const out = handleVersionConflictResponse("docs", 409, { ...BODY, base_available: false }).lines.join("\n")
    expect(out).toMatch(/could not determine which components changed/i)
    expect(out).not.toMatch(/page-level/i)
  })

  test("base_available:true with an empty list IS a page-level change", () => {
    const out = handleVersionConflictResponse("docs", 409, { ...BODY, base_available: true }).lines.join("\n")
    expect(out).toMatch(/page-level/i)
  })

  test("a missing base_available is read as 'could not tell', not as a finding", () => {
    // An older server, or a body we could not parse. Absence of the flag is not evidence the
    // diff was computed.
    const out = handleVersionConflictResponse("docs", 409, BODY).lines.join("\n")
    expect(out).toMatch(/could not determine which components changed/i)
  })

  test("a non-empty changed_components is a finding regardless of the flag", () => {
    const out = handleVersionConflictResponse("docs", 409, { ...BODY, changed_components: ["hero-0"] }).lines.join("\n")
    expect(out).toContain("hero-0")
    expect(out).not.toMatch(/could not determine/i)
  })
})

/**
 * CONTRACT AMENDMENT — `expected_version` is validated `min:1` server-side, so a 0 comes back
 * 422 (validation) rather than 409 (conflict). A guard that fires as a validation error is a
 * guard nobody can act on: the message names a field, not a concurrent edit.
 */
describe("expected_version is never sent falsy", () => {
  test("version 0 sends nothing rather than a 422", () => {
    expect(expectedVersionField({ _base: { version: 0 } })).toEqual({})
  })

  test("a page reporting current_version 0 gets no marker at all", () => {
    expect(baseFromPage({ current_version: 0, json_hash: "x" }, "now")).toBeNull()
  })

  test("v1 is a real version and is sent", () => {
    expect(expectedVersionField({ _base: { version: 1 } })).toEqual({ expected_version: 1 })
  })
})
