import { describe, expect, test } from "bun:test"
import { mergePageDocs, versionDocFromRow, mergePreconditions, formatMergeReport, type MergeOutcome } from "./page-merge"

/**
 * GLD-02 — three-way merge for `iris pages merge <slug>`.
 *
 *   base   = the page version the local file was pulled from (_base.version)
 *   ours   = ./pages/<slug>.json
 *   theirs = the current live version
 *
 * Structural, keyed on `json_content.components[].id` — NOT textual. A line merge of
 * pretty-printed JSON produces structurally invalid documents, and the losses actually
 * observed here were whole-ARRAY replacements, which a line merge resolves *cleanly* by
 * taking one side entirely and reporting success.
 */

function comp(id: string, type: string, props: Record<string, unknown> = {}) {
  return { id, type, props }
}

function doc(components: any[], extra: Record<string, unknown> = {}, page: Record<string, unknown> = {}) {
  return { title: "Page", ...page, json_content: { version: 2, theme: "dark", components, ...extra } }
}

function comps(o: MergeOutcome) {
  return (o.merged.json_content.components as any[]).map((c) => c.id)
}
function byId(o: MergeOutcome, id: string) {
  return (o.merged.json_content.components as any[]).find((c) => c.id === id)
}
function units(o: MergeOutcome) {
  return o.conflicts.map((c) => c.unit)
}

describe("components — disjoint edits merge", () => {
  const base = doc([comp("hero-0", "Hero", { title: "A" }), comp("cta-1", "CTA", { label: "Go" })])

  test("we edit one component, they edit another — both survive, no conflict", () => {
    const ours = doc([comp("hero-0", "Hero", { title: "OURS" }), comp("cta-1", "CTA", { label: "Go" })])
    const theirs = doc([comp("hero-0", "Hero", { title: "A" }), comp("cta-1", "CTA", { label: "THEIRS" })])

    const out = mergePageDocs(base, ours, theirs)

    expect(out.conflicts).toEqual([])
    expect(out.mergeable).toBe(true)
    expect(byId(out, "hero-0").props.title).toBe("OURS")
    expect(byId(out, "cta-1").props.label).toBe("THEIRS")
  })

  test("the SAME component edited on both sides is a conflict named by id AND type", () => {
    const ours = doc([comp("hero-0", "Hero", { title: "OURS" }), comp("cta-1", "CTA", { label: "Go" })])
    const theirs = doc([comp("hero-0", "Hero", { title: "THEIRS" }), comp("cta-1", "CTA", { label: "Go" })])

    const out = mergePageDocs(base, ours, theirs)

    expect(out.conflicts).toHaveLength(1)
    expect(out.conflicts[0].unit).toBe("component:hero-0")
    expect(out.conflicts[0].label).toContain("Hero")
    expect(out.mergeable).toBe(false)
  })

  test("an identical edit on both sides is not a conflict", () => {
    const same = doc([comp("hero-0", "Hero", { title: "SAME" }), comp("cta-1", "CTA", { label: "Go" })])
    const out = mergePageDocs(base, same, structuredClone(same))
    expect(out.conflicts).toEqual([])
    expect(byId(out, "hero-0").props.title).toBe("SAME")
  })

  test("key ORDER inside a component is not an edit", () => {
    const ours = doc([{ type: "Hero", id: "hero-0", props: { title: "A" } }, comp("cta-1", "CTA", { label: "Go" })])
    const out = mergePageDocs(base, ours, structuredClone(base))
    expect(out.conflicts).toEqual([])
  })
})

