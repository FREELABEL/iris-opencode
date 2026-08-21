import { describe, test, expect } from "bun:test"
import { validateCommand, extractCitedIds, extractJson, validateAgainstSchema, extractProvenance, MCP_CHILD_ENV } from "./mcp-serve"

describe("validateCommand", () => {
  // --- Should PASS: safe characters in quoted args ---

  test("ampersand in quoted arg", () => {
    const result = validateCommand('leads note 21649 "R&D partnership meeting"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "R&D partnership meeting"])
  })

  test("dollar sign in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Deal worth $50k"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Deal worth $50k"])
  })

  test("exclamation mark in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Great news!"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Great news!"])
  })

  test("question mark in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Can we meet tomorrow?"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Can we meet tomorrow?"])
  })

  test("parentheses in quoted arg", () => {
    const result = validateCommand('leads note 21649 "PILMA Summit (May 20-22)"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "PILMA Summit (May 20-22)"])
  })

  test("curly braces in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Vanguard {HCS} partnership"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Vanguard {HCS} partnership"])
  })

  test("hash and at-sign in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Contact @alex re: issue #42"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Contact @alex re: issue #42"])
  })

  test("percent sign in quoted arg", () => {
    const result = validateCommand('leads note 21649 "Revenue up 30% this quarter"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "Revenue up 30% this quarter"])
  })

  test("all safe special chars combined", () => {
    const result = validateCommand('leads note 21649 "R&D $50k! 30% @alex #42 (yes) {ok}?"')
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "R&D $50k! 30% @alex #42 (yes) {ok}?"])
  })

  test("em dash and en dash", () => {
    const result = validateCommand('leads note 21649 "Phase 1 — complete, tasks 3\u20135 pending"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("—")
  })

  // --- Shell metacharacters are ALLOWED: args go to Bun.spawn (argv array, no
  //     shell), so ; | ` < > \ and newlines are inert literals, not injection
  //     vectors. Blocking them broke legitimate prose + multi-line prompts. ---

  test("allows semicolon (inert — no shell)", () => {
    const result = validateCommand('leads note 21649 "do X; then Y"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toBe("do X; then Y")
  })

  test("allows pipe (inert — no shell)", () => {
    const result = validateCommand('leads note 21649 "revenue | margin breakdown"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("|")
  })

  test("allows backtick (inert — no shell)", () => {
    const result = validateCommand('leads note 21649 "the `hello` handler"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("`")
  })

  test("allows redirect < >", () => {
    const result = validateCommand('leads note 21649 "compare A < B > C"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("<")
    expect(result.args[3]).toContain(">")
  })

  test("allows backslash", () => {
    const result = validateCommand('leads note 21649 "path C\\\\temp is fine"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("\\")
  })

  test("allows newline in arg (multi-line agent prompt)", () => {
    const result = validateCommand('agents create --prompt "You are a helper.\nRULES:\n- be kind"')
    expect(result.error).toBeUndefined()
    expect(result.args[3]).toContain("\n")
  })

  // --- Still REJECT: a NUL byte can truncate an argv string at the syscall ---

  test("rejects NUL byte", () => {
    const result = validateCommand('leads note 21649 "hello\0world"')
    expect(result.error).toBeDefined()
    expect(result.error).toContain("NUL")
  })

  // --- Parsing edge cases ---

  test("empty command", () => {
    const result = validateCommand("")
    expect(result.error).toBe("Empty command")
  })

  test("whitespace-only command", () => {
    const result = validateCommand("   ")
    expect(result.error).toBe("Empty command")
  })

  test("simple unquoted args", () => {
    const result = validateCommand("leads list --limit 5 --json")
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "list", "--limit", "5", "--json"])
  })

  test("single-quoted string", () => {
    const result = validateCommand("leads note 21649 'single quoted note'")
    expect(result.error).toBeUndefined()
    expect(result.args).toEqual(["leads", "note", "21649", "single quoted note"])
  })

  test("mixed quote styles preserves inner quotes", () => {
    const result = validateCommand(`leads note 21649 "double 'inner' quotes"`)
    expect(result.error).toBeUndefined()
    // Inner single quotes inside double-quoted string are literal chars, not delimiters
    expect(result.args[3]).toBe("double 'inner' quotes")
  })
})

describe("extractCitedIds", () => {
  test("plain hash citation", () => {
    expect(extractCitedIds("documented in item #181392.")).toEqual(["181392"])
  })

  test("RAG document-handle form", () => {
    expect(extractCitedIds("From Document #App\\Models\\User\\Bloq\\BloqItem_164650.")).toEqual(["164650"])
  })

  test("deduplicates repeats", () => {
    expect(extractCitedIds("see #181392 and again #181392")).toEqual(["181392"])
  })

  test("multiple distinct ids keep order", () => {
    expect(extractCitedIds("#181392 supersedes #164650")).toEqual(["181392", "164650"])
  })

  // Agent and bloq IDs are 3 digits. Reporting them as cited ITEMS would send a
  // caller to `bloqs items` for something that is not an item.
  test("ignores 3-digit agent/bloq ids", () => {
    expect(extractCitedIds("agent #642 in bloq #532 says no")).toEqual([])
  })

  test("ignores money and years", () => {
    expect(extractCitedIds("$2,000,000 per month as of 2026 — up from 1525/mo")).toEqual([])
  })

  test("no citation returns empty, never null", () => {
    expect(extractCitedIds("I could not retrieve that figure.")).toEqual([])
  })
})

describe("extractJson", () => {
  test("bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  // Models wrap JSON in fences no matter how firmly you ask them not to.
  test("fenced json", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test("prose before and after", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 })
  })

  // indexOf/lastIndexOf would swallow the trailing prose and fail to parse.
  test("nested object followed by prose", () => {
    expect(extractJson('{"a":{"b":2}} — let me know if you need more.')).toEqual({ a: { b: 2 } })
  })

  test("braces inside strings do not confuse the matcher", () => {
    expect(extractJson('{"note":"use {curly} braces"}')).toEqual({ note: "use {curly} braces" })
  })

  test("escaped quote inside string", () => {
    expect(extractJson('{"q":"she said \\"hi\\""}')).toEqual({ q: 'she said "hi"' })
  })

  test("top-level array", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3])
  })

  test("no json returns undefined, not a throw", () => {
    expect(extractJson("I don't have access to that figure.")).toBeUndefined()
  })

  test("malformed json returns undefined", () => {
    expect(extractJson('{"a":}')).toBeUndefined()
  })
})

