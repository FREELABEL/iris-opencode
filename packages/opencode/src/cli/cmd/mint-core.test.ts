// Pin a NEGATIVE-offset timezone BEFORE anything constructs a Date. Under TZ=UTC
// the local and UTC calendar dates are identical by definition, so the two date
// regressions below pass vacuously — verified: reintroducing the original
// toISOString() bug left all 28 tests green until this line existed.
process.env.TZ = "America/Chicago"

import { describe, test, expect } from "bun:test"
import {
  ymd,
  periodWindow,
  parseAmountDollars,
  normalizeDate,
  fingerprint,
  centsOf,
  verifyAgainstSource,
  parseCsv,
  pickCol,
  DATE_COLS,
  AMT_COLS,
  DESC_COLS,
  sparkline,
  reconcile,
} from "./mint-core"

// =============================================================================
// Every test below that says REGRESSION is a bug that actually shipped on
// 2026-08-19 and was found by running the thing, not by reading it. They exist
// so the next person does not rediscover them with real money on the line.
// =============================================================================

describe("dates — local calendar, not UTC", () => {
  test("the suite is running somewhere the bug can actually appear", () => {
    // A guard on the instrument, not on the code. If this ever runs at UTC+0 the
    // two regressions below cannot fail, and a green suite would mean nothing.
    expect(new Date(2026, 7, 19).getTimezoneOffset()).not.toBe(0)
  })

  test("REGRESSION: an evening purchase does not file as tomorrow", () => {
    // toISOString() on 22:43 CDT yields the NEXT day. Anywhere west of UTC that
    // silently moved spending into the following day.
    const evening = new Date(2026, 7, 19, 22, 43, 0) // local 19 Aug, 22:43
    expect(ymd(evening)).toBe("2026-08-19")
  })

  test("REGRESSION: a Saturday-night buy stays in THIS week's budget", () => {
    // The dangerous version of the same bug: crossing into Sunday moves the
    // purchase into the next weekly window, corrupting the number being measured.
    const satNight = new Date(2026, 7, 22, 23, 30, 0) // Sat 22 Aug
    const [from, to] = periodWindow("weekly", satNight)
    expect(ymd(satNight) >= from && ymd(satNight) <= to).toBe(true)
    expect(to).toBe("2026-08-22")
  })

  test("weekly windows start SUNDAY — the shop/plan ritual", () => {
    const wed = new Date(2026, 7, 19)
    expect(periodWindow("weekly", wed)).toEqual(["2026-08-16", "2026-08-22"])
  })

  test("monthly and yearly cover the whole period", () => {
    const d = new Date(2026, 7, 19)
    expect(periodWindow("monthly", d)).toEqual(["2026-08-01", "2026-08-31"])
    expect(periodWindow("yearly", d)).toEqual(["2026-01-01", "2026-12-31"])
  })

  test("February leap-year boundary is real, not 30-day arithmetic", () => {
    expect(periodWindow("monthly", new Date(2028, 1, 10))[1]).toBe("2028-02-29")
    expect(periodWindow("monthly", new Date(2026, 1, 10))[1]).toBe("2026-02-28")
  })

  test("an unknown period falls back to monthly rather than throwing", () => {
    expect(periodWindow("fortnightly", new Date(2026, 7, 19))[0]).toBe("2026-08-01")
  })
})

describe("amounts — full precision, rounded once", () => {
  test("REGRESSION: sub-cent lines survive to be summed", () => {
    // The killer on usage exports: rounding each row to cents FIRST turned
    // hundreds of $0.004 lines into $0.00 and the day's total came up short.
    const rows = Array.from({ length: 250 }, () => parseAmountDollars("0.004")!)
    const summedThenRounded = centsOf({ amount: rows.reduce((a, b) => a + b, 0) })
    expect(summedThenRounded).toBe(100) // 250 × $0.004 = $1.00
    const roundedThenSummed = rows.reduce((a, b) => a + Math.round(b * 100), 0)
    expect(roundedThenSummed).toBe(0) // the old behaviour — proof it was lossy
  })

  test("scientific-notation zero from OpenAI exports parses", () => {
    expect(parseAmountDollars("0E-6176")).toBe(0)
  })

  test("currency formatting, thousands separators and parenthesised negatives", () => {
    expect(parseAmountDollars("$1,234.56")).toBeCloseTo(1234.56, 6)
    expect(parseAmountDollars("(12.34)")).toBeCloseTo(-12.34, 6)
    expect(parseAmountDollars("-7.00")).toBeCloseTo(-7, 6)
  })

  test("junk is null, NOT zero — a failed parse must not look like $0", () => {
    for (const bad of ["", "   ", "n/a", "pending", "--"]) {
      expect(parseAmountDollars(bad)).toBeNull()
    }
  })
})

