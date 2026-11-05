import { describe, expect, test } from "bun:test"
import {
  bucketOf,
  canRevoke,
  caseOf,
  emptyRaise,
  issueBlock,
  issueVerb,
  raisePayload,
  raiseProblem,
  recipients,
  stateWord,
  tally,
  toneOf,
  trailWord,
  waitLine,
  type Agreement,
} from "./iris-lexicon-agreements-model"
import { IRIS_PANEL_CATALOG, normalizeSurface, resolvePane } from "./session-iris-tab"

const row = (over: Partial<Agreement> = {}): Agreement => ({
  id: 1,
  type: "ENGAGEMENT",
  kind: "Engagement Letter",
  counterparty: "Dana Whitfield",
  org: null,
  email: "dana@example.com",
  disclosingParty: "Test Firm LLP",
  status: "draft",
  tier: "standard",
  subjectRef: "case:42",
  issuedAt: null,
  executedAt: null,
  expiryDate: null,
  revokedAt: null,
  documentHash: null,
  signingUrl: null,
  partyLinks: [],
  live: false,
  partiesTotal: 1,
  partiesSigned: 0,
  waitingOn: null,
  waitingDays: null,
  expiringSoon: false,
  raisedByCaller: true,
  ...over,
})

describe("lexicon agreements model (#192484)", () => {
  test("statuses fall into the five filters, and every row is counted once", () => {
    const rows = ["draft", "sent", "opened", "partially_signed", "executed", "revoked", "declined", "expired"].map((status) => row({ status }))
    expect(tally(rows)).toEqual({ all: 8, awaiting: 3, draft: 1, executed: 1, closed: 3 })
    expect(bucketOf("something_new")).toBe("draft")
  })

  test("expiring beats executed; half-signed says how far", () => {
    expect(stateWord(row({ status: "executed", expiringSoon: true }))).toBe("Expiring")
    expect(stateWord(row({ status: "partially_signed", partiesTotal: 2, partiesSigned: 1 }))).toBe("1/2 signed")
    expect(toneOf(row({ status: "executed", expiringSoon: true }))).toBe("warn")
    expect(toneOf(row({ status: "sent", waitingDays: 9 }))).toBe("warn")
    expect(toneOf(row({ status: "revoked" }))).toBe("bad")
  })

  test("the case is read from case: or the older matter: ref", () => {
    expect(caseOf("case:42")).toBe("42")
    expect(caseOf("matter:999001")).toBe("999001")
    expect(caseOf("bug_bounty_hunter:x@y.z")).toBeNull()
    expect(caseOf(null)).toBeNull()
  })

  test("issue is not offered without an address, or once it is executed or closed", () => {
    expect(issueBlock(row())).toBeNull()
    expect(issueBlock(row({ email: null }))).toContain("nowhere to send")
    expect(issueBlock(row({ status: "executed" }))).toContain("executed")
    expect(issueBlock(row({ status: "revoked" }))).toContain("revoked")
    expect(issueVerb(row())).toBe("Issue")
    expect(issueVerb(row({ status: "opened" }))).toBe("Re-send")
    expect(canRevoke(row({ status: "executed" }))).toBe(true)
    expect(canRevoke(row({ status: "revoked" }))).toBe(false)
  })

  test("the confirm names the counterparty with their address, and every other party still to sign", () => {
    const a = row({
      partyLinks: [
        { role: "Client", name: "Dana Whitfield", status: "opened", url: null },
        { role: "Guarantor", name: "Sam Whitfield", status: "opened", url: null },
        { role: "Spouse", name: "Lee Whitfield", status: "signed", url: null },
      ],
    })
    expect(recipients(a)).toEqual([
      { name: "Dana Whitfield", role: "Counterparty", email: "dana@example.com" },
      { name: "Sam Whitfield", role: "Guarantor", email: null },
    ])
  })

  test("raise says what is missing, in order, and types without default wording need some", () => {
    const f = emptyRaise("42")
    expect(raiseProblem(f)).toBe("Who signs it?")
    expect(raiseProblem({ ...f, name: "Dana" })).toBe("Which firm issues it?")
    expect(raiseProblem({ ...f, name: "Dana", firm: "Firm" })).toContain("no default wording")
    expect(raiseProblem({ ...f, name: "Dana", firm: "Firm", type: "nda" })).toBeNull()
    expect(raiseProblem({ ...f, name: "Dana", firm: "Firm", template: "engagement-std" })).toBeNull()
    expect(raiseProblem({ ...f, name: "Dana", firm: "Firm", type: "nda", expires: "next year" })).toContain("YYYY-MM-DD")
    expect(raiseProblem({ ...f, name: "Dana", firm: "Firm", type: "nda", email: "nope" })).toContain("email")
    expect(raiseProblem({ ...emptyRaise(), name: "Dana", firm: "Firm", type: "nda" })).toBe("Which case is this for?")
  })

  test("the raise payload leaves blanks out", () => {
    expect(raisePayload({ ...emptyRaise(" 42 "), name: "Dana", firm: "Firm" })).toEqual({ case: "42", type: "engagement", name: "Dana", firm: "Firm" })
  })

  test("waiting is only said of something awaiting a signature", () => {
    expect(waitLine(row({ status: "sent", waitingDays: 1, waitingOn: "Counterparty" }))).toBe("1 day waiting on Counterparty")
    expect(waitLine(row({ status: "executed", waitingDays: 3 }))).toBeNull()
    expect(trailWord("agreement.partially_signed")).toBe("Partially signed")
  })

  test("Lexicon is a top-level surface whose Agreements view draws itself", () => {
    expect(normalizeSurface("lexicon")).toBe("lexicon")
    const r = resolvePane("lexicon", undefined)
    expect(r.sub?.id).toBe("agreements")
    expect(r.pane).toBe("lexicon-agreements")
    // Console (#192482) sits beside Agreements; Agreements stays the landing view.
    expect(IRIS_PANEL_CATALOG.find((s) => s.id === "lexicon")?.subs.map((s) => s.id)).toEqual(["agreements", "console"])
  })
})
