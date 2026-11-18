import { describe, expect, test } from "bun:test"
import { resolveShow } from "./use-panel-control"
import { IRIS_PANEL_CATALOG } from "./session-iris-tab"

// #190093 — an agent names products the way the user sees them.

describe("resolveShow", () => {
  test("labels resolve to ids, case-insensitively", () => {
    expect(resolveShow({ surface: "Atlas", sub: "Schemas" })).toEqual({ surface: "atlas", sub: "schemas" })
    expect(resolveShow({ surface: "genesis", sub: "artifacts" })).toEqual({ surface: "pages", sub: "artifacts" })
    expect(resolveShow({ surface: "agents" })).toEqual({ surface: "agents", sub: undefined })
  })

  test("unknown names pass through for the panel to report on", () => {
    expect(resolveShow({ surface: "crm", sub: "x" })).toEqual({ surface: "crm", sub: "x" })
    expect(resolveShow({ surface: "atlas", sub: "nope" })).toEqual({ surface: "atlas", sub: "nope" })
  })

  test("the catalog the agent is told about is the switcher's own list", () => {
    const atlas = IRIS_PANEL_CATALOG.find((s) => s.id === "atlas")!
    expect(atlas.subs.map((v) => v.id)).toEqual(["lists", "schemas", "graph", "artifacts"])
    expect(IRIS_PANEL_CATALOG.find((s) => s.id === "pages")?.label).toBe("Genesis")
  })
})