describe("components — additions and deletions", () => {
  const base = doc([comp("hero-0", "Hero"), comp("cta-1", "CTA")])

  test("a component they added appears in the merge", () => {
    const theirs = doc([comp("hero-0", "Hero"), comp("cta-1", "CTA"), comp("faq-2", "Faq")])
    const out = mergePageDocs(base, structuredClone(base), theirs)
    expect(comps(out)).toEqual(["hero-0", "cta-1", "faq-2"])
    expect(out.conflicts).toEqual([])
  })

  test("a component we added survives a merge with their unrelated change", () => {
    const ours = doc([comp("hero-0", "Hero"), comp("cta-1", "CTA"), comp("mine-9", "Quote")])
    const theirs = doc([comp("hero-0", "Hero", { title: "T" }), comp("cta-1", "CTA")])
    const out = mergePageDocs(base, ours, theirs)
    expect(comps(out)).toContain("mine-9")
    expect(byId(out, "hero-0").props.title).toBe("T")
    expect(out.conflicts).toEqual([])
  })

  test("both sides add components — both are kept", () => {
    const ours = doc([comp("hero-0", "Hero"), comp("cta-1", "CTA"), comp("mine-9", "Quote")])
    const theirs = doc([comp("hero-0", "Hero"), comp("cta-1", "CTA"), comp("yours-8", "Stat")])
    const out = mergePageDocs(base, ours, theirs)
    expect(comps(out)).toContain("mine-9")
    expect(comps(out)).toContain("yours-8")
  })

  test("a component they deleted and we did not touch is dropped", () => {
    const theirs = doc([comp("hero-0", "Hero")])
    const out = mergePageDocs(base, structuredClone(base), theirs)
    expect(comps(out)).toEqual(["hero-0"])
    expect(out.conflicts).toEqual([])
  })

  test("deleted on one side, EDITED on the other is a conflict — not a silent drop", () => {
    const ours = doc([comp("hero-0", "Hero"), comp("cta-1", "CTA", { label: "I still want this" })])
    const theirs = doc([comp("hero-0", "Hero")])
    const out = mergePageDocs(base, ours, theirs)
    expect(units(out)).toEqual(["component:cta-1"])
    expect(out.conflicts[0].kind).toContain("delete")
  })
})

describe("components — order", () => {
  const base = doc([comp("a", "Hero"), comp("b", "CTA"), comp("c", "Faq")])

  test("they reorder, we edit a different component — their order and our edit both land", () => {
    const ours = doc([comp("a", "Hero", { t: 1 }), comp("b", "CTA"), comp("c", "Faq")])
    const theirs = doc([comp("c", "Faq"), comp("a", "Hero"), comp("b", "CTA")])
    const out = mergePageDocs(base, ours, theirs)
    expect(out.conflicts).toEqual([])
    expect(comps(out)).toEqual(["c", "a", "b"])
    expect(byId(out, "a").props.t).toBe(1)
  })

  test("MOVED on one side and EDITED on the other is a conflict, not a guess", () => {
    const ours = doc([comp("c", "Faq"), comp("a", "Hero"), comp("b", "CTA")]) // we moved c
    const theirs = doc([comp("a", "Hero"), comp("b", "CTA"), comp("c", "Faq", { t: 9 })]) // they edited c
    const out = mergePageDocs(base, ours, theirs)
    expect(units(out)).toContain("component:c")
    expect(out.conflicts.find((x) => x.unit === "component:c")!.kind).toContain("move")
  })

  test("both sides reorder differently — an order conflict, not last-writer-wins", () => {
    const ours = doc([comp("b", "CTA"), comp("a", "Hero"), comp("c", "Faq")])
    const theirs = doc([comp("c", "Faq"), comp("b", "CTA"), comp("a", "Hero")])
    const out = mergePageDocs(base, ours, theirs)
    expect(units(out)).toContain("components:order")
  })

  test("both sides make the SAME reorder — no conflict", () => {
    const same = doc([comp("c", "Faq"), comp("b", "CTA"), comp("a", "Hero")])
    const out = mergePageDocs(base, same, structuredClone(same))
    expect(out.conflicts).toEqual([])
    expect(comps(out)).toEqual(["c", "b", "a"])
  })
})

describe("components — ids are the whole mechanism, so a bad id set refuses", () => {
  test("a duplicate id refuses the merge rather than picking one", () => {
    const base = doc([comp("a", "Hero")])
    const ours = doc([comp("a", "Hero", { t: 1 }), comp("a", "CTA")])
    const out = mergePageDocs(base, ours, structuredClone(base))
    expect(out.mergeable).toBe(false)
    expect(out.conflicts.some((c) => c.kind === "duplicate-id")).toBe(true)
  })

  test("a component with no id refuses — it cannot be keyed", () => {
    const base = doc([comp("a", "Hero")])
    const ours = { title: "Page", json_content: { version: 2, theme: "dark", components: [{ type: "Hero" }] } }
    const out = mergePageDocs(base, ours, structuredClone(base))
    expect(out.mergeable).toBe(false)
    expect(out.conflicts.some((c) => c.kind === "missing-id")).toBe(true)
    expect(out.conflicts.find((c) => c.kind === "missing-id")!.label).toMatch(/push/)
  })
})

