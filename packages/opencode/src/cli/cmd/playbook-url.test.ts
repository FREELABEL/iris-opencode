import { describe, expect, test } from "bun:test"
import { playbookUrl } from "./platform-playbook"

/**
 * `publish` printed a query string against a generic viewer page:
 *
 *     https://freelabel.net/p/playbook?name=document-crossref
 *
 * The real detail route is /playbooks/{name} (web.php: playbooks.show → Playbooks/Show),
 * and it has worked all along — routes/web.php even records the cost of not knowing that:
 * it was read as "playbooks have no live web surface", which sent someone to
 * `iris bloqs publish` for a shareable URL that already existed.
 *
 * Verified 2026-08-30: /playbooks/agentic-loop returns 200 with a Playbooks/Show page on
 * both heyiris.io and freelabel.net.
 */
describe("playbookUrl", () => {
  test("builds the detail route, not a query against the viewer page", () => {
    const url = playbookUrl("document-crossref")
    expect(url).toContain("/playbooks/document-crossref")
    expect(url).not.toContain("/p/playbook")
    expect(url).not.toContain("?name=")
  })

  test("encodes a name that would otherwise break the path", () => {
    expect(playbookUrl("a b/c")).toContain("/playbooks/a%20b%2Fc")
  })

  test("is built from the configured host, so staging never links to production", () => {
    // The host comes from IRIS_API; the shape is what this pins.
    expect(playbookUrl("x")).toMatch(/^https?:\/\/[^/]+\/playbooks\/x$/)
  })
})