describe("normalizeDate", () => {
  test("ISO, ISO datetime and US M/D/YYYY", () => {
    expect(normalizeDate("2026-02-01")).toBe("2026-02-01")
    expect(normalizeDate("2026-02-01T00:00:00")).toBe("2026-02-01")
    expect(normalizeDate("2/11/2026")).toBe("2026-02-11")
  })
  test("unparseable is null, not today", () => {
    expect(normalizeDate("")).toBeNull()
    expect(normalizeDate("whenever")).toBeNull()
  })
})

describe("fingerprint — idempotent re-import", () => {
  test("same statement row is the same key regardless of spacing or case", () => {
    const a = fingerprint("2026-02-11", 493, "OpenAI  API")
    const b = fingerprint("2026-02-11", 493, "openai api")
    expect(a).toBe(b)
  })
  test("a different amount is a different row", () => {
    expect(fingerprint("2026-02-11", 493, "x")).not.toBe(fingerprint("2026-02-11", 494, "x"))
  })
  test("a different date is a different row", () => {
    expect(fingerprint("2026-02-11", 493, "x")).not.toBe(fingerprint("2026-02-12", 493, "x"))
  })
})

describe("verifyAgainstSource — the gate on an 90%-precision model", () => {
  const body = "Thanks for riding. Total $51.97 charged on Aug 13, 2026."

  test("accepts an amount that appears literally", () => {
    const v = verifyAgainstSource({ amount: "51.97", date: "2026-08-13" }, body)
    expect(v.ok).toBe(true)
    expect(v.amount).toBe(51.97)
  })

  test("REJECTS a plausible amount that is NOT in the email", () => {
    // The whole reason the gate exists: the benchmark puts this model at 90%
    // precision, so a confident wrong number must never reach the ledger.
    const v = verifyAgainstSource({ amount: "51.79", date: "2026-08-13" }, body)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("not found")
  })

  test("rejects a missing amount, a zero, and an unusable date", () => {
    expect(verifyAgainstSource({ amount: "", date: "2026-08-13" }, body).ok).toBe(false)
    expect(verifyAgainstSource({ amount: "0.00", date: "2026-08-13" }, "total 0.00").ok).toBe(false)
    expect(verifyAgainstSource({ amount: "51.97", date: "" }, body).ok).toBe(false)
  })

  test("matches an amount written with thousands separators", () => {
    const inv = "Amount due: $1,234.56"
    expect(verifyAgainstSource({ amount: "1234.56", date: "2026-08-13" }, inv).ok).toBe(true)
  })

  test("rejects a non-numeric amount instead of coercing it", () => {
    expect(verifyAgainstSource({ amount: "fifty one", date: "2026-08-13" }, body).ok).toBe(false)
  })
})

describe("parseCsv", () => {
  test("quoted field containing a comma stays one field", () => {
    // Real OpenAI export: "gpt-4.1-nano-2025-04-14, cached input"
    const rows = parseCsv('a,b\n1,"gpt-4.1-nano, cached input"\n')
    expect(rows[1]).toEqual(["1", "gpt-4.1-nano, cached input"])
  })
  test("escaped quotes and CRLF", () => {
    expect(parseCsv('a\n"say ""hi"""\r\n')[1]).toEqual(['say "hi"'])
  })
  test("blank lines are dropped, not turned into empty rows", () => {
    expect(parseCsv("a,b\n1,2\n\n\n3,4\n")).toHaveLength(3)
  })
})