describe("layout.navItems — the array that has actually been lost here", () => {
  const nav = (items: any[]) => ({ layout: { themeMode: "light", navItems: items } })
  const A = { label: "Overview", url: "/p/a", icon: "chart-bar", active: false }
  const B = { label: "Sales", url: "/p/b", icon: "trending-up", active: false }
  const C = { label: "Board", url: "/p/c", icon: "squares", active: false }

  test("they append a nav item, we rename another — BOTH survive", () => {
    // A whole-array replacement takes one side entirely and reports success. This is the
    // regression test for that.
    const base = doc([comp("a", "Hero")], nav([A, B]))
    const ours = doc([comp("a", "Hero")], nav([{ ...A, label: "Home" }, B]))
    const theirs = doc([comp("a", "Hero")], nav([A, B, C]))

    const out = mergePageDocs(base, ours, theirs)

    expect(out.conflicts).toEqual([])
    const items = out.merged.json_content.layout.navItems
    expect(items.map((i: any) => i.url)).toEqual(["/p/a", "/p/b", "/p/c"])
    expect(items[0].label).toBe("Home")
  })

  test("both sides edit the same nav item — a conflict named by its url", () => {
    const base = doc([comp("a", "Hero")], nav([A, B]))
    const ours = doc([comp("a", "Hero")], nav([{ ...A, label: "Home" }, B]))
    const theirs = doc([comp("a", "Hero")], nav([{ ...A, label: "Start" }, B]))
    const out = mergePageDocs(base, ours, theirs)
    expect(units(out)).toEqual(["json_content.layout.navItems:/p/a"])
  })

  test("a nav item they removed is removed", () => {
    const base = doc([comp("a", "Hero")], nav([A, B]))
    const out = mergePageDocs(base, structuredClone(base), doc([comp("a", "Hero")], nav([A])))
    expect(out.merged.json_content.layout.navItems.map((i: any) => i.url)).toEqual(["/p/a"])
  })

  test("a sibling layout scalar three-ways independently of navItems", () => {
    const base = doc([comp("a", "Hero")], nav([A]))
    const ours = doc([comp("a", "Hero")], { layout: { themeMode: "light", navItems: [A, B] } })
    const theirs = doc([comp("a", "Hero")], { layout: { themeMode: "dark", navItems: [A] } })
    const out = mergePageDocs(base, ours, theirs)
    expect(out.conflicts).toEqual([])
    expect(out.merged.json_content.layout.themeMode).toBe("dark")
    expect(out.merged.json_content.layout.navItems).toHaveLength(2)
  })
})

describe("siteNavigation — same shape as navItems, same treatment", () => {
  const A = { label: "Overview", url: "/p/a", active: false }
  const B = { label: "Sales", url: "/p/b", active: false }
  const C = { label: "Board", url: "/p/c", active: false }

  test("item-wise, not a whole-array replacement", () => {
    const base = doc([comp("a", "Hero")], { siteNavigation: [A, B] })
    const ours = doc([comp("a", "Hero")], { siteNavigation: [{ ...A, label: "Home" }, B] })
    const theirs = doc([comp("a", "Hero")], { siteNavigation: [A, B, C] })
    const out = mergePageDocs(base, ours, theirs)
    expect(out.conflicts).toEqual([])
    expect(out.merged.json_content.siteNavigation.map((i: any) => i.url)).toEqual(["/p/a", "/p/b", "/p/c"])
    expect(out.merged.json_content.siteNavigation[0].label).toBe("Home")
  })
})

