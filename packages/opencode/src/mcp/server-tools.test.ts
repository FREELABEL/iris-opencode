import { describe, expect, test } from "bun:test"
import { toolsOfServer } from "./server-tools"

/**
 * Tools are keyed `sanitize(server)_sanitize(tool)`, so splitting a key on "_" cannot say which
 * server it belongs to — "a" and "a_b" both look like owners of "a_b_run". Each candidate is
 * therefore CONFIRMED by recomposing the key from the server and the tool's own name.
 *
 * Shapes measured 2026-09-19 on a running sidecar: `GET /mcp` → {"IRIS OS": {"status":"connected"}}
 * — server names carry spaces, which sanitize() turns into underscores.
 */

const tool = (name: string, description?: string) => ({ def: { name, description } }) as any

describe("the tools of one MCP server", () => {
  const tools = {
    IRIS_OS_iris_run: tool("iris_run", "Run an IRIS command"),
    IRIS_OS_hive_panes: tool("hive_panes", "List panes"),
    other_thing: tool("thing", "Something else"),
  }

  test("a server whose name has a space still finds its tools", () => {
    expect(toolsOfServer("IRIS OS", tools)).toEqual([
      { name: "hive_panes", description: "List panes" },
      { name: "iris_run", description: "Run an IRIS command" },
    ])
  })

  test("another server's tools are not claimed", () => {
    expect(toolsOfServer("other", tools).map((t) => t.name)).toEqual(["thing"])
  })

  test("a prefix collision does not steal tools — the key must recompose exactly", () => {
    const t = { a_b_run: tool("b_run"), a_b_go: tool("go") }
    // "a" owns a_b_run (a + b_run); "a_b" owns a_b_go (a_b + go). Splitting on "_" cannot tell.
    expect(toolsOfServer("a", t).map((x) => x.name)).toEqual(["b_run"])
    expect(toolsOfServer("a_b", t).map((x) => x.name)).toEqual(["go"])
  })

  test("a server with no tools, or one that is not connected, is an empty list — never an error", () => {
    expect(toolsOfServer("absent", tools)).toEqual([])
    expect(toolsOfServer("IRIS OS", {})).toEqual([])
  })

  test("a tool with no description is still listed", () => {
    expect(toolsOfServer("s", { s_x: tool("x") })).toEqual([{ name: "x", description: undefined }])
  })
})