describe("pickCol — bank exports all name their columns differently", () => {
  const openai = ["start_time", "start_time_iso", "amount_value", "line_item"]
  test("auto-detects the OpenAI usage export", () => {
    expect(openai[pickCol(openai, DATE_COLS)]).toBe("start_time_iso")
    expect(openai[pickCol(openai, AMT_COLS)]).toBe("amount_value")
    expect(openai[pickCol(openai, DESC_COLS)]).toBe("line_item")
  })
  test("auto-detects a Chase-style export", () => {
    const chase = ["Transaction Date", "Post Date", "Description", "Category", "Amount"]
    expect(chase[pickCol(chase, DATE_COLS)]).toBe("Transaction Date")
    expect(chase[pickCol(chase, AMT_COLS)]).toBe("Amount")
  })
  test("an explicit override wins over detection", () => {
    expect(openai[pickCol(openai, DATE_COLS, "start_time")]).toBe("start_time")
  })
  test("returns -1 when nothing matches — the caller must not guess a column", () => {
    expect(pickCol(["foo", "bar"], AMT_COLS)).toBe(-1)
  })
})

describe("sparkline", () => {
  test("renders one glyph per point and survives a flat series", () => {
    expect(sparkline([1, 2, 3])).toHaveLength(3)
    expect(sparkline([5, 5, 5])).toHaveLength(3) // no divide-by-zero
    expect(sparkline([])).toBe("")
  })
})

describe("reconcile — can this number be defended?", () => {
  const base = { scope: "personal", from: "2026-08-01", to: "2026-08-31" }

  test("a figure that ties out is ok, with drift zero", () => {
    const r = reconcile({
      ...base,
      claimed_cents: 1500,
      rows: [
        { amount_cents: 1000, scope: "personal", date: "2026-08-05" },
        { amount_cents: 500, scope: "personal", date: "2026-08-20" },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.actual_cents).toBe(1500)
    expect(r.drift_cents).toBe(0)
    expect(r.counted).toBe(2)
  })

  test("drift is reported with the REASON, not just a delta", () => {
    // "off by $5" is useless; "one row is outside the window" is actionable.
    const r = reconcile({
      ...base,
      claimed_cents: 1500,
      rows: [
        { amount_cents: 1000, scope: "personal", date: "2026-08-05" },
        { amount_cents: 500, scope: "personal", date: "2026-09-02" },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.drift_cents).toBe(-500)
    expect(r.excluded).toContainEqual({ reason: "outside window", count: 1, cents: 500 })
  })

  test("REGRESSION: untagged rows are excluded, never counted as this scope", () => {
    // Defaulting untagged → personal would have pulled every legacy business
    // transaction into a personal budget on a category collision.
    const r = reconcile({
      ...base,
      claimed_cents: 0,
      rows: [{ amount_cents: 33000, date: "2026-08-05" }],
    })
    expect(r.ok).toBe(true)
    expect(r.actual_cents).toBe(0)
    expect(r.excluded).toContainEqual({ reason: "no scope tag", count: 1, cents: 33000 })
  })

  test("another scope's money never leaks in", () => {
    const r = reconcile({
      ...base,
      claimed_cents: 100,
      rows: [
        { amount_cents: 100, scope: "personal", date: "2026-08-05" },
        { amount_cents: 99999, scope: "business", date: "2026-08-05" },
        { amount_cents: 500, scope: "client:vanguard", date: "2026-08-05" },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.excluded.map((e) => e.reason).sort()).toEqual(["scope=business", "scope=client:vanguard"])
  })

  test("category filtering is case-insensitive but still exclusive", () => {
    const r = reconcile({
      ...base,
      category: "Groceries",
      claimed_cents: 700,
      rows: [
        { amount_cents: 700, scope: "personal", category: "groceries", date: "2026-08-05" },
        { amount_cents: 300, scope: "personal", category: "transportation", date: "2026-08-05" },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.excluded).toContainEqual({ reason: "category=transportation", count: 1, cents: 300 })
  })

  test("window boundaries are INCLUSIVE on both ends", () => {
    const r = reconcile({
      ...base,
      claimed_cents: 200,
      rows: [
        { amount_cents: 100, scope: "personal", date: "2026-08-01" },
        { amount_cents: 100, scope: "personal", date: "2026-08-31" },
      ],
    })
    expect(r.counted).toBe(2)
    expect(r.ok).toBe(true)
  })

  test("no rows at all is a clean zero, not a failure", () => {
    const r = reconcile({ ...base, claimed_cents: 0, rows: [] })
    expect(r.ok).toBe(true)
    expect(r.counted).toBe(0)
  })

  test("an ISO datetime in the date column still lands in the window", () => {
    const r = reconcile({
      ...base,
      claimed_cents: 100,
      rows: [{ amount_cents: 100, scope: "personal", date: "2026-08-05T00:00:00.000000Z" }],
    })
    expect(r.ok).toBe(true)
  })
})