describe("page-level scalars are their own conflict units", () => {
  const base = doc([comp("a", "Hero")], {}, { title: "Base", seo_title: "S" })

  test("we changed the title, they did not — ours wins with no conflict", () => {
    const ours = doc([comp("a", "Hero")], {}, { title: "Ours", seo_title: "S" })
    const out = mergePageDocs(base, ours, structuredClone(base))
    expect(out.merged.title).toBe("Ours")
    expect(out.conflicts).toEqual([])
  })

  test("they changed the title, we did not — theirs wins", () => {
    const theirs = doc([comp("a", "Hero")], {}, { title: "Theirs", seo_title: "S" })
    const out = mergePageDocs(base, structuredClone(base), theirs)
    expect(out.merged.title).toBe("Theirs")
    expect(out.conflicts).toEqual([])
  })

  test("both changed the title differently — its own conflict unit", () => {
    const ours = doc([comp("a", "Hero")], {}, { title: "Ours", seo_title: "S" })
    const theirs = doc([comp("a", "Hero")], {}, { title: "Theirs", seo_title: "S" })
    const out = mergePageDocs(base, ours, theirs)
    expect(units(out)).toEqual(["title"])
  })

  test("a json_content scalar (theme) three-ways on its own", () => {
    const ours = { title: "Page", json_content: { version: 2, theme: "dark", components: [comp("a", "Hero")] } }
    const theirs = { title: "Page", json_content: { version: 2, theme: "light", components: [comp("a", "Hero")] } }
    const b = { title: "Page", json_content: { version: 2, theme: "dark", components: [comp("a", "Hero")] } }
    const out = mergePageDocs(b, ours, theirs)
    expect(out.conflicts).toEqual([])
    expect(out.merged.json_content.theme).toBe("light")
  })

  test("server-only fields on `theirs` never leak into the merged local file", () => {
    // getBySlug returns cache_key, created_at, views… The local file is what `pull` writes.
    const theirs: any = doc([comp("a", "Hero")], {}, { title: "Base", seo_title: "S" })
    theirs.cache_key = "abc"
    theirs.updated_at = "2026-09-04"
    theirs.current_version = 91
    const out = mergePageDocs(base, structuredClone(base), theirs)
    expect(out.merged.cache_key).toBeUndefined()
    expect(out.merged.updated_at).toBeUndefined()
    expect(out.merged.current_version).toBeUndefined()
  })

  test("requires_auth always takes the LIVE value — the file is informational (#181984)", () => {
    const ours: any = doc([comp("a", "Hero")], {}, { title: "Base", seo_title: "S", requires_auth: false })
    const theirs: any = doc([comp("a", "Hero")], {}, { title: "Base", seo_title: "S", requires_auth: true })
    const b: any = doc([comp("a", "Hero")], {}, { title: "Base", seo_title: "S", requires_auth: false })
    const out = mergePageDocs(b, ours, theirs)
    expect(out.merged.requires_auth).toBe(true)
    expect(units(out)).not.toContain("requires_auth")
  })
})

describe("no base — an unknown ancestor must not be guessed at", () => {
  test("every difference becomes a conflict rather than a silent pick", () => {
    const ours = doc([comp("a", "Hero", { t: "OURS" })])
    const theirs = doc([comp("a", "Hero", { t: "THEIRS" })])
    const out = mergePageDocs(null, ours, theirs)
    expect(units(out)).toContain("component:a")
    expect(out.mergeable).toBe(false)
  })

  test("but identical sides still merge cleanly", () => {
    const ours = doc([comp("a", "Hero", { t: 1 })])
    const out = mergePageDocs(null, ours, structuredClone(ours))
    expect(out.conflicts).toEqual([])
  })
})

describe("resolution modes and purity", () => {
  const base = doc([comp("a", "Hero", { t: "base" })])
  const ours = doc([comp("a", "Hero", { t: "OURS" })])
  const theirs = doc([comp("a", "Hero", { t: "THEIRS" })])

  test("--ours resolves conflicts to our side but still REPORTS them", () => {
    const out = mergePageDocs(base, ours, theirs, { resolve: "ours" })
    expect(byId(out, "a").props.t).toBe("OURS")
    expect(out.conflicts).toHaveLength(1)
    expect(out.mergeable).toBe(true)
  })

  test("--theirs resolves conflicts to the live side", () => {
    const out = mergePageDocs(base, ours, theirs, { resolve: "theirs" })
    expect(byId(out, "a").props.t).toBe("THEIRS")
    expect(out.mergeable).toBe(true)
  })

  test("a resolve mode does NOT rescue a fatal id problem", () => {
    const dup = doc([comp("a", "Hero"), comp("a", "CTA")])
    const out = mergePageDocs(base, dup, theirs, { resolve: "theirs" })
    expect(out.mergeable).toBe(false)
  })

  test("does not mutate any of its three inputs", () => {
    const b = structuredClone(base), o = structuredClone(ours), t = structuredClone(theirs)
    const out = mergePageDocs(b, o, t, { resolve: "theirs" })
    out.merged.json_content.components[0].props.t = "MUTATED"
    expect(o.json_content.components[0].props.t).toBe("OURS")
    expect(t.json_content.components[0].props.t).toBe("THEIRS")
    expect(b.json_content.components[0].props.t).toBe("base")
  })

  test("never emits a _base — the command owns provenance, the merge owns content", () => {
    const o: any = { ...structuredClone(ours), _base: { version: 89, hash: "x", pulled_at: "y" } }
    const out = mergePageDocs(base, o, theirs, { resolve: "ours" })
    expect(out.merged._base).toBeUndefined()
  })
})

