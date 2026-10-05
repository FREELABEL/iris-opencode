import { describe, expect, test } from "bun:test"
import { classifyGateEntry, isGateAffectingPath } from "./platform-pages"

/**
 * #183705 — a client's own domain was missing from all twelve of her gated pages, and a
 * bare domain sat in an email list on two of them reading like access it did not grant.
 * Neither was visible one page at a time.
 */
describe("classifyGateEntry", () => {
  test("a bare domain in the EMAIL list is the kmontero.com bug", () => {
    const p = classifyGateEntry("emails", "kmontero.com")
    expect(p).toContain("DOMAIN in the email list")
    // The half that makes it dangerous rather than merely useless.
    expect(p).toContain("allowedDomains")
  })

  test("an email in the DOMAIN list does not grant that person access", () => {
    expect(classifyGateEntry("domains", "kmontero@pathwaysinjuryconsultants.com")).toContain("EMAIL in the domain list")
  })

  test("well-formed entries are silent", () => {
    expect(classifyGateEntry("domains", "pathwaysinjuryconsultants.com")).toBeNull()
    expect(classifyGateEntry("emails", "kmontero@pathwaysinjuryconsultants.com")).toBeNull()
  })

  test("empty and malformed entries are reported, not skipped", () => {
    expect(classifyGateEntry("domains", "")).toBe("empty entry")
    expect(classifyGateEntry("domains", "not a domain")).toBe("not a domain")
  })
})

describe("isGateAffectingPath", () => {
  test("access paths purge themselves — a stale render is an access statement", () => {
    for (const p of ["requires_auth", "visibility", "gate", "gate.allowedDomains", "json_content.requireOtp"]) {
      expect(isGateAffectingPath(p)).toBe(true)
    }
  })

  test("cosmetic paths keep the old reminder", () => {
    for (const p of ["title", "theme.mode", "components.0.props.columns"]) {
      expect(isGateAffectingPath(p)).toBe(false)
    }
  })
})
