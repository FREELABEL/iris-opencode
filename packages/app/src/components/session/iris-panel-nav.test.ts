import { describe, expect, test } from "bun:test"
import {
  openingSurface,
  panelScope,
  pinnedByChoice,
  readPinnedIds,
  scopeChipLabel,
  visibleTabs,
} from "./iris-panel-nav"

const VALID = ["atlas", "agents", "leads", "pages", "mcp", "hive", "playbooks", "integrations"]
const DEF = ["pages", "atlas", "agents"]

describe("pinned products", () => {
  test("nothing stored → the defaults", () => {
    expect(readPinnedIds(null, VALID, DEF)).toEqual(DEF)
  })
  test("stored set is kept in order; unknown ids and duplicates dropped", () => {
    expect(readPinnedIds(JSON.stringify(["hive", "gone", "pages", "hive"]), VALID, DEF)).toEqual(["hive", "pages"])
  })
  test("garbage or an empty list never leaves the panel with no tabs", () => {
    expect(readPinnedIds("{not json", VALID, DEF)).toEqual(DEF)
    expect(readPinnedIds("[]", VALID, DEF)).toEqual(DEF)
  })
  test("an unpinned product that is open still gets a (temporary) tab", () => {
    expect(visibleTabs(["pages", "atlas"], "integrations")).toEqual(["pages", "atlas", "integrations"])
    expect(visibleTabs(["pages", "atlas"], "atlas")).toEqual(["pages", "atlas"])
  })
})

describe("the project row tells the truth about scope", () => {
  test("project products show the project", () => {
    expect(panelScope("atlas", "atlas")).toBe("project")
    expect(panelScope("pages", "pages")).toBe("project")
  })
  test("account-wide products say so", () => {
    for (const s of ["hive", "integrations", "mcp"]) expect(panelScope(s, s)).toBe("account")
    expect(panelScope("atlas", "graph")).toBe("account")
  })
  test("artifacts belong to the session", () => {
    expect(panelScope("pages", "artifacts")).toBe("session")
    expect(panelScope("atlas", "atlas-artifacts")).toBe("session")
  })
})

describe("the scope chip names the project (#187130 C)", () => {
  test("project → the name, never the word 'project'", () => {
    expect(scopeChipLabel("project", "NCMA Fort Worth")).toBe("NCMA Fort Worth")
    expect(scopeChipLabel("project", "  ")).toBe("choose a project")
  })
  test("session and account say so", () => {
    expect(scopeChipLabel("session", "NCMA")).toBe("this session")
    expect(scopeChipLabel("account")).toBe("account")
  })
})

describe("opening product (#189766)", () => {
  test("only a pin the person stored counts — the default set is not a choice", () => {
    expect(pinnedByChoice(null, "atlas")).toBe(false)
    expect(pinnedByChoice("not json", "atlas")).toBe(false)
    expect(pinnedByChoice(JSON.stringify(["pages", "agents"]), "atlas")).toBe(false)
    expect(pinnedByChoice(JSON.stringify(["agents", "atlas"]), "atlas")).toBe(true)
  })
  test("pinned Atlas opens on Atlas, whatever was used last", () => {
    expect(openingSurface("pulse", JSON.stringify(["pulse", "atlas"]))).toBe("atlas")
  })
  test("everyone else opens on the product they used last, as before", () => {
    expect(openingSurface("pulse", null)).toBe("pulse")
    expect(openingSurface("pulse", JSON.stringify(["pulse", "agents"]))).toBe("pulse")
  })
})
