import { describe, expect, test } from "bun:test"
import { scaffoldComponents, COMPONENT_REGISTRY } from "./platform-pages"

/**
 * #180123 — `iris pages create` failed 100% of the time on a fresh slug:
 *
 *   Create page failed: Component validation failed
 *     <slug>-footer (SiteFooter): The copyright field is required.
 *
 * The command scaffolded a SiteFooter without `copyright` — a prop this same
 * file's COMPONENT_REGISTRY declares required — so it rejected the page it had
 * just built. And because `pages push` answers "Page not found" for a slug that
 * does not exist yet, there was no create-then-push path at all; the only way to
 * publish a new page was `pages:batch`.
 *
 * The registry already held the answer. Nothing checked the scaffold against it.
 */
describe("pages create scaffold", () => {
  const scaffold = scaffoldComponents({
    slug: "my-page",
    title: "My Page",
    seoDescription: "A description",
  })

  test("every scaffolded component satisfies its own registry contract", () => {
    const missing: string[] = []

    for (const component of scaffold) {
      const spec = COMPONENT_REGISTRY.find((c) => c.type === component.type)
      expect(spec, `${component.type} is scaffolded but absent from COMPONENT_REGISTRY`).toBeDefined()

      for (const prop of spec!.requiredProps) {
        const value = (component.props as Record<string, unknown>)[prop]
        if (value === undefined || value === null || value === "") {
          missing.push(`${component.type}.${prop}`)
        }
      }
    }

    // This is the whole bug: the list was ["SiteFooter.copyright"].
    expect(missing).toEqual([])
  })

  test("scaffolds a footer with a non-empty copyright", () => {
    const footer = scaffold.find((c) => c.type === "SiteFooter")
    expect(footer).toBeDefined()
    expect((footer!.props as Record<string, unknown>).copyright).toBeTruthy()
  })

  test("ids are slug-derived, so two pages never collide", () => {
    const other = scaffoldComponents({ slug: "other-page", title: "Other" })
    const ids = scaffold.map((c) => c.id)
    const otherIds = other.map((c) => c.id)

    expect(ids).toEqual(["my-page-hero", "my-page-footer"])
    expect(ids.some((id) => otherIds.includes(id))).toBe(false)
  })

  test("survives the optional seo description being omitted", () => {
    const bare = scaffoldComponents({ slug: "bare", title: "Bare" })
    const hero = bare.find((c) => c.type === "Hero")

    // Hero.title is the registry-required prop; subtitle is free to be empty.
    expect((hero!.props as Record<string, unknown>).title).toBe("Bare")
    expect((hero!.props as Record<string, unknown>).subtitle).toBe("")
  })
})