describe("validateAgainstSchema", () => {
  const S = {
    type: "object",
    required: ["mrr", "source"],
    properties: { mrr: { type: "number" }, source: { type: "string" } },
  }

  test("valid object has no errors", () => {
    expect(validateAgainstSchema({ mrr: 1525, source: "#158048" }, S)).toEqual([])
  })

  test("missing required field is path-qualified", () => {
    expect(validateAgainstSchema({ mrr: 1525 }, S)).toEqual(["$.source: required field missing"])
  })

  test("wrong type names both expected and actual", () => {
    expect(validateAgainstSchema({ mrr: "1525", source: "x" }, S)).toEqual([
      "$.mrr: expected number, got string",
    ])
  })

  // A model returning a bare string for an object schema must not pass.
  test("scalar against object schema fails", () => {
    expect(validateAgainstSchema("nope", S)).toEqual(["$: expected object, got string"])
  })

  test("null is null, not object", () => {
    expect(validateAgainstSchema(null, { type: "object" })).toEqual(["$: expected object, got null"])
  })

  test("array is array, not object", () => {
    expect(validateAgainstSchema([], { type: "object" })).toEqual(["$: expected object, got array"])
  })

  test("integer accepts whole numbers only", () => {
    expect(validateAgainstSchema(3, { type: "integer" })).toEqual([])
    expect(validateAgainstSchema(3.5, { type: "integer" })).toEqual(["$: expected integer, got number"])
  })

  test("enum violation reports the allowed set", () => {
    expect(validateAgainstSchema("maybe", { enum: ["yes", "no"] })).toEqual([
      '$: "maybe" is not one of ["yes","no"]',
    ])
  })

  test("array items are validated per index", () => {
    const arr = { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "number" } } } }
    expect(validateAgainstSchema([{ id: 1 }, { id: "2" }, {}], arr)).toEqual([
      "$[1].id: expected number, got string",
      "$[2].id: required field missing",
    ])
  })

  test("nested objects report a full path", () => {
    const nested = { type: "object", properties: { a: { type: "object", properties: { b: { type: "number" } } } } }
    expect(validateAgainstSchema({ a: { b: "x" } }, nested)).toEqual(["$.a.b: expected number, got string"])
  })

  test("collects multiple errors rather than stopping at the first", () => {
    expect(validateAgainstSchema({}, S).length).toBe(2)
  })
})