/**
 * CONTRACT AMENDMENT (2026-09-04) — an UNAVAILABLE base is a refusal, not an empty page.
 *
 * `GET /api/v1/pages/{id}/versions/{n}` returns `json_content: null` for versions written
 * before database snapshotting (a `db://` gcs_path with no inline content) and for pruned
 * versions. It does NOT error.
 *
 * Coerce that null to `{}` and every component on both sides reads as "added": the merge
 * either resolves falsely clean or conflicts on absolutely everything. BOTH look like a
 * working merge, which is the worst available failure shape — it is #183600 again, wearing a
 * merge tool's clothes.
 */
describe("versionDocFromRow — telling an unavailable base from an empty one", () => {
  test("a row whose json_content is null is UNAVAILABLE, not empty", () => {
    expect(versionDocFromRow({ version_number: 89, json_content: null })).toBeNull()
  })

  test("a db:// pointer row is unavailable — the content was never inlined", () => {
    expect(versionDocFromRow({ version_number: 89, gcs_path: "db://pages/89.json", json_content: null })).toBeNull()
  })

  test("a json_content that is a string pointer, not a document, is unavailable", () => {
    expect(versionDocFromRow({ version_number: 89, json_content: "db://pages/89.json" })).toBeNull()
  })

  test("a missing row (pruned version) is unavailable", () => {
    expect(versionDocFromRow(null)).toBeNull()
    expect(versionDocFromRow(undefined)).toBeNull()
  })

  test("a genuinely EMPTY page is available — {} is a document, null is an absence", () => {
    // This is the distinction the whole amendment turns on. A page really can have no
    // components, and that must merge normally.
    const doc = versionDocFromRow({ version_number: 89, json_content: { components: [] } })
    expect(doc).not.toBeNull()
    expect(doc.json_content).toEqual({ components: [] })
  })

  test("a JSON-encoded json_content is parsed", () => {
    const doc = versionDocFromRow({ version_number: 89, json_content: JSON.stringify({ components: [{ id: "a" }] }) })
    expect(doc.json_content.components).toHaveLength(1)
  })

  test("carries page scalars only when the row actually has them", () => {
    const doc = versionDocFromRow({ version_number: 89, title: "Base title", json_content: { components: [] } })
    expect(doc.title).toBe("Base title")
    expect("seo_title" in doc).toBe(false)
  })
})

describe("mergePreconditions — refuse before merging on a base we could not load", () => {
  const BASE = { version: 89, hash: null, pulled_at: "x" }

  test("a file with a base whose snapshot is unavailable REFUSES and names the version", () => {
    const r = mergePreconditions(BASE, null)
    expect(r.ok).toBe(false)
    expect(r.lines.join("\n")).toContain("89")
    expect(r.lines.join("\n")).toMatch(/could not be loaded|unavailable/i)
  })

  test("the refusal offers the manual path rather than a silent two-way merge", () => {
    const out = mergePreconditions(BASE, null).lines.join("\n")
    expect(out).toContain("pages diff")
    expect(out).toContain("--ours")
    expect(out).toContain("--theirs")
  })

  test("a loaded base proceeds", () => {
    expect(mergePreconditions(BASE, { json_content: { components: [] } }).ok).toBe(true)
  })

  test("NO base marker at all still proceeds — that is a different situation, and it is honest about it", () => {
    // A hand-written file has no _base. There is nothing to fail to load. Every difference
    // becomes a conflict, which the merge already reports.
    expect(mergePreconditions(null, null).ok).toBe(true)
  })

  test("an explicit --ours / --theirs proceeds even with an unavailable base", () => {
    // The user has said which side wins; the ancestor is then irrelevant, and refusing would
    // leave them with no way forward at all.
    expect(mergePreconditions(BASE, null, "theirs").ok).toBe(true)
  })
})

/**
 * Found by running the command against a stub server, not by a unit test: the merge report
 * listed seo_title / seo_description / og_image as "changed" on a merge that touched none of
 * them. The local file (written by `pull`) carries them as `null`; the live page omits the
 * keys entirely. Nothing changed — one side spells "no value" as null and the other spells it
 * as absent.
 *
 * A report that lists three non-findings next to one real conflict trains the reader to skim
 * past the real one.
 */
