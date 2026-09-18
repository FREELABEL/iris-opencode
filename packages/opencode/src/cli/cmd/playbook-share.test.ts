import { describe, expect, test } from "bun:test"
import { shareSummary, shareAudience, judgeLinkFetch } from "./platform-playbook"

/**
 * `iris playbook share` must print only the addresses the registry returned (#185980):
 * publish built `/playbooks/<name>` itself at project scope, and that link 404s for everyone.
 * Rows below are shaped like real GET /api/v1/playbooks/{name} responses (2026-09-18).
 */
const unlisted = {
  name: "pathways-legal-review",
  scope: "unlisted",
  bloq_id: null,
  access_type: "free",
  version: 13,
  published_at: "2026-09-18T18:30:42+00:00",
  updated_at: "2026-09-18T18:30:42+00:00",
  uuid: "4d0c8574-581f-4329-9a7f-3673062adebf",
  public_url: "https://heyiris.io/playbooks/4d0c8574-581f-4329-9a7f-3673062adebf",
  canonical_url: "https://heyiris.io/playbooks/pathways-legal-review",
}

const project = {
  name: "bounty-os",
  scope: "project",
  bloq_id: 503,
  access_type: "free",
  version: 3,
  published_at: "2026-09-13T22:47:06+00:00",
  public_url: null,
  canonical_url: null,
  uuid: null,
}

describe("shareSummary", () => {
  test("project scope prints NO url, and says how members get it instead", () => {
    const s = shareSummary(project)
    expect(s.links).toEqual([])
    expect(s.note).toBe("No web link — members of board #503 install it with: iris playbook install bounty-os")
    expect(JSON.stringify(s)).not.toContain("/playbooks/bounty-os")
    expect(JSON.stringify(s)).not.toContain("freelabel.net")
  })

  test("unlisted shows the uuid link first, then the canonical one — both exactly as returned", () => {
    const s = shareSummary(unlisted)
    expect(s.links).toEqual([
      { kind: "public_url", url: unlisted.public_url },
      { kind: "canonical_url", url: unlisted.canonical_url },
    ])
    expect(s.note).toBeNull()
    expect(s.version).toBe(13)
    expect(s.uuid).toBe(unlisted.uuid)
  })

  test("never invents a link when the API returned none, whatever the scope", () => {
    for (const scope of ["public", "unlisted", "private", "project", "local"]) {
      const s = shareSummary({ name: "x", scope, public_url: null, canonical_url: null })
      expect(s.links).toEqual([])
      expect(s.note).not.toBeNull()
      expect(s.note!).not.toMatch(/https?:\/\//)
    }
  })

  test("ignores a non-URL value rather than printing it as a link", () => {
    expect(shareSummary({ name: "x", scope: "public", public_url: "", canonical_url: "/playbooks/x" }).links).toEqual([])
  })

  test("does not print the same address twice", () => {
    const url = "https://heyiris.io/playbooks/x"
    expect(shareSummary({ name: "x", scope: "public", public_url: url, canonical_url: url }).links).toHaveLength(1)
  })
})

describe("shareAudience", () => {
  test("says who can open it in plain words per scope", () => {
    expect(shareAudience("unlisted", null)).toContain("Anyone with the link")
    expect(shareAudience("unlisted", null)).toContain("not listed")
    expect(shareAudience("public", null)).toContain("listed in the marketplace")
    expect(shareAudience("project", 503)).toBe("Signed-in members of board #503 only")
    expect(shareAudience("private", null)).toBe("Only you, signed in")
  })
})

describe("judgeLinkFetch", () => {
  test("a 200 that shows the playbook opens", () => {
    expect(judgeLinkFetch(200, "<div>pathways-legal-review</div>", "pathways-legal-review").opens).toBe(true)
  })
  test("a 200 that does not show the playbook does not count", () => {
    expect(judgeLinkFetch(200, "<div>something else</div>", "pathways-legal-review").opens).toBe(false)
  })
  test("a 404 does not open, and an unreachable link is unmeasured, not fine", () => {
    expect(judgeLinkFetch(404, "", "x").opens).toBe(false)
    const c = judgeLinkFetch(-1, "", "x")
    expect(c.opens).toBe(false)
    expect(c.detail).toContain("UNMEASURED")
  })
})