describe("extractProvenance", () => {
  const RAG = {
    type: "memory_injection",
    label: "context: rag_context",
    data: {
      bloq_id: 532,
      document_count: 3,
      sources: [
        "Document #App\\Models\\User\\Bloq\\BloqItem_164650",
        "Document #App\\Models\\User\\Bloq\\BloqItem_181392",
      ],
    },
  }
  const HIST = {
    type: "memory_injection",
    label: "context: conversation_history",
    data: { thread_id: "user_193_agent_642", message_count: 20 },
  }

  test("pulls retrieved item ids out of RAG sources", () => {
    expect(extractProvenance([RAG]).retrieved_item_ids).toEqual(["164650", "181392"])
  })

  test("captures the retrieval bloq and document count", () => {
    const p = extractProvenance([RAG])
    expect(p.retrieval_bloq_id).toBe(532)
    expect(p.document_count).toBe(3)
  })

  test("captures the conversation thread — ask is NOT stateless", () => {
    const p = extractProvenance([HIST])
    expect(p.thread_id).toBe("user_193_agent_642")
    expect(p.history_messages).toBe(20)
  })

  // Arrow-decorated labels must collapse to ONE tool, not two.
  test("pairs tool_call with tool_result status", () => {
    const p = extractProvenance([
      { type: "tool_call", label: "→ SearchKnowledgeBaseTool", data: { query: "x" } },
      { type: "tool_result", label: "← SearchKnowledgeBaseTool", data: { status: "success" } },
    ])
    expect(p.tool_calls).toEqual([{ tool: "SearchKnowledgeBaseTool", status: "success" }])
  })

  test("a call with no result keeps the tool without a status", () => {
    const p = extractProvenance([{ type: "tool_call", label: "→ getRevenue" }])
    expect(p.tool_calls).toEqual([{ tool: "getRevenue" }])
  })

  test("deduplicates repeated source documents", () => {
    const dup = { ...RAG, data: { ...RAG.data, sources: [RAG.data.sources[0], RAG.data.sources[0]] } }
    expect(extractProvenance([dup]).retrieved_item_ids).toEqual(["164650"])
  })

  // Upstream trace changes must degrade to empty, never throw inside a tool call.
  test("non-array input returns an empty provenance", () => {
    expect(extractProvenance(undefined).retrieved_item_ids).toEqual([])
    expect(extractProvenance(null).tool_calls).toEqual([])
    expect(extractProvenance("nope").thread_id).toBeNull()
  })

  test("malformed events are skipped, not fatal", () => {
    const p = extractProvenance([null, 42, { type: "memory_injection" }, RAG])
    expect(p.retrieved_item_ids).toEqual(["164650", "181392"])
  })

  test("unrelated trace events contribute nothing", () => {
    const p = extractProvenance([{ type: "thinking", label: "thinking", data: "..." }])
    expect(p).toEqual({
      retrieved_item_ids: [],
      retrieval_bloq_id: null,
      document_count: null,
      tool_calls: [],
      thread_id: null,
      history_messages: null,
    })
  })
})

describe("MCP surface attribution", () => {
  // Regression: Beacon.source() returns "mcp" only when IRIS_MCP === "1", and
  // nothing set it. Every command run through an MCP tool therefore reported
  // source:"cli", so `iris usage` showed 1 mcp run against 55 MCP tool calls.
  // The child process is where the run is opened, so the parent alone is not enough.
  test("children spawned for MCP tools are marked as MCP-surface work", () => {
    expect(MCP_CHILD_ENV.IRIS_MCP).toBe("1")
  })

  test("children stay non-interactive", () => {
    expect(MCP_CHILD_ENV.IRIS_NON_INTERACTIVE).toBe("1")
  })
})
