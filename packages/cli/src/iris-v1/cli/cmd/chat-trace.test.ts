import { describe, expect, test } from "bun:test"
import { ChatTracer, toTraceLevel } from "./chat-trace"

/**
 * The two levels answer different questions, and the ONLY thing separating them is
 * whether payloads are printed. If light ever starts dumping a tool result it stops
 * fitting on a screen and stops being usable as a progress indicator, so that
 * boundary is asserted directly.
 */

/** One real turn, captured from /api/v6/chat/stream against agent #642. */
const STREAM: Array<Record<string, unknown>> = [
  { type: "iteration", iteration: 0, message: "Starting ReAct loop" },
  {
    type: "memory_injection",
    memory_type: "rag_context",
    description: "Retrieved 3 relevant documents from Document #BloqItem_158047",
    data: { bloq_id: 532, document_count: 3, sources: ["Document #BloqItem_158047"] },
    iteration: 0,
  },
  { type: "iteration", iteration: 1, message: "Iteration 1/10" },
  { type: "thinking", content: "Reasoning about next action...", iteration: 1, model: "gpt-4o-mini", tools_available: 8 },
  { type: "reasoning", content: "Calling SearchKnowledgeBaseTool...", iteration: 1, tool_count: 1 },
  {
    type: "tool_call",
    tool: "SearchKnowledgeBaseTool",
    arguments: { bloq_id: 532, query: "leads" },
    description: "Search the user's knowledge base",
    iteration: 1,
  },
  {
    type: "tool_result",
    tool: "SearchKnowledgeBaseTool",
    result: { status: "success", data: { found: true, results: [{ id: "a" }, { id: "b" }] } },
    status: "success",
    iteration: 1,
  },
  { type: "done", content: "You have 5 leads.", tools_used: ["SearchKnowledgeBaseTool"], iterations: 2, status: "completed" },
]

function run(level: 0 | 1 | 2) {
  const lines: string[] = []
  let clock = 0
  const tracer = new ChatTracer(level, (l) => lines.push(l), undefined, () => (clock += 100))
  for (const e of STREAM) tracer.handle(e as any)
  return { lines, text: lines.join("\n"), tracer }
}

describe("ChatTracer", () => {
  test("level 0 renders nothing and collects nothing", () => {
    const { lines, tracer } = run(0)
    expect(lines).toHaveLength(0)
    expect(tracer.steps).toHaveLength(0)
    expect(tracer.enabled).toBe(false)
  })

  test("light shows the shape of the run — every iteration, tool call and tool result", () => {
    const { text } = run(1)
    expect(text).toContain("Starting ReAct loop")
    expect(text).toContain("Iteration 1/10")
    expect(text).toContain("→ SearchKnowledgeBaseTool")
    expect(text).toContain("← SearchKnowledgeBaseTool")
    expect(text).toContain("context: rag_context")
  })

  test("light names the model and the tool count — the two facts that explain a bad routing decision", () => {
    const { text } = run(1)
    expect(text).toContain("model=gpt-4o-mini")
    expect(text).toContain("tools_available=8")
  })

  test("light summarises tool arguments but never dumps a payload", () => {
    const { lines } = run(1)
    const call = lines.find((l) => l.includes("→ SearchKnowledgeBaseTool"))!
    expect(call).toContain("query=leads")
    // The giveaway of a dumped payload is the continuation gutter.
    expect(lines.some((l) => l.includes("│"))).toBe(false)
    for (const l of lines) expect(l.length).toBeLessThan(240)
  })

  test("light reports result SIZE next to status — an empty success is the classic silent failure", () => {
    const { lines } = run(1)
    const res = lines.find((l) => l.includes("← SearchKnowledgeBaseTool"))!
    expect(res).toContain("success")
    expect(res).toContain("2 items")
  })

  test("heavy adds the payloads, and only heavy does", () => {
    const { text } = run(2)
    expect(text).toContain("│")
    expect(text).toContain('"query": "leads"')
    expect(text).toContain('"found": true')
  })

  test("the final answer is not repeated in the trace — the normal output already prints it", () => {
    for (const level of [1, 2] as const) {
      expect(run(level).text).not.toContain("You have 5 leads.")
    }
  })

  test("steps are ordered, sequenced and timestamped so --json carries the same trace", () => {
    const { tracer } = run(1)
    expect(tracer.steps.map((s) => s.seq)).toEqual([...tracer.steps.keys()])
    expect(tracer.steps.map((s) => s.at_ms)).toEqual([...tracer.steps.keys()].map((i) => (i + 1) * 100))
    expect(tracer.steps.filter((s) => s.type === "tool_call")).toHaveLength(1)
    expect(tracer.steps.find((s) => s.type === "tool_call")!.tool).toBe("SearchKnowledgeBaseTool")
  })

  test("light drops the streamed answer, heavy keeps it — the answer is printed in full below either way", () => {
    const withText = [...STREAM]
    withText.splice(7, 0, { type: "text", content: "You have 5 leads.", iteration: 2 })
    const render = (level: 1 | 2) => {
      const lines: string[] = []
      const t = new ChatTracer(level, (l) => lines.push(l))
      for (const e of withText) t.handle(e as any)
      return lines.join("\n")
    }
    expect(render(1)).not.toContain("You have 5 leads.")
    expect(render(2)).toContain("You have 5 leads.")
  })

  test("an unknown event type still renders rather than vanishing", () => {
    const lines: string[] = []
    new ChatTracer(1, (l) => lines.push(l)).handle({ type: "some_future_event", content: "hello" } as any)
    expect(lines.join("")).toContain("some_future_event")
    expect(lines.join("")).toContain("hello")
  })
})

describe("toTraceLevel", () => {
  test("maps the yargs count, clamping -VVV down to heavy", () => {
    expect(toTraceLevel(undefined)).toBe(0)
    expect(toTraceLevel(0)).toBe(0)
    expect(toTraceLevel(1)).toBe(1)
    expect(toTraceLevel(2)).toBe(2)
    expect(toTraceLevel(7)).toBe(2)
  })
})
