import { describe, test, expect } from "bun:test"
import {
  admits,
  buildReport,
  diffLists,
  effectiveGate,
  expectedOwner,
  flagList,
  isValidDomain,
  isValidEmail,
  mergeGate,
  readGate,
  recoverStringGate,
  sameGate,
  wideningEntries,
  type Gate,
} from "./platform-sites-access-model"

const g = (allowedDomains: string[] = [], allowedEmails: string[] = [], extra: Partial<Gate> = {}): Gate => ({
  allowedDomains,
  allowedEmails,
  ...extra,
})

// The real failure (#192662): an agent wrote the gate through a path that stored it as text.
const STRING_GATE = "{allowedDomains:[a.com,b.com],allowedEmails:[x@y.com]}"

describe("string-gate detection", () => {
  test("a gate stored as the unquoted string is flagged, never trusted as a list", () => {
    const r = readGate(STRING_GATE)
    expect(r.storedAsString).toBe(true)
    expect(r.gate).toBeNull()
    expect(r.recovered).toEqual(g(["a.com", "b.com"], ["x@y.com"]))
  })

  test("a gate stored as a JSON string is still flagged (shape is wrong even if parseable)", () => {
    const r = readGate(JSON.stringify({ allowedDomains: ["a.com"], allowedEmails: [] }))
    expect(r.storedAsString).toBe(true)
    expect(r.recovered?.allowedDomains).toEqual(["a.com"])
  })

  test("an object gate is read and normalised; extra keys kept", () => {
    const r = readGate({ allowedDomains: ["A.com ", "a.com"], allowedEmails: ["X@Y.com"], showAllowedDomains: true })
    expect(r.storedAsString).toBe(false)
    expect(r.gate).toEqual({ allowedDomains: ["a.com"], allowedEmails: ["x@y.com"], showAllowedDomains: true })
  })

  test("missing gate is not a defect", () => {
    expect(readGate(undefined)).toMatchObject({ gate: null, storedAsString: false })
  })

  test("unrecognisable string recovers nothing", () => {
    expect(recoverStringGate("hello")).toBeNull()
  })
})

describe("email check", () => {
  const gate = g(["example.com"], ["guest@other.example.org"])
  test("domain match", () => expect(admits(gate, "Staff@Example.com")).toEqual({ allowed: true, reason: "domain" }))
  test("exact email match", () => expect(admits(gate, "guest@other.example.org").reason).toBe("email"))
  test("refused", () => expect(admits(gate, "someone@elsewhere.com")).toEqual({ allowed: false, reason: "not_on_list" }))
  test("subdomain is not the domain", () => expect(admits(gate, "a@sub.example.com").allowed).toBe(false))
  test("no list admits anyone", () => expect(admits(null, "a@b.com").reason).toBe("no_list"))
  test("malformed address refused when a list exists", () => expect(admits(gate, "nope").reason).toBe("malformed"))
})

describe("effective list = site ∩ page", () => {
  test("only the site set → site list", () => {
    expect(effectiveGate(g(["example.com"]), null)).toEqual(g(["example.com"]))
  })
  test("only the page set → page list", () => {
    expect(effectiveGate(null, g([], ["a@example.com"]))).toEqual(g([], ["a@example.com"]))
  })
  test("neither → no list", () => expect(effectiveGate(null, g())).toBeNull())
  test("page narrows the site's domains", () => {
    expect(effectiveGate(g(["example.com", "example.org"]), g(["example.com"]))).toEqual(g(["example.com"]))
  })
  test("page names one person inside a site domain → just that person", () => {
    expect(effectiveGate(g(["example.com"]), g([], ["boss@example.com"]))).toEqual(g([], ["boss@example.com"]))
  })
  test("page cannot widen: a domain the site does not admit is dropped", () => {
    const site = g(["example.com"])
    const page = g(["example.com", "evil.example.net"], ["x@outside.example.net"])
    expect(effectiveGate(site, page)).toEqual(g(["example.com"]))
    expect(wideningEntries(site, page)).toEqual(["@evil.example.net", "x@outside.example.net"])
  })
  test("site invite admitted by page domain survives", () => {
    expect(effectiveGate(g([], ["a@example.com"]), g(["example.com"]))).toEqual(g([], ["a@example.com"]))
  })
  test("disjoint lists leave nobody", () => {
    expect(effectiveGate(g(["example.com"]), g(["example.org"]))).toEqual(g())
  })
})

