import { describe, expect, test } from "bun:test"
import { buildLane, fetchSnippet, laneUrl, mergeSettings, readProbe, scalar } from "./public-submit-lane"

/**
 * #192478 — public submit lanes as a product. These rules decide what `iris datasets
 * public-submit enable` writes into a dataset's settings, so each one guards a way a lane could
 * quietly lose data or open wider than meant.
 */
const FIELDS = ["first_name", "last_name", "notes", "stage", "review_status", "organization"]

describe("buildLane", () => {
  test("builds a lane from options", () => {
    const r = buildLane(null, {
      page: "acme-enquiries", collection: "enquiries",
      alias: ["company=organization"], set: ["stage=New"], require: ["first_name,last_name"],
      origin: ["https://forms.acme.example/x"], refPrefix: "acme", perSender: 3, perHour: 50,
    }, FIELDS)
    expect(r.errors).toEqual([])
    expect(r.lane).toEqual({
      enabled: true, page: "acme-enquiries", collection: "enquiries",
      aliases: { company: "organization" }, set: { stage: "New" }, require_any: ["first_name", "last_name"],
      origins: ["forms.acme.example"], ref_prefix: "ACME", per_sender: 3, per_hour: 50,
    })
  })

  test("options not given keep the existing lane's values", () => {
    const existing = { enabled: false, page: "p", collection: "c", aliases: { a: "notes" }, require_any: ["first_name"], per_sender: 9 }
    const r = buildLane(existing, { perHour: 10 }, FIELDS)
    expect(r.lane?.aliases).toEqual({ a: "notes" })
    expect(r.lane?.require_any).toEqual(["first_name"])
    expect(r.lane?.per_sender).toBe(9)
    expect(r.lane?.per_hour).toBe(10)
    expect(r.lane?.enabled).toBe(true)
  })

  test("refuses field names the dataset does not have — the server would drop that data", () => {
    const r = buildLane(null, { page: "p", collection: "c", alias: ["x=nope"], set: ["also_nope=1"], require: ["missing"] }, FIELDS)
    expect(r.lane).toBeUndefined()
    expect(r.errors.join("\n")).toContain("'nope' is not a field")
    expect(r.errors.join("\n")).toContain("'also_nope' is not a field")
    expect(r.errors.join("\n")).toContain("'missing' is not a field")
  })

  test("refuses a bad page, collection, origin or prefix", () => {
    const r = buildLane(null, { page: "Bad Page", collection: "", origin: ["not a host"], refPrefix: "x1" }, FIELDS)
    expect(r.errors.length).toBeGreaterThanOrEqual(4)
  })

  test("warns when nothing is required, and when a rate is above the server's ceiling", () => {
    const r = buildLane(null, { page: "p", collection: "c", perSender: 99, perHour: 5000 }, FIELDS)
    expect(r.errors).toEqual([])
    expect(r.warnings.join("\n")).toContain("empty submission")
    expect(r.warnings.join("\n")).toContain("capped at 20")
    expect(r.warnings.join("\n")).toContain("capped at 1000")
  })

  test("--set values become real types", () => {
    expect(scalar("true")).toBe(true)
    expect(scalar("12")).toBe(12)
    expect(scalar("New")).toBe("New")
  })
})

describe("mergeSettings", () => {
  test("keeps every other setting — the update endpoint replaces settings wholesale", () => {
    const merged = mergeSettings({ flow_type: "onboarding", row_policy: "visitor" }, { enabled: true, page: "p", collection: "c" })
    expect(merged.flow_type).toBe("onboarding")
    expect(merged.row_policy).toBe("visitor")
    expect((merged.public_submit as any).page).toBe("p")
  })

  test("disable switches the lane off and keeps its configuration for a later enable", () => {
    const merged = mergeSettings({ public_submit: { enabled: true, page: "p", collection: "c", per_sender: 4 } }, null)
    expect(merged.public_submit).toEqual({ enabled: false, page: "p", collection: "c", per_sender: 4 })
  })

  test("disable on a dataset with no lane changes nothing", () => {
    expect(mergeSettings({ a: 1 }, null)).toEqual({ a: 1 })
  })
})

describe("addresses and snippet", () => {
  test("the lane URL", () => {
    expect(laneUrl("https://heyiris.io/", "acme-enquiries", "enquiries")).toBe("https://heyiris.io/api/v1/app-data/acme-enquiries/enquiries")
  })

  test("the snippet posts to the lane and carries the honeypot", () => {
    const s = fetchSnippet("/api/v1/app-data/p/c", ["first_name", "last_name"])
    expect(s).toContain('fetch("/api/v1/app-data/p/c"')
    expect(s).toContain("website: form.website.value")
    expect(s).toContain("submission_ref")
  })
})

describe("readProbe", () => {
  test("201 with no id: live, nothing saved", () => {
    expect(readProbe(201, { success: true, data: { id: null, submission_ref: "X-1" } }).live).toBe(true)
  })

  test("401: no lane", () => {
    expect(readProbe(401, { success: false }).live).toBe(false)
  })

  test("201 WITH an id is called out — the probe may have been saved", () => {
    expect(readProbe(201, { success: true, data: { id: 5 } }).message).toContain("SAVED")
  })
})

describe("working the queue (#192612)", () => {
  const { queueLine, reviewPayload } = require("./public-submit-lane")

  test("a queue line names the reference, status and person", () => {
    const line = queueLine({ id: 7, submission_ref: "IRIS-1", submitted_at: "2026-11-05T10:00:00Z", review_status: "new", first_name: "Pat", last_name: "Doe" })
    expect(line).toContain("IRIS-1")
    expect(line).toContain("2026-11-05")
    expect(line).toContain("new")
    expect(line).toContain("Pat Doe")
  })

  test("an FA case row reads too", () => {
    expect(queueLine({ id: 3, case_id: "CAS-1", stage_name: "Intake", patient_name: "A B" })).toContain("CAS-1")
  })

  test("review sends only what was asked, lowercases the status, drops an empty note", () => {
    expect(reviewPayload({ status: "Progress", note: "  " })).toEqual({ review_status: "progress" })
    expect(reviewPayload({ assign: "Ellie", note: "called" })).toEqual({ assigned_to: "Ellie", note: "called" })
    expect(reviewPayload({})).toBeNull()
  })
})
