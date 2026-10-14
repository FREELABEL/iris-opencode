import { describe, expect, test } from "bun:test"
import { commandReportOf, commandsSummary, commandTrigger, failed, formatDuration, groupParts, irisCallTrigger, irisGroupSummary, isIrisGroupTool } from "./part-group"

// #189316 — a run of IRIS calls folds into one row; a failure stays visible.
const tool = (id: string, name: string, status: "completed" | "error" | "running" = "completed", input: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}, time = { start: 0, end: 1 }) =>
  ({
    id,
    type: "tool",
    tool: name,
    callID: id,
    messageID: "m1",
    sessionID: "s1",
    state:
      status === "error"
        ? { status, input, error: "Not enough non-option arguments", time }
        : status === "running"
          ? { status, input, title: "", metadata, time: { start: time.start } }
          : { status, input, output: "", title: "", metadata, time },
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
    expect(g[0]).toMatchObject({ type: "context", kind: "commands" })
    expect((g[0] as any).refs.map((r: any) => r.partID)).toEqual(["a", "b", "c"])
  })

  test("file reads and IRIS calls never share a group — each row's summary is about one kind", () => {
    const g = groupParts([at(tool("a", "read")), at(tool("b", "glob")), at(tool("c", "IRIS_OS_iris_run")), at(tool("d", "read"))])
    expect(g.map((x: any) => [x.type, x.kind ?? "files", x.refs?.length])).toEqual([
      ["context", "files", 2],
      ["context", "commands", 1],
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

describe("shell commands fold with IRIS calls (#188457)", () => {
  test("Shell, IRIS, IRIS, Shell is ONE commands row — they alternate in real turns", () => {
    const g = groupParts([
      at(tool("a", "shell", "completed", { command: "ls -la ~/.iris/bin" })),
      at(tool("b", "IRIS_OS_iris_run", "completed", { command: "leads list" })),
      at(tool("c", "IRIS_OS_iris_run")),
      at(tool("d", "bash", "completed", { command: "iris --help | head" })),
      at(text("t")),
      at(tool("e", "read")),
    ])
    expect(g.map((x: any) => [x.type, x.kind ?? "files", x.refs?.length])).toEqual([
      ["context", "commands", 4],
      ["part", "files", undefined],
      ["context", "files", 1],
    ])
  })

  test("a shell command that exits non-zero is a FAILURE, though its part says completed", () => {
    expect(failed(tool("a", "shell", "completed", { command: "ls nope" }, { exit: 2 }))).toBe(true)
    expect(failed(tool("a", "shell", "completed", { command: "ls" }, { exit: 0 }))).toBe(false)
    expect(failed(tool("a", "IRIS_OS_iris_run", "error"))).toBe(true)
  })

  test("running: the summary names only the command executing now; no time until the run ends", () => {
    const s = commandsSummary([
      tool("a", "shell", "completed", { command: "ls" }, { exit: 0 }, { start: 1000, end: 2000 }),
      tool("b", "shell", "running", { command: "iris leads list --search cottonwood" }, {}, { start: 2000, end: 0 }),
    ])
    expect(s.live).toEqual({ title: "$", subtitle: "iris leads list --search cottonwood" })
    expect(s.ms).toBeUndefined()
    expect([s.ran, s.failed, s.allIris]).toEqual([2, 0, false])
  })

  test("done: wall time of the run, first start to last end — not the sum of overlapping calls", () => {
    const s = commandsSummary([
      tool("a", "shell", "completed", { command: "a" }, { exit: 0 }, { start: 1000, end: 31000 }),
      tool("b", "IRIS_OS_iris_run", "completed", { command: "b" }, {}, { start: 5000, end: 42000 }),
    ])
    expect(s.ms).toBe(41000)
    expect(formatDuration(41000)).toBe("41s")
    expect(formatDuration(65000)).toBe("1m 05s")
    expect(formatDuration(800)).toBe("800ms")
    expect(s.live).toBeUndefined()
  })

  test("a shell command reads as `$ <command>`", () => {
    expect(commandTrigger(tool("a", "shell", "completed", { command: "  pwd " }))).toEqual({ title: "$", subtitle: "pwd" })
  })
})

// #189435 — the Report button's payload.
describe("commandReportOf", () => {
  test("a shell command that exited non-zero reports its command, exit code and output", () => {
    const p = tool("s", "bash", "completed", { command: "mkdir -p ~/x && false" }, { exit: 1, output: "mkdir: denied" })
    expect(commandReportOf(p)).toEqual({ tool: "bash", command: "mkdir -p ~/x && false", error: "exit 1", output: "mkdir: denied" })
  })
  test("an IRIS call that errored reports what the row shows and the error text", () => {
    const r = commandReportOf(tool("i", "IRIS_OS_iris_run", "error", { command: "mail accounts" }))
    expect(r?.tool).toBe("IRIS_OS_iris_run")
    expect(r?.error).toBe("Not enough non-option arguments")
    expect(r?.command).toContain("mail accounts")
  })
  test("a successful call has nothing to report", () => {
    expect(commandReportOf(tool("ok", "bash", "completed", { command: "ls" }, { exit: 0 }))).toBeUndefined()
  })
})