describe("diffing", () => {
  test("same list", () => expect(diffLists(g(["example.com"]), g(["example.com"])).same).toBe(true))
  test("different list", () => {
    expect(diffLists(g(["example.com"]), g(["example.org"], ["a@example.com"]))).toEqual({
      same: false,
      onlySite: ["@example.com"],
      onlyPage: ["@example.org", "a@example.com"],
    })
  })
})

describe("owner board", () => {
  test("a bloq-owned site sets the expected owner", () => {
    expect(expectedOwner("bloq:10", ["bloq:20", "bloq:20"])).toBe("bloq:10")
  })
  test("otherwise the majority of pages", () => {
    expect(expectedOwner("user:1", ["bloq:20", "bloq:30", "bloq:20"])).toBe("bloq:20")
  })
})

describe("doctor report", () => {
  const site = { id: 1, slug: "example-site", owner_type: "bloq", owner_id: 10 }
  const settings = { notification_emails: ["ops@example.com"], gate: { allowedDomains: ["example.com"], allowedEmails: [], requireOtp: true } }

  test("clean site reports ok", () => {
    const r = buildReport({
      site, settings,
      pages: [{ id: 5, slug: "home", owner_type: "bloq", owner_id: 10, json_content: { requireOtp: true } }],
    })
    expect(r.ok).toBe(true)
    expect(r.pages[0].effective).toEqual(g(["example.com"]))
  })

  test("the real failure: string gate, wrong board, own list — all flagged, staff refused only where they should be", () => {
    const r = buildReport({
      site, settings, email: "staff@example.com",
      pages: [
        { id: 5, slug: "home", owner_type: "bloq", owner_id: 10, json_content: { requireOtp: true } },
        { id: 6, slug: "intake", owner_type: "bloq", owner_id: 99, json_content: { requireOtp: true, gate: STRING_GATE } },
        { id: 7, slug: "reports", owner_type: "bloq", owner_id: 10, json_content: { requireOtp: true, gate: { allowedDomains: [], allowedEmails: ["boss@example.com"] } } },
      ],
    })
    expect(r.ok).toBe(false)
    const [home, intake, reports] = r.pages
    expect(home.flags).toEqual([])
    expect(home.email?.allowed).toBe(true)
    expect(intake.gateStoredAsString).toBe(true)
    expect(intake.ownerMismatch).toBe(true)
    expect(intake.flags.some((f) => f.includes("STRING"))).toBe(true)
    // a string gate enforces nothing of its own — the page falls back to the site list
    expect(intake.effective).toEqual(g(["example.com"]))
    expect(reports.differsFromSite).toBe(true)
    expect(reports.email).toMatchObject({ allowed: false })
    expect(reports.email?.reason).toContain("boss@example.com")
  })

  test("site gate stored as a string is a site-level flag", () => {
    const r = buildReport({ site, settings: { gate: STRING_GATE }, pages: [] })
    expect(r.siteGateStoredAsString).toBe(true)
    expect(r.ok).toBe(false)
  })

  test("page without sign-in on an OTP site is flagged", () => {
    const r = buildReport({ site, settings, pages: [{ id: 5, slug: "open", owner_type: "bloq", owner_id: 10, json_content: {} }] })
    expect(r.pages[0].flags).toContain("site requires sign-in but this page does not")
  })

  test("unreadable page is flagged, not silently skipped", () => {
    const r = buildReport({ site, settings, pages: [{ id: 8, slug: "gone", error: "not found or no access" }] })
    expect(r.ok).toBe(false)
  })
})

