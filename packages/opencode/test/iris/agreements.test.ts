import { afterEach, describe, expect, test } from "bun:test"
import {
  agreementDeps,
  failureReason,
  fetchAgreement,
  fetchAgreements,
  issueAgreement,
  ledgerQuery,
  raiseAgreement,
  readRow,
  revokeAgreement,
} from "../../src/iris/agreements"

// Lexicon › Agreements (#192484). Every write here is against a mocked fl-api: issue and revoke reach
// a real counterparty, so no test may call the real one.

const real = agreementDeps.fetch
afterEach(() => {
  agreementDeps.fetch = real
})
type Seen = { path: string; init?: RequestInit }
function answer(status: number, body: unknown, seen?: Seen[]) {
  agreementDeps.fetch = async (path, init) => {
    seen?.push({ path, init })
    return new Response(body === undefined ? "" : JSON.stringify(body), { status })
  }
}

const ROW = {
  id: 26584,
  type: "ENGAGEMENT",
  kind: "Engagement Letter",
  raisedByCaller: true,
  bloqId: null,
  counterparty: "Dana Whitfield",
  org: "Whitfield LLC",
  email: "dana@example.com",
  disclosingParty: "Test Firm LLP",
  status: "opened",
  tier: "standard",
  subjectRef: "case:999001",
  issuedAt: "2026-11-01 23:10:32",
  executedAt: null,
  expiryDate: "2027-11-01",
  revokedAt: null,
  documentHash: "abcdef0123456789",
  signingUrl: "https://heyiris.io/p/sign?t=x",
  partyLinks: [{ role: "Counterparty", name: "Dana Whitfield", status: "opened", url: "https://heyiris.io/p/sign?t=x" }],
  live: false,
  partiesTotal: 1,
  partiesSigned: 0,
  waitingOn: "Counterparty",
  waitingDays: 2,
  expiringSoon: false,
}

describe("agreements (#192484)", () => {
  test("the lexicon filter: one case, or every case — as the CLI sends it", () => {
    expect(ledgerQuery({ case: " 42 " })).toBe("?subject=case%3A42")
    expect(ledgerQuery({})).toBe("?subject_prefix=case%3A")
    expect(ledgerQuery({ case: "", status: "executed", type: "engagement" })).toBe(
      "?subject_prefix=case%3A&status=executed&type=engagement",
    )
  })

  test("a row keeps every field the panel reads, and drops the rest", () => {
    const r = readRow(ROW)
    expect(r).toMatchObject({ id: 26584, counterparty: "Dana Whitfield", waitingDays: 2, partiesTotal: 1, raisedByCaller: true })
    expect((r as any).bloqId).toBeUndefined()
  })

  test("a field of the wrong type becomes null, not a crash in the encoder", () => {
    const r = readRow({ ...ROW, waitingDays: "7", expiryDate: 20271101, partyLinks: "nope", live: "yes" })
    expect(r.waitingDays).toBe(7)
    expect(r.expiryDate).toBe("20271101")
    expect(r.partyLinks).toEqual([])
    expect(r.live).toBe(false)
  })

  test("the list is measured; a failure is not an empty ledger", async () => {
    answer(200, { summary: { total: 1, awaiting: 1, executed: 0, expiringSoon: 0, revoked: 0 }, agreements: [ROW] })
    const ok = await fetchAgreements({ case: "999001" })
    expect(ok.measured).toBe(true)
    expect(ok.data.agreements.length).toBe(1)
    expect(ok.data.summary.awaiting).toBe(1)

    answer(401, { message: "Unauthenticated." })
    const bad = await fetchAgreements({})
    expect(bad).toMatchObject({ measured: false, reason: "Unauthenticated." })
  })

  test("detail carries document, seal and trail", async () => {
    answer(200, {
      agreement: ROW,
      document: { title: "Dana", clauses: [{ heading: "Purpose", body: "x" }], parties: [], signatures: [] },
      seal: { status: "unsealed", detail: "not executed", chain: null, stored: null },
      trail: [{ seq: 1, action: "agreement.created", ip: null, at: "2026-11-01" }],
    })
    const d = await fetchAgreement(26584)
    expect(d.data.document?.clauses[0]).toEqual({ heading: "Purpose", body: "x" })
    expect(d.data.seal).toEqual({ status: "unsealed", detail: "not executed", chain: null })
    expect(d.data.trail[0].action).toBe("agreement.created")
  })

  test("raise sends the CLI's shape, on the case, and NEVER issues", async () => {
    const seen: Seen[] = []
    answer(201, { agreement: { ...ROW, status: "draft" } }, seen)
    const r = await raiseAgreement({ case: "999001", type: "engagement", name: "Dana Whitfield", firm: "Test Firm LLP", email: "dana@example.com", body: "Wording" })
    expect(r.measured).toBe(true)
    expect(seen[0].path).toBe("/api/v1/agreements")
    expect(seen[0].init?.method).toBe("POST")
    const body = JSON.parse(String(seen[0].init?.body))
    expect(body).toMatchObject({
      agreement_type: "engagement",
      counterparty_name: "Dana Whitfield",
      counterparty_email: "dana@example.com",
      disclosing_party: "Test Firm LLP",
      subject_ref: "case:999001",
      access_tier: "standard",
      body: "Wording",
      template_slug: null,
      issue: false,
    })
  })

  test("raise refuses before calling when the case, signer or firm is missing", async () => {
    const seen: Seen[] = []
    answer(201, {}, seen)
    expect((await raiseAgreement({ case: " ", type: "nda", name: "A", firm: "B" })).measured).toBe(false)
    expect((await raiseAgreement({ case: "1", type: "nda", name: "", firm: "B" })).measured).toBe(false)
    expect((await raiseAgreement({ case: "1", type: "nda", name: "A", firm: "" })).measured).toBe(false)
    expect(seen.length).toBe(0)
  })

  test("issue posts to /issue; revoke posts the reason and refuses without one", async () => {
    const seen: Seen[] = []
    answer(200, { agreement: { ...ROW, status: "sent" } }, seen)
    expect((await issueAgreement(26584)).data.agreement?.status).toBe("sent")
    expect(seen[0].path).toBe("/api/v1/agreements/26584/issue")
    expect(seen[0].init?.method).toBe("POST")

    expect((await revokeAgreement(26584, "  ")).measured).toBe(false)
    expect(seen.length).toBe(1)
    await revokeAgreement(26584, "engagement ended")
    expect(seen[1].path).toBe("/api/v1/agreements/26584/revoke")
    expect(JSON.parse(String(seen[1].init?.body))).toEqual({ reason: "engagement ended" })
  })

  test("a refusal is shown in fl-api's own words", async () => {
    answer(422, { errors: { counterparty_email: ["An email is required to issue."] } })
    expect(await issueAgreement(1)).toMatchObject({ measured: false, reason: "An email is required to issue." })
    expect(failureReason(500, null)).toBe("fl-api 500")
  })

  test("an unreachable fl-api is a reason, not a throw", async () => {
    agreementDeps.fetch = async () => {
      throw new Error("ECONNREFUSED")
    }
    expect(await fetchAgreement(1)).toMatchObject({ measured: false, reason: "ECONNREFUSED" })
  })
})
