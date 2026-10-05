import { describe, expect, test } from "bun:test"
import { noteUuid, publicUrl, notFoundHint } from "./page-ref"

/**
 * A PUBLISHED NOTE IS NOT A DRAFT PAGE.
 *
 * Measured 2026-08-27. `iris pages read n-46926bc2-…` built https://freelabel.net/p/n-46926bc2-…,
 * got a 404, and reported:
 *
 *   /p/ serves PUBLISHED pages only. If this is a draft: iris pages publish <slug>
 *
 * Every word after the 404 was wrong. The note was live and readable at /n/<uuid> (HTTP 200 on
 * both heyiris.io and freelabel.net), it was never a draft, and `pages publish` is not how notes
 * are published — so following the advice would have republished something already published.
 *
 * This is the failure family the read-back commands exist to remove: an instrument that cannot
 * distinguish "not there" from "I looked in the wrong place", and then names a cause it never
 * checked. These tests pin the address and the wording together, because fixing only the URL
 * would leave the false diagnosis in place for a genuinely unshared note.
 */

const UUID = "46926bc2-ce60-48cc-86e1-cd4d04f9f203"

describe("noteUuid", () => {
  test("recognises the n- prefixed slug a published note gets", () => {
    expect(noteUuid(`n-${UUID}`)).toBe(UUID)
  })

  test("recognises a bare uuid, the form `atlas use` accepts", () => {
    expect(noteUuid(UUID)).toBe(UUID)
  })

  test("is case-insensitive and returns the canonical lowercase uuid", () => {
    expect(noteUuid(`N-${UUID.toUpperCase()}`)).toBe(UUID)
  })

  test("an ordinary page slug is NOT a note ref", () => {
    expect(noteUuid("design-philosophy-and-page-audit")).toBeNull()
    expect(noteUuid("notes-on-something")).toBeNull()
  })

  test("a slug that merely contains a uuid is not a note ref — the whole slug must be one", () => {
    expect(noteUuid(`page-${UUID}-v2`)).toBeNull()
  })
})

describe("publicUrl", () => {
  /**
   * The host is heyiris.io — the business platform — not freelabel.net, which is the
   * iris-api base. Both answer /p/, so the old link worked and was merely on the wrong
   * brand: nothing 404s, nothing errors, and the URL goes on to be pasted into tickets,
   * docs and client email. A wrong link that resolves is harder to catch than one that
   * breaks, which is why this is pinned rather than left to review.
   */
  test("a note ref addresses the NOTE viewer, not /p/", () => {
    expect(publicUrl(`n-${UUID}`)).toBe(`https://heyiris.io/n/${UUID}`)
  })

  test("an ordinary page still addresses /p/", () => {
    expect(publicUrl("design-philosophy-and-page-audit")).toBe(
      "https://heyiris.io/p/design-philosophy-and-page-audit",
    )
  })

  test("never hands out the API host as a public link", () => {
    for (const ref of ["some-page", `n-${UUID}`]) {
      expect(publicUrl(ref)).toStartWith("https://heyiris.io/")
      expect(publicUrl(ref)).not.toContain("freelabel.net")
    }
  })

  test("an explicit public_url always wins", () => {
    expect(publicUrl({ public_url: "https://heyiris.io/p/custom", slug: `n-${UUID}` })).toBe(
      "https://heyiris.io/p/custom",
    )
  })
})

describe("notFoundHint", () => {
  test("never tells you to publish a NOTE as a page", () => {
    const hint = notFoundHint(`n-${UUID}`)
    expect(hint).not.toContain("iris pages publish")
    expect(hint).not.toContain("draft")
  })

  test("points a note at the verb that actually reads one", () => {
    expect(notFoundHint(`n-${UUID}`)).toContain("iris atlas use")
  })

  test("an ordinary page keeps the draft diagnosis, which is correct for it", () => {
    const hint = notFoundHint("some-page")
    expect(hint).toContain("iris pages publish some-page")
  })
})
