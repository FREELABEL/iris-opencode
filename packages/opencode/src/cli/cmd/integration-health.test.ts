import { describe, expect, test } from "bun:test"
import { describeAge, markerFor, formatRow, formatSummary } from "./integration-health"

/**
 * IH-08 — the CLI half of integration health (epic bloq #503 list #2315, closes #182476).
 *
 * These tests are about ONE thing: that the four states stay four. The bug being locked out is
 * not a wrong boolean, it is a collapse — "never checked" rendered as working (a green nobody
 * earned) or as failing (an alarm nobody deserved). `status` says 'active' for a connection
 * that has never been contacted, so any renderer reading status alone gets this wrong.
 */

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    type: "gmail",
    status: "active",
    state: "working",
    last_tested: new Date().toISOString(),
    last_error: null,
    ...over,
  }) as any

describe("describeAge", () => {
  test("null is 'never', not a date and not zero", () => {
    // The tempting bug is coalescing a missing timestamp to `now` so the column looks populated.
    // That renders a connection nobody ever probed as "checked 0s ago".
    expect(describeAge(null)).toBe("never")
  })

  test("an unparseable timestamp is 'unknown', not 'never'", () => {
    // "we have no timestamp" and "the timestamp is garbage" are different problems, and only
    // the first is a normal state.
    expect(describeAge("not-a-date")).toBe("unknown")
  })

  test("it scales through seconds, minutes, hours and days", () => {
    const now = Date.parse("2026-09-04T12:00:00Z")
    const at = (ms: number) => describeAge(new Date(now - ms).toISOString(), now)

    expect(at(30_000)).toBe("30s ago")
    expect(at(4 * 60_000)).toBe("4m ago")
    expect(at(3 * 3600_000)).toBe("3h ago")
    expect(at(2 * 86_400_000)).toBe("2d ago")
  })

  test("a future timestamp does not render as a negative age", () => {
    const now = Date.parse("2026-09-04T12:00:00Z")
    expect(describeAge(new Date(now + 60_000).toISOString(), now)).toBe("0s ago")
  })
})

describe("markerFor", () => {
  test("never_checked is neither the pass marker nor the fail marker", () => {
    // The whole epic in one assertion. An absence of evidence must not borrow either verdict.
    const unchecked = markerFor("never_checked")
    expect(unchecked).not.toBe(markerFor("working"))
    expect(unchecked).not.toBe(markerFor("failing"))
  })

  test("not_applicable is distinct from never_checked", () => {
    // "there is nothing to check" and "nobody has checked" are different facts about a
    // connector, and only the second one is something we owe the user an action on.
    expect(markerFor("not_applicable")).not.toBe(markerFor("never_checked"))
  })

  test("failing is distinct from working", () => {
    expect(markerFor("failing")).not.toBe(markerFor("working"))
  })
})

describe("formatRow", () => {
  test("a failing row prints the reason, because 'failed' alone is unactionable", () => {
    const line = formatRow(row({ state: "failing", last_error: "token rejected (401)" }))
    expect(line).toContain("token rejected (401)")
  })

  test("a failing row with no recorded reason says so rather than printing nothing", () => {
    const line = formatRow(row({ state: "failing", last_error: null }))
    expect(line).toContain("no reason recorded")
  })

  test("a never-checked row says 'never checked' and claims no age", () => {
    const line = formatRow(row({ state: "never_checked", last_tested: null }))
    expect(line).toContain("never checked")
    expect(line).not.toContain("ago")
  })

  test("a not-applicable row explains itself instead of showing a stale age", () => {
    const line = formatRow(row({ state: "not_applicable", last_tested: null }))
    expect(line).toContain("nothing to check")
  })

  test("the account is shown, so two accounts of one type are told apart", () => {
    const line = formatRow(row({ account: "alex@freelabel.net" }))
    expect(line).toContain("alex@freelabel.net")
  })
})

describe("formatSummary", () => {
  test("it counts every state, including the zeroes", () => {
    // "0 failing" must be a MEASURED zero on screen, not something the reader infers from an
    // absence of red lines — and a fleet where nothing was ever checked must not read as clean.
    const s = formatSummary([
      row({ state: "working" }),
      row({ state: "failing" }),
      row({ state: "never_checked" }),
    ])

    expect(s).toContain("1 working")
    expect(s).toContain("1 failing")
    expect(s).toContain("1 never checked")
    expect(s).toContain("0 n/a")
  })

  test("an all-unchecked fleet does not summarise as healthy", () => {
    const s = formatSummary([row({ state: "never_checked" }), row({ state: "never_checked" })])
    expect(s).toContain("0 working")
    expect(s).toContain("2 never checked")
  })
})
