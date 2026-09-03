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
  sourceRef,
  classifySync,
  planSplit,
  reimbursableOf,
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

  test("REGRESSION: a split parent is excluded, not summed alongside its own children (#182035)", () => {
    const r = reconcile({
      ...base,
      claimed_cents: 60000,
      rows: [
        { amount_cents: 60000, scope: "personal", date: "2026-08-05", superseded_by_split: true },
        { amount_cents: 36000, scope: "personal", date: "2026-08-05" },
        { amount_cents: 24000, scope: "personal", date: "2026-08-05" },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.actual_cents).toBe(60000)
    expect(r.excluded).toContainEqual({ reason: "superseded by split", count: 1, cents: 60000 })
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

// =============================================================================
// Spending groups (#181985) + spend policy (#181986).
// =============================================================================

import {
  budgetCategories,
  groupResolves,
  coveredCategories,
  overlappingCategories,
  evaluatePolicy,
  groupViolations,
  overlappingBudgets,
  NO_POLICY,
} from "./mint-core"

const GROUPS = [
  { key: "food", name: "Food & Home", categories: ["groceries", "dining", "household"], active: true },
  { key: "wheels", name: "Getting Around", categories: ["transportation"], active: true },
  { key: "old", name: "Retired", categories: ["groceries"], active: false },
]

describe("spending groups", () => {
  test("a category budget measures exactly its own category", () => {
    expect(budgetCategories({ category: "groceries" }, GROUPS)).toEqual(["groceries"])
  })

  test("a group budget measures every member category", () => {
    expect(budgetCategories({ group: "food" }, GROUPS).sort()).toEqual(["dining", "groceries", "household"])
  })

  test("group membership is case- and whitespace-insensitive on both sides", () => {
    const g = [{ key: "Food", categories: [" Groceries ", "DINING"], active: true }]
    expect(budgetCategories({ group: "  fOOd " }, g).sort()).toEqual(["dining", "groceries"])
  })

  test("an inactive group is not a group", () => {
    expect(budgetCategories({ group: "old" }, GROUPS)).toEqual([])
    expect(groupResolves({ group: "old" }, GROUPS)).toBe(false)
  })

  test("a budget naming a group that does not exist measures NOTHING, and says so", () => {
    // The dangerous alternative is returning [] silently and letting it read as
    // a healthy $0 budget. groupResolves is what the CLI prints a warning from.
    expect(budgetCategories({ group: "typo" }, GROUPS)).toEqual([])
    expect(groupResolves({ group: "typo" }, GROUPS)).toBe(false)
    expect(groupResolves({ category: "groceries" }, GROUPS)).toBe(true)
  })

  test("coveredCategories expands groups — the double-count guard", () => {
    // REGRESSION GUARD: unbudgetedSpend used to subtract budgets.map(b=>b.category).
    // With a group budget those are undefined, so every member category would
    // have reappeared as "unbudgeted" while ALSO being inside the group total —
    // the same dollars reported twice, in two places that each looked right.
    const budgets = [{ group: "food", active: true }, { category: "transportation", active: true }]
    expect(coveredCategories(budgets, GROUPS).sort()).toEqual([
      "dining",
      "groceries",
      "household",
      "transportation",
    ])
  })

  test("coveredCategories ignores inactive budgets", () => {
    expect(coveredCategories([{ group: "food", active: false }], GROUPS)).toEqual([])
  })

  test("a category in two active groups is reported as overlapping, not silently picked", () => {
    const g = [
      { key: "food", categories: ["groceries"], active: true },
      { key: "essentials", categories: ["groceries", "household"], active: true },
    ]
    const dupes = overlappingCategories(g)
    expect(dupes).toHaveLength(1)
    expect(dupes[0].category).toBe("groceries")
    expect(dupes[0].groups.sort()).toEqual(["essentials", "food"])
  })

  test("an inactive group cannot create an overlap", () => {
    // GROUPS has "old" (inactive) also claiming groceries.
    expect(overlappingCategories(GROUPS)).toEqual([])
  })
})

describe("spend policy", () => {
  const KNOWN = ["groceries", "dining", "household", "transportation"]

  test("no policy means no enforcement — an upgrade cannot invalidate an old ledger", () => {
    expect(evaluatePolicy({ amount_cents: 2000 }, null, KNOWN)).toEqual([])
    expect(evaluatePolicy({ amount_cents: 2000 }, NO_POLICY, KNOWN)).toEqual([])
  })

  test("an explicitly inactive policy enforces nothing", () => {
    const p = { require_category: true, active: false }
    expect(evaluatePolicy({ amount_cents: 2000 }, p, KNOWN)).toEqual([])
  })

  test("require_category catches the exact row that started this — `mint spend 20 stuff`", () => {
    const v = evaluatePolicy({ amount_cents: 2000, description: "stuff" }, { require_category: true }, KNOWN)
    expect(v.map((x) => x.code)).toEqual(["category_required"])
  })

  test("every violation is returned, not just the first", () => {
    const v = evaluatePolicy(
      { amount_cents: 900000, description: "" },
      { require_category: true, require_description: true, max_single_expense: 500 },
      KNOWN,
    )
    expect(v.map((x) => x.code).sort()).toEqual(["category_required", "description_required", "over_single_limit"])
  })

  test("max_single_expense compares in CENTS — no float drift at the boundary", () => {
    const p = { max_single_expense: 150 }
    expect(evaluatePolicy({ amount_cents: 15000 }, p, KNOWN)).toEqual([]) // exactly at the cap is fine
    expect(evaluatePolicy({ amount_cents: 15001 }, p, KNOWN).map((x) => x.code)).toEqual(["over_single_limit"])
  })

  test("a zero or null limit is not a limit of zero", () => {
    expect(evaluatePolicy({ amount_cents: 99999 }, { max_single_expense: 0 }, KNOWN)).toEqual([])
    expect(evaluatePolicy({ amount_cents: 99999 }, { max_single_expense: null }, KNOWN)).toEqual([])
  })

  test("allowed_categories rejects an off-list category and permits a listed one", () => {
    const p = { allowed_categories: ["groceries", "household"] }
    expect(evaluatePolicy({ category: "dining" }, p, KNOWN).map((x) => x.code)).toEqual(["category_not_allowed"])
    expect(evaluatePolicy({ category: "GROCERIES" }, p, KNOWN)).toEqual([])
  })

  test("an empty allowed_categories is not an allowlist of nothing", () => {
    expect(evaluatePolicy({ category: "dining" }, { allowed_categories: [] }, KNOWN)).toEqual([])
  })

  test("declared_only refuses to enforce against an EMPTY declared set", () => {
    // Switching this on before any account is loaded would otherwise reject every
    // write, and read as "mint is broken" rather than "nothing is declared yet".
    const p = { declared_only: true }
    expect(evaluatePolicy({ category: "groceries" }, p, [])).toEqual([])
    expect(evaluatePolicy({ category: "nonsense" }, p, KNOWN).map((x) => x.code)).toEqual(["category_undeclared"])
  })

  test("declared_only says nothing about an uncategorised row — that is require_category's job", () => {
    expect(evaluatePolicy({ category: "" }, { declared_only: true }, KNOWN)).toEqual([])
  })

  test("require_group flags a category that belongs to no group", () => {
    const v = groupViolations({ category: "coffee" }, { require_group: true }, GROUPS)
    expect(v.map((x) => x.code)).toEqual(["group_required"])
    expect(groupViolations({ category: "household" }, { require_group: true }, GROUPS)).toEqual([])
  })

  test("require_group does not double-report an uncategorised row", () => {
    // require_category already fires on this. Two errors for one missing field
    // is how a person concludes the tool is nagging and reaches for --force.
    expect(groupViolations({ category: "" }, { require_group: true }, GROUPS)).toEqual([])
  })

  test("require_group ignores an inactive group's members", () => {
    // "old" is inactive and claims groceries; only "food" should satisfy it.
    const onlyOld = [{ key: "old", categories: ["coffee"], active: false }]
    expect(groupViolations({ category: "coffee" }, { require_group: true }, onlyOld).map((x) => x.code)).toEqual([
      "group_required",
    ])
  })
})

describe("overlapping budgets (groups make this newly possible)", () => {
  const G = [{ key: "food", categories: ["groceries", "household", "dining"], active: true }]

  test("a group budget and a legacy category budget covering the same category are flagged", () => {
    const budgets = [
      { name: "Food & Home", group: "food", active: true },
      { name: "Groceries — monthly", category: "groceries", active: true },
    ]
    const o = overlappingBudgets(budgets, G)
    expect(o).toHaveLength(1)
    expect(o[0].category).toBe("groceries")
    expect(o[0].budgets.sort()).toEqual(["Food & Home", "Groceries — monthly"])
  })

  test("two budgets on DIFFERENT periods still overlap — a month and a week both count the same dollar", () => {
    const budgets = [
      { name: "monthly", category: "groceries", period: "monthly", active: true },
      { name: "weekly", category: "groceries", period: "weekly", active: true },
    ]
    expect(overlappingBudgets(budgets, G)).toHaveLength(1)
  })

  test("no overlap when budgets cover disjoint categories", () => {
    const budgets = [
      { name: "a", category: "groceries", active: true },
      { name: "b", category: "transportation", active: true },
    ]
    expect(overlappingBudgets(budgets, G)).toEqual([])
  })

  test("an inactive budget cannot create an overlap", () => {
    const budgets = [
      { name: "Food & Home", group: "food", active: true },
      { name: "old", category: "groceries", active: false },
    ]
    expect(overlappingBudgets(budgets, G)).toEqual([])
  })
})

describe("sourceRef — a dedup key that does not include the amount (#182038)", () => {
  test("joins non-empty parts with |", () => {
    expect(sourceRef(["meta", "acct123", "campaign456", "2026-08-23"])).toBe("meta|acct123|campaign456|2026-08-23")
  })

  test("drops empty/null/undefined parts rather than leaving a bare |", () => {
    expect(sourceRef(["meta", null, "", undefined, "2026-08-23"])).toBe("meta|2026-08-23")
  })

  test("numbers are stringified the same as strings", () => {
    expect(sourceRef(["meta", 123, "2026-08-23"])).toBe(sourceRef(["meta", "123", "2026-08-23"]))
  })
})

describe("classifySync — re-syncing the same source_ref (#182038)", () => {
  test("no existing row is fresh", () => {
    expect(classifySync(undefined, 4100)).toBe("fresh")
  })

  test("same amount on re-sync is a duplicate, not a correction", () => {
    expect(classifySync(4100, 4100)).toBe("duplicate")
  })

  test("REGRESSION: a platform's stats finalizing mid-day is a correction, not a second row", () => {
    // This is the exact failure `fingerprint` cannot survive — the same logical
    // fact reported twice with two different amounts.
    expect(classifySync(4100, 4620)).toBe("correction")
    expect(classifySync(4620, 4100)).toBe("correction")
  })
})

describe("planSplit — one invoice across several campaigns (#182035)", () => {
  test("parts that sum exactly to the total succeed, in order", () => {
    const r = planSplit(60000, [
      { label: "campaignA", cents: 36000 },
      { label: "campaignB", cents: 24000 },
    ])
    expect(r).toEqual([
      { label: "campaignA", cents: 36000 },
      { label: "campaignB", cents: 24000 },
    ])
  })

  test("REGRESSION: a split that does not sum to the invoice is refused, not silently rounded", () => {
    const r = planSplit(60000, [
      { label: "campaignA", cents: 36000 },
      { label: "campaignB", cents: 23000 },
    ]) as { error: string }
    expect(r.error).toMatch(/drift of \$10\.00/)
    expect(r.error).toMatch(/\$590\.00/)
    expect(r.error).toMatch(/\$600\.00/)
  })

  test("no parts is refused", () => {
    expect((planSplit(1000, []) as { error: string }).error).toMatch(/no split parts/)
  })

  test("a zero or negative part is refused", () => {
    const r = planSplit(1000, [{ label: "a", cents: 0 }]) as { error: string }
    expect(r.error).toMatch(/positive amount/)
  })

  test("an unlabeled part is refused", () => {
    const r = planSplit(1000, [{ label: "  ", cents: 1000 }]) as { error: string }
    expect(r.error).toMatch(/needs a label/)
  })
})

describe("reimbursableOf — business-paid-from-personal (#182036)", () => {
  test("no paid_from recorded is not a reimbursable — every pre-existing row", () => {
    expect(reimbursableOf({ metadata: { scope: "business" } })).toBeNull()
  })

  test("paid_from equal to scope is not a reimbursable", () => {
    expect(reimbursableOf({ metadata: { scope: "business", paid_from: "business" } })).toBeNull()
  })

  test("REGRESSION: a business ad bought on a personal card is owed business → personal", () => {
    // Business benefited from the spend, personal fronted the cash — business
    // owes personal, not the other way around.
    const r = reimbursableOf({ metadata: { scope: "business", paid_from: "personal" } })
    expect(r).toEqual({ owed_by: "business", owed_to: "personal" })
  })
})
