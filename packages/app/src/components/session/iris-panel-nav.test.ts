import { describe, expect, test } from "bun:test"
import { panelScope, readPinnedIds, visibleTabs } from "./iris-panel-nav"

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
  })
})
