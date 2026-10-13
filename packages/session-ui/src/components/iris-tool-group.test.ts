import { describe, expect, test } from "bun:test"
import { groupParts, irisCallTrigger, irisGroupSummary, isIrisGroupTool } from "./part-group"

// #189316 — a run of IRIS calls folds into one row; a failure stays visible.
const tool = (id: string, name: string, status: "completed" | "error" = "completed", input: Record<string, unknown> = {}) =>
  ({
    id,
    type: "tool",
    tool: name,
    callID: id,
    messageID: "m1",
    sessionID: "s1",
    state: status === "error" ? { status, input, error: "Not enough non-option arguments", time: { start: 0, end: 1 } } : { status, input, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
  }) as any
const text = (id: string) => ({ id, type: "text", text: "Gmail is connected.", messageID: "m1", sessionID: "s1" }) as any
const at = (part: any) => ({ messageID: "m1", part })

describe("IRIS call grouping (#189316)", () => {
  test("consecutive IRIS calls become ONE group of kind iris; text between calls ends it", () => {
    const g = groupParts([
      at(tool("a", "IRIS_OS_iris_run", "error", { command: "mail accounts" })),
      at(tool("b", "IRIS_OS_iris_help", "completed", { command: "mail search" })),
      at(tool("c", "IRIS_OS_iris_run", "completed", { command: 'mail search "Mercury" --limit 5' })),
      at(text("t")),
      at(tool("d", "IRIS_OS_iris_run", "completed", { command: "integrations exec gmail" })),
    ])
    expect(g.map((x) => x.type)).toEqual(["context", "part", "context"])
    expect(g[0]).toMatchObject({ type: "context", kind: "iris" })
    expect((g[0] as any).refs.map((r: any) => r.partID)).toEqual(["a", "b", "c"])
  })

  test("file reads and IRIS calls never share a group — each row's summary is about one kind", () => {
    const g = groupParts([at(tool("a", "read")), at(tool("b", "glob")), at(tool("c", "IRIS_OS_iris_run")), at(tool("d", "read"))])
    expect(g.map((x: any) => [x.type, x.kind ?? "files", x.refs?.length])).toEqual([
      ["context", "files", 2],
      ["context", "iris", 1],
      ["context", "files", 1],
    ])
  })

  test("a files-only group is unchanged: no kind key, so it compares equal to one built before", () => {
    const g = groupParts([at(tool("a", "read")), at(tool("b", "grep"))])
    expect("kind" in g[0]!).toBe(false)
  })

  test("only the IRIS gateway's tools fold; an ordinary tool keeps its own row", () => {
    expect(isIrisGroupTool(tool("a", "IRIS_OS_playbook_atlas-epic"))).toBe(true)
    expect(isIrisGroupTool(tool("a", "bash"))).toBe(false)
    expect(isIrisGroupTool(tool("a", "genesis_artifact"))).toBe(false)
  })

  test("each call reads as the command that ran; failures are counted", () => {
    expect(irisCallTrigger(tool("a", "IRIS_OS_iris_run", "completed", { command: 'mail search "Netflix" --limit 5' }))).toEqual({
      title: "iris",
      subtitle: 'mail search "Netflix" --limit 5',
    })
    expect(irisCallTrigger(tool("a", "IRIS_OS_iris_help", "completed", { command: "mail" }))).toEqual({ title: "iris help", subtitle: "mail" })
    expect(irisGroupSummary([tool("a", "IRIS_OS_iris_run", "error"), tool("b", "IRIS_OS_iris_run"), tool("c", "IRIS_OS_iris_run", "error")])).toEqual({ ran: 3, failed: 2 })
  })
})