describe("merge (iris sites access)", () => {
  test("adds and removes, keeps other gate keys", () => {
    const m = mergeGate(
      { allowedDomains: ["example.com"], allowedEmails: ["old@example.org"], showAllowedDomains: false },
      { allowDomains: ["Example.org"], removeEmails: ["old@example.org"], allowEmails: ["new@example.net"], requireOtp: true },
    )
    expect(m.ok).toBe(true)
    expect(m.after).toEqual({ allowedDomains: ["example.com", "example.org"], allowedEmails: ["new@example.net"], showAllowedDomains: false, requireOtp: true })
    expect(m.changes).toContain("+ @example.org")
    expect(m.changes).toContain("- old@example.org")
    expect(m.changes).toContain("requireOtp: false → true")
  })

  test("never writes a string: a string gate is rebuilt as an object", () => {
    const m = mergeGate(STRING_GATE, { allowDomains: ["c.com"] })
    expect(m.ok).toBe(true)
    expect(typeof m.after).toBe("object")
    expect(m.after.allowedDomains).toEqual(["a.com", "b.com", "c.com"])
    expect(m.after.allowedEmails).toEqual(["x@y.com"])
    expect(m.repairedString).toBe(true)
  })

  test("refuses invalid entries with a clear message", () => {
    const m = mergeGate(undefined, { allowDomains: ["not a domain", "a@b.com"], allowEmails: ["nope"] })
    expect(m.ok).toBe(false)
    expect(m.errors).toEqual([
      `"not a domain" is not a valid domain`,
      `"a@b.com" looks like an email — use --allow-email`,
      `"nope" is not a valid email address`,
    ])
  })

  test("refuses to empty a configured list (empty = anyone)", () => {
    const m = mergeGate({ allowedDomains: ["example.com"], allowedEmails: [] }, { removeDomains: ["example.com"] })
    expect(m.ok).toBe(false)
  })

  test("no-op edit has no changes", () => {
    expect(mergeGate({ allowedDomains: ["example.com"], allowedEmails: [] }, { allowDomains: ["example.com"] }).changes).toEqual([])
  })

  test("read-back comparison", () => {
    expect(sameGate({ allowedDomains: ["b.com", "a.com"], allowedEmails: [], requireOtp: true }, g(["a.com", "b.com"], [], { requireOtp: true }))).toBe(true)
    expect(sameGate(STRING_GATE, g(["a.com", "b.com"], ["x@y.com"]))).toBe(false)
    expect(sameGate(undefined, g(["a.com"]))).toBe(false)
  })
})

describe("validation helpers", () => {
  test("domains", () => {
    expect(isValidDomain("example.com")).toBe(true)
    expect(isValidDomain("@example.com")).toBe(true)
    expect(isValidDomain("localhost")).toBe(false)
    expect(isValidDomain("exa mple.com")).toBe(false)
  })
  test("emails", () => {
    expect(isValidEmail("a.b+c@example.co.uk")).toBe(true)
    expect(isValidEmail("a@b")).toBe(false)
    expect(isValidEmail("a,b@example.com")).toBe(false)
  })
  test("flag lists split commas and repeats", () => {
    expect(flagList(["a.com,b.com", " c.com "])).toEqual(["a.com", "b.com", "c.com"])
    expect(flagList(undefined)).toEqual([])
  })
})

describe("email check respects sign-in", () => {
  test("a page that does not require sign-in admits anyone, and says so", () => {
    const r = buildReport({
      site: { id: 1, owner_type: "bloq", owner_id: 10 },
      settings: { gate: { allowedDomains: ["example.com"], allowedEmails: [] } },
      email: "x@elsewhere.example.net",
      pages: [{ id: 5, slug: "public", owner_type: "bloq", owner_id: 10, json_content: {} }],
    })
    expect(r.pages[0].email).toEqual({ address: "x@elsewhere.example.net", allowed: true, reason: "page does not require sign-in" })
  })
})

describe("no site list yet", () => {
  const site = { id: 1, owner_type: "bloq", owner_id: 10 }
  const page = (id: number, domains: string[]) => ({ id, slug: `p${id}`, owner_type: "bloq", owner_id: 10, json_content: { requireOtp: true, gate: { allowedDomains: domains, allowedEmails: [] } } })
  test("a page's own list is not reported as differing from a site list that does not exist", () => {
    const r = buildReport({ site, settings: {}, pages: [page(1, ["example.com"])] })
    expect(r.pages[0].differsFromSite).toBe(false)
    expect(r.ok).toBe(true)
  })
  test("member pages that disagree with each other are flagged on the site", () => {
    const r = buildReport({ site, settings: {}, pages: [page(1, ["example.com"]), page(2, ["example.org"])] })
    expect(r.flags[0]).toContain("2 different lists")
    expect(r.ok).toBe(false)
  })
})
