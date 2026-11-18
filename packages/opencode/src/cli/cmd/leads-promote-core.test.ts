import { describe, expect, test } from "bun:test"
import {
  apolloIdOf,
  companyKey,
  formatPlan,
  nameMatchesHint,
  parseWhere,
  planPromotion,
  rowMatches,
  seniorityScore,
  type DatasetRow,
} from "./leads-promote-core"

let nextId = 1
function row(data: Record<string, unknown>, ext?: string): DatasetRow {
  const id = nextId++
  const external_id = ext ?? `apollo:a${id.toString(16).padStart(6, "0")}`
  return { id, external_id, data: { stage: "found", fit: "strong", has_email: true, external_id, ...data } }
}

describe("parseWhere / rowMatches", () => {
  test("AND across commas, OR across pipes, != negates", () => {
    const w = parseWhere("product=iris-terra, fit=strong|check, stage!=dropped")
    expect(w).toEqual([
      { key: "product", values: ["iris-terra"], negate: false },
      { key: "fit", values: ["strong", "check"], negate: false },
      { key: "stage", values: ["dropped"], negate: true },
    ])
    expect(rowMatches(row({ product: "iris-terra", fit: "check" }), w)).toBe(true)
    expect(rowMatches(row({ product: "iris-terra", fit: "drop" }), w)).toBe(false)
    expect(rowMatches(row({ product: "iris-orbit" }), w)).toBe(false)
    expect(rowMatches(row({ product: "iris-terra", stage: "dropped" }), w)).toBe(false)
  })

  test("case-insensitive; booleans compare as strings", () => {
    expect(rowMatches(row({ product: "IRIS-Terra", has_email: false }), parseWhere("product=iris-terra,has_email=false"))).toBe(true)
  })

  test("empty where selects everything; a typo throws instead of selecting everyone", () => {
    expect(parseWhere("")).toEqual([])
    expect(parseWhere(undefined)).toEqual([])
    expect(() => parseWhere("product")).toThrow(/key=value/)
    expect(() => parseWhere("product=")).toThrow(/no value/)
  })
})

describe("identity", () => {
  test("apollo id comes from external_id only when it is apollo:<id>", () => {
    expect(apolloIdOf({ id: 1, external_id: "apollo:6845d247b6e90d0001d2ec66", data: {} })).toBe("6845d247b6e90d0001d2ec66")
    expect(apolloIdOf({ id: 1, external_id: "hubspot:12", data: {} })).toBeNull()
    expect(apolloIdOf({ id: 1, external_id: null, data: { external_id: "apollo:abc" } })).toBe("abc")
  })

  test("company key prefers domain, else a normalised name", () => {
    expect(companyKey(row({ company: "X", company_domain: "https://www.Acme.com/about" }))).toBe("domain:acme.com")
    expect(companyKey(row({ company: "Acme, Inc." }))).toBe(companyKey(row({ company: "ACME inc" })))
    expect(companyKey(row({ company: "Acme Inc" }))).toBe("name:acme")
    const r = row({ company: null })
    expect(companyKey(r)).toBe(`row:${r.id}`)
  })

  test("seniority ranks buyers above coordinators", () => {
    expect(seniorityScore("Founder & CEO")).toBeGreaterThan(seniorityScore("VP Operations"))
    expect(seniorityScore("VP Operations")).toBeGreaterThan(seniorityScore("Director of Land"))
    expect(seniorityScore("Director of Land")).toBeGreaterThan(seniorityScore("Project Manager"))
    expect(seniorityScore("Project Manager")).toBeGreaterThan(seniorityScore("Business Development Coordinator"))
  })
})

