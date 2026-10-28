import { describe, expect, test } from "bun:test"
import {
  DEFAULT_NAV_LAYOUT,
  FILES_ITEM,
  type NavLayout,
  isNavItemVisible,
  legacyNavLayout,
  mergeNavLayout,
  parseNavLayout,
  setNavItemVisible,
  visibleNavItems,
} from "./iris-nav-layout"

const DEF = DEFAULT_NAV_LAYOUT
const merged = (saved: NavLayout | null) => mergeNavLayout(DEF, saved)

describe("the shipped default (#191509)", () => {
  test("first run: Atlas first, Genesis second, Files & folders hidden", () => {
    const l = merged(null)
    expect(visibleNavItems(l).slice(0, 2)).toEqual(["atlas", "pages"])
    expect(isNavItemVisible(l, FILES_ITEM)).toBe(false)
    expect(l.order).toContain(FILES_ITEM) // still reachable, just not shown
    expect(l.version).toBe(DEF.version)
  })
  test("first run returns a copy — editing it cannot change the default", () => {
    const l = merged(null)
    l.hidden.push("atlas")
    expect(DEF.hidden).not.toContain("atlas")
  })
})

describe("a saved layout always wins on upgrade", () => {
  test("a person who reordered keeps their order", () => {
    const saved: NavLayout = { version: 1, order: ["pulse", "agents", "pages", "atlas", FILES_ITEM], hidden: [FILES_ITEM] }
    const l = merged(saved)
    expect(visibleNavItems(l).slice(0, 4)).toEqual(["pulse", "agents", "pages", "atlas"])
  })
  test("a person who un-hid Files & folders keeps it shown", () => {
    const saved: NavLayout = { version: 1, order: [FILES_ITEM, "pages", "atlas"], hidden: [] }
    expect(isNavItemVisible(merged(saved), FILES_ITEM)).toBe(true)
  })
  test("a person who hid Atlas keeps it hidden", () => {
    const saved: NavLayout = { version: 1, order: ["pages", "atlas", "agents"], hidden: ["atlas"] }
    const l = merged(saved)
    expect(isNavItemVisible(l, "atlas")).toBe(false)
    expect(visibleNavItems(l)[0]).toBe("pages")
  })
  test("a hidden item missing from `order` is still a choice, not a new item", () => {
    const saved: NavLayout = { version: 2, order: ["pages"], hidden: ["atlas"] }
    expect(isNavItemVisible(merged(saved), "atlas")).toBe(false)
  })
  test("ids the app no longer knows are dropped; duplicates removed", () => {
    const saved: NavLayout = { version: 1, order: ["gone", "atlas", "atlas", "pages"], hidden: ["gone"] }
    const l = merged(saved)
    expect(l.order).not.toContain("gone")
    expect(l.hidden).not.toContain("gone")
    expect(l.order.filter((x) => x === "atlas")).toHaveLength(1)
  })
})

describe("a new item in a later version", () => {
  const v3: NavLayout = {
    version: 3,
    order: ["atlas", "pages", "studio", "agents", "pulse", FILES_ITEM, "inbox"],
    hidden: [FILES_ITEM, "inbox"],
  }
  const saved: NavLayout = { version: 2, order: ["agents", "atlas", "pages", "pulse", FILES_ITEM], hidden: ["pulse"] }
  test("lands at the default's position, after the item that precedes it", () => {
    const l = mergeNavLayout(v3, saved)
    expect(l.order).toEqual(["agents", "atlas", "pages", "studio", "pulse", FILES_ITEM, "inbox"])
    expect(l.version).toBe(3)
  })
  test("takes the default's visibility; the person's own choices are untouched", () => {
    const l = mergeNavLayout(v3, saved)
    expect(isNavItemVisible(l, "studio")).toBe(true)
    expect(isNavItemVisible(l, "inbox")).toBe(false)
    expect(isNavItemVisible(l, "pulse")).toBe(false) // they hid it; v3 shows it by default
    expect(isNavItemVisible(l, FILES_ITEM)).toBe(true) // they showed it; v3 hides it by default
  })
  test("a new item first in the default goes first", () => {
    const v4: NavLayout = { version: 4, order: ["home", ...v3.order], hidden: v3.hidden }
    expect(mergeNavLayout(v4, saved).order[0]).toBe("home")
  })
})

describe("showing and hiding", () => {
  test("hiding keeps the slot; showing moves it after the last shown item", () => {
    const l = merged(null)
    const off = setNavItemVisible(l, "atlas", false)
    expect(off.order).toEqual(l.order)
    expect(isNavItemVisible(off, "atlas")).toBe(false)
    const files = setNavItemVisible(l, FILES_ITEM, true)
    const shown = visibleNavItems(files)
    expect(shown[shown.length - 1]).toBe(FILES_ITEM)
  })
  test("a choice survives the next upgrade", () => {
    const chosen = setNavItemVisible(merged(null), FILES_ITEM, true)
    const reread = parseNavLayout(JSON.stringify(chosen))
    expect(isNavItemVisible(merged(reread), FILES_ITEM)).toBe(true)
  })
})

describe("reading storage", () => {
  test("nothing, garbage or a non-layout is null — i.e. the default", () => {
    expect(parseNavLayout(null)).toBeNull()
    expect(parseNavLayout("{nope")).toBeNull()
    expect(parseNavLayout(JSON.stringify(["atlas"]))).toBeNull()
  })
})

describe("carrying over the pre-#191509 pins", () => {
  test("nothing saved before → no layout, so the new default applies", () => {
    expect(legacyNavLayout(null, null, DEF)).toBeNull()
  })
  test("pins keep their order; unpinned products stay hidden; the file tree they had stays", () => {
    const legacy = legacyNavLayout(JSON.stringify(["pages", "atlas", "agents", "pulse"]), null, DEF)
    const l = merged(legacy)
    expect(visibleNavItems(l).filter((x) => x !== FILES_ITEM)).toEqual(["pages", "atlas", "agents", "pulse"])
    expect(isNavItemVisible(l, "hive")).toBe(false)
    expect(isNavItemVisible(l, FILES_ITEM)).toBe(true)
    expect(l.order.slice(0, 4)).toEqual(["pages", "atlas", "agents", "pulse"])
  })
  test("a stored file-tree choice is kept either way", () => {
    expect(isNavItemVisible(merged(legacyNavLayout(null, "1", DEF)), FILES_ITEM)).toBe(true)
    expect(isNavItemVisible(merged(legacyNavLayout(JSON.stringify(["atlas"]), "0", DEF)), FILES_ITEM)).toBe(false)
  })
  test("only a file-tree choice: the new default order, with that choice", () => {
    const l = merged(legacyNavLayout(null, "1", DEF))
    expect(visibleNavItems(l).filter((x) => x !== FILES_ITEM).slice(0, 2)).toEqual(["atlas", "pages"])
  })
})
