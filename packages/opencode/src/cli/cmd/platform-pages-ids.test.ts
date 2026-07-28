import { describe, expect, test } from "bun:test"
import { assignComponentIds } from "./platform-pages"

/**
 * Regression cover for #177898 — `pages pull` writes components without an `id`, but the API
 * rejects a push that lacks one, so the documented pull → edit → push loop could never complete.
 * `push` now backfills ids before validating.
 */
describe("assignComponentIds", () => {
  test("backfills ids for a file produced by pull (the #177898 repro)", () => {
    const jsonContent = {
      components: [
        { type: "SiteNavigation", props: {} },
        { type: "Hero", props: {} },
        { type: "CustomHtml", props: { html: "<p>x</p>" } },
        { type: "SiteFooter", props: {} },
      ],
    }
    const added = assignComponentIds(jsonContent)
    expect(added).toBe(4)
    expect(jsonContent.components.map((c: any) => c.id)).toEqual([
      "siteNavigation-0",
      "hero-1",
      "customHtml-2",
      "siteFooter-3",
    ])
  })

  test("never overwrites an id the author already set", () => {
    const jsonContent = {
      components: [
        { type: "WidgetStatsRow", id: "stats-attorney", props: {} },
        { type: "DataTable", props: {} },
      ],
    }
    expect(assignComponentIds(jsonContent)).toBe(1)
    expect(jsonContent.components[0].id).toBe("stats-attorney")
    expect(jsonContent.components[1].id).toBe("dataTable-1")
  })

  test("is idempotent — a second push produces no further change", () => {
    const jsonContent = { components: [{ type: "Hero", props: {} }, { type: "TextBlock", props: {} }] }
    assignComponentIds(jsonContent)
    const first = jsonContent.components.map((c: any) => c.id)
    expect(assignComponentIds(jsonContent)).toBe(0)
    expect(jsonContent.components.map((c: any) => c.id)).toEqual(first)
  })

  test("suffixes rather than colliding with an existing id", () => {
    const jsonContent = {
      components: [
        { type: "Hero", id: "hero-1", props: {} },
        { type: "Hero", props: {} },
      ],
    }
    assignComponentIds(jsonContent)
    expect(jsonContent.components[1].id).toBe("hero-1-2")
    expect(jsonContent.components[0].id).toBe("hero-1")
  })

  test("tolerates a missing/!array components key instead of throwing", () => {
    expect(assignComponentIds(undefined)).toBe(0)
    expect(assignComponentIds({})).toBe(0)
    expect(assignComponentIds({ components: "nope" })).toBe(0)
  })

  test("falls back to a generic id when type is absent", () => {
    const jsonContent: { components: any[] } = { components: [{ props: {} }] }
    assignComponentIds(jsonContent)
    expect(jsonContent.components[0].id).toBe("component-0")
  })
})