describe("planPromotion", () => {
  const base = { perCompany: 3, limit: 150, enrich: false }

  test("takes up to N per company, most senior first", () => {
    const rows = [
      row({ company: "Acme", title: "Coordinator" }),
      row({ company: "Acme", title: "CEO" }),
      row({ company: "Acme", title: "Project Manager" }),
      row({ company: "Acme", title: "VP Sales" }),
    ]
    const plan = planPromotion(rows, { ...base, perCompany: 3 })
    expect(plan.companies).toHaveLength(1)
    expect(plan.picks.map((p) => p.row.data.title)).toEqual(["CEO", "VP Sales", "Project Manager"])
  })

  test("--limit counts companies; deeper companies rank first (#193518: go deep)", () => {
    const rows = [
      row({ company: "Solo", title: "CEO" }),
      row({ company: "Deep", title: "Manager" }),
      row({ company: "Deep", title: "Manager" }),
      row({ company: "Deep", title: "Manager" }),
      row({ company: "Pair", title: "Director" }),
      row({ company: "Pair", title: "Director" }),
    ]
    const plan = planPromotion(rows, { ...base, limit: 2 })
    expect(plan.companies.map((c) => c.name)).toEqual(["Deep", "Pair"])
    expect(plan.companiesAvailable).toBe(3)
    expect(plan.picks).toHaveLength(5)
  })

  test("without --enrich: spends 0, but reports what enriching would cost", () => {
    const rows = [row({ company: "A" }), row({ company: "B" }), row({ company: "C", email: "c@c.com" })]
    const plan = planPromotion(rows, base)
    expect(plan.credits).toBe(0)
    expect(plan.creditsUncapped).toBe(2)
    expect(plan.counts.needs_enrich).toBe(2)
    expect(plan.counts.import).toBe(1)
  })

  test("--enrich + --max-credits: the cap is exact and the rest stay staged", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ company: `Co${i}` }))
    const plan = planPromotion(rows, { ...base, enrich: true, maxCredits: 3 })
    expect(plan.credits).toBe(3)
    expect(plan.creditsUncapped).toBe(5)
    expect(plan.counts.enrich).toBe(3)
    expect(plan.counts.over_cap).toBe(2)
    expect(plan.picks.reduce((s, p) => s + p.credits, 0)).toBe(3)
  })

  test("--max-credits 0 spends nothing", () => {
    const plan = planPromotion([row({ company: "A" })], { ...base, enrich: true, maxCredits: 0 })
    expect(plan.credits).toBe(0)
    expect(plan.counts.over_cap).toBe(1)
  })

  test("Apollo has_email=false is not enriched unless asked (a credit for nothing)", () => {
    const rows = [row({ company: "A", has_email: false })]
    expect(planPromotion(rows, { ...base, enrich: true, maxCredits: 10 }).counts.no_email_on_file).toBe(1)
    expect(planPromotion(rows, { ...base, enrich: true, maxCredits: 10, includeNoEmail: true }).credits).toBe(1)
  })

  test("idempotent: never pays twice for the same Apollo person", () => {
    const inCrm = row({ company: "A", crm_lead_id: 77 })
    const leadExists = row({ company: "B" })
    const paidNoEmail = row({ company: "C", enriched_at: "2026-11-14", email: null })
    const paidWithEmail = row({ company: "D", enriched_at: "2026-11-14", email: "d@d.com" })
    const review = row({ company: "E", stage: "needs_review" })
    const dropped = row({ company: "F", stage: "dropped" })
    const notApollo = row({ company: "G" }, "manual:1")
    const fresh = row({ company: "H" })
    const dupe: DatasetRow = { ...fresh, id: fresh.id + 1000 }
    const plan = planPromotion(
      [inCrm, leadExists, paidNoEmail, paidWithEmail, review, dropped, notApollo, fresh, dupe],
      { ...base, enrich: true, maxCredits: 100 },
      new Set([leadExists.external_id!]),
    )
    expect(plan.skips.map((s): string => s.reason).sort()).toEqual(
      ["already_enriched_no_email", "already_in_crm", "dropped", "lead_exists", "needs_review", "not_apollo"].sort(),
    )
    expect(plan.credits).toBe(1) // only `fresh`; the duplicate row is planned once
    expect(plan.picks.find((p) => p.row === paidWithEmail)?.action).toBe("import")
  })

  test("formatPlan states the credit count plainly", () => {
    const rows = [row({ company: "A", first_name: "Lauren", last_name_hint: "Ed***s", title: "CEO" })]
    const lines = formatPlan(planPromotion(rows, { ...base, enrich: true, maxCredits: 5 }), { ...base, enrich: true, maxCredits: 5 })
    expect(lines.some((l) => l.includes("Lauren Ed***s — CEO"))).toBe(true)
    expect(lines.at(-1)).toBe("CREDITS: this run would spend 1 Apollo credit(s)")
    const dry = formatPlan(planPromotion(rows, base), base)
    expect(dry.at(-1)).toContain("enriching these would cost 1 credit(s)")
  })
})

describe("nameMatchesHint", () => {
  test("masked last name: head and tail must fit", () => {
    expect(nameMatchesHint({ first_name: "Lauren", last_name_hint: "Ed***s" }, { first_name: "Lauren", last_name: "Edwards" }).ok).toBe(true)
    expect(nameMatchesHint({ first_name: "Lauren", last_name_hint: "Ed***s" }, { first_name: "Lauren", last_name: "Edward" }).ok).toBe(false)
    expect(nameMatchesHint({ first_name: "Lauren", last_name_hint: "Ed***s" }, { first_name: "Lauren", last_name: "Es" }).ok).toBe(false)
  })

  test("first-name nicknames by prefix pass; a different person fails", () => {
    expect(nameMatchesHint({ first_name: "Chris", last_name_hint: "Wi***t" }, { first_name: "Christopher", last_name: "Willett" }).ok).toBe(true)
    const r = nameMatchesHint({ first_name: "Carrie", last_name_hint: "Wi***t" }, { first_name: "Dana", last_name: "Willett" })
    expect(r.ok).toBe(false)
    expect(r.why).toContain("first name")
  })

  test("no name back is not a match", () => {
    expect(nameMatchesHint({ first_name: "A" }, {}).ok).toBe(false)
  })
})

describe("company ranking favours people we can reach", () => {
  test("a company whose picks have no email on file ranks below one we can work", () => {
    const rows = [
      row({ company: "Dark", title: "CEO", has_email: false }),
      row({ company: "Dark", title: "CEO", has_email: false }),
      row({ company: "Lit", title: "Manager" }),
    ]
    const plan = planPromotion(rows, { perCompany: 3, limit: 1, enrich: true, maxCredits: 10 })
    expect(plan.companies.map((c) => c.name)).toEqual(["Lit"])
  })
})