describe("null and absent are the same absence, for scalars", () => {
  test("null on our side and absent on theirs is not a change", () => {
    const base = { title: "T", json_content: { components: [] } }
    const ours = { title: "T", seo_title: null, og_image: null, json_content: { components: [] } }
    const theirs = { title: "T", json_content: { components: [] } }

    const out = mergePageDocs(base, ours, theirs)

    expect(out.conflicts).toEqual([])
    expect(out.changes.map((c) => c.unit)).not.toContain("seo_title")
    expect(out.changes.map((c) => c.unit)).not.toContain("og_image")
  })

  test("absent on our side and null on theirs is not a change either", () => {
    const base = { title: "T", json_content: { components: [] } }
    const ours = { title: "T", json_content: { components: [] } }
    const theirs = { title: "T", seo_title: null, json_content: { components: [] } }
    expect(mergePageDocs(base, ours, theirs).changes.map((c) => c.unit)).not.toContain("seo_title")
  })

  test("but a REAL value against null is still a change", () => {
    const base = { title: "T", seo_title: null, json_content: { components: [] } }
    const ours = { title: "T", seo_title: null, json_content: { components: [] } }
    const theirs = { title: "T", seo_title: "Live SEO", json_content: { components: [] } }
    const out = mergePageDocs(base, ours, theirs)
    expect(out.merged.seo_title).toBe("Live SEO")
    expect(out.changes.map((c) => c.unit)).toContain("seo_title")
  })

  test("and clearing a real value TO null is still a change, not a no-op", () => {
    const base = { title: "T", seo_title: "Old", json_content: { components: [] } }
    const ours = { title: "T", seo_title: "Old", json_content: { components: [] } }
    const theirs = { title: "T", seo_title: null, json_content: { components: [] } }
    const out = mergePageDocs(base, ours, theirs)
    expect(out.merged.seo_title).toBeNull()
    expect(out.changes.map((c) => c.unit)).toContain("seo_title")
  })
})

/**
 * Also found by running the command, not by a unit test: `merge --theirs` resolved the
 * conflict, WROTE the file, and then printed "1 conflict — nothing written" followed by the
 * menu of ways to resolve it. Every word of that was false after the fact.
 *
 * This is the report contradicting the action it is reporting on — the same class of defect as
 * a refusal that exits 0, and it is worse here because the file on disk had already changed.
 */
describe("formatMergeReport — the report must not contradict what happened", () => {
  const base = { title: "T", json_content: { components: [{ id: "a", type: "Hero", props: { t: "base" } }] } }
  const ours = { title: "T", json_content: { components: [{ id: "a", type: "Hero", props: { t: "OURS" } }] } }
  const theirs = { title: "T", json_content: { components: [{ id: "a", type: "Hero", props: { t: "THEIRS" } }] } }

  test("an UNRESOLVED conflict says nothing was written and offers the ways out", () => {
    const out = mergePageDocs(base, ours, theirs)
    const text = formatMergeReport("docs", out).join("\n")
    expect(text).toMatch(/nothing written/i)
    expect(text).toContain("--ours")
    expect(text).toContain("--theirs")
  })

  test("a RESOLVED conflict never claims nothing was written", () => {
    const out = mergePageDocs(base, ours, theirs, { resolve: "theirs" })
    const text = formatMergeReport("docs", out, "theirs").join("\n")
    expect(text).not.toMatch(/nothing written/i)
  })

  test("a resolved conflict names which side won, so the choice is on the record", () => {
    const out = mergePageDocs(base, ours, theirs, { resolve: "theirs" })
    const text = formatMergeReport("docs", out, "theirs").join("\n")
    expect(text).toMatch(/resolved/i)
    expect(text).toContain("theirs")
    expect(text).toContain("component:a")
  })

  test("a resolved conflict does not re-offer the menu of resolutions", () => {
    const out = mergePageDocs(base, ours, theirs, { resolve: "ours" })
    const text = formatMergeReport("docs", out, "ours").join("\n")
    expect(text).not.toContain("iris pages merge docs --theirs")
  })

  test("a clean merge with no conflicts says neither", () => {
    const text = formatMergeReport("docs", mergePageDocs(base, ours, structuredClone(base))).join("\n")
    expect(text).not.toMatch(/nothing written/i)
    expect(text).not.toMatch(/resolved/i)
  })
})
