import { describe, expect, test } from "bun:test"
import {
  hasNonBlockingServiceIssue,
  hasServiceNeedingAttention,
  serverStatusDotClass,
  serverStatusDotLabelKey,
} from "./status-popover-indicator"

describe("serverStatusDotClass", () => {
  test("uses the success token while the server and services are healthy", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, issue: false })).toBe("bg-icon-success-base")
  })

  test("uses the session attention token when a service needs attention", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, attention: true, issue: true })).toBe(
      "bg-v2-background-bg-accent",
    )
  })

  test("uses the warning token for non-blocking issues while the server is online", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, issue: true })).toBe("bg-icon-warning-base")
  })

  test("uses the critical token only after the server connection drops", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: false, issue: false })).toBe("bg-icon-critical-base")
    expect(serverStatusDotClass({ ready: true, serverHealth: false, issue: true })).toBe("bg-icon-critical-base")
  })

  test("stays neutral before status is ready", () => {
    expect(serverStatusDotClass({ ready: false, serverHealth: true, issue: false })).toBe("bg-border-weak-base")
    expect(serverStatusDotClass({ ready: false, serverHealth: undefined, issue: false })).toBe("bg-border-weak-base")
  })
})

describe("hasNonBlockingServiceIssue", () => {
  test("detects MCP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue({ mcp: ["failed"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["needs_auth"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["needs_client_registration"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["connected", "pending", "disabled"], lsp: [] })).toBe(false)
  })

  test("detects LSP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue({ mcp: [], lsp: ["error"] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: [], lsp: ["connected"] })).toBe(false)
  })
})

describe("hasServiceNeedingAttention", () => {
  test("detects MCP states that need user attention", () => {
    expect(hasServiceNeedingAttention({ mcp: ["needs_auth"] })).toBe(true)
    expect(hasServiceNeedingAttention({ mcp: ["needs_client_registration"] })).toBe(true)
  })

  test("ignores states that do not need user attention", () => {
    expect(hasServiceNeedingAttention({ mcp: ["failed"] })).toBe(false)
    expect(hasServiceNeedingAttention({ mcp: ["connected", "pending", "disabled"] })).toBe(false)
  })
})

// #186524 — the dot said nothing on its own; a client had to ask what green meant.
describe("serverStatusDotLabelKey", () => {
  test("every dot colour has a sentence, chosen by the same rules", () => {
    const cases: Array<[Parameters<typeof serverStatusDotLabelKey>[0], string]> = [
      [{ ready: true, serverHealth: true, issue: false }, "status.dot.healthy"],
      [{ ready: true, serverHealth: true, attention: true, issue: true }, "status.dot.attention"],
      [{ ready: true, serverHealth: true, issue: true }, "status.dot.issue"],
      [{ ready: true, serverHealth: false, issue: false }, "status.dot.offline"],
      [{ ready: false, serverHealth: true, issue: false }, "status.dot.connecting"],
      [{ ready: true, serverHealth: undefined, issue: false }, "status.dot.connecting"],
    ]
    for (const [input, key] of cases) expect(serverStatusDotLabelKey(input)).toBe(key)
  })

  test("colour and words are picked by the same state, so they cannot disagree", () => {
    // one distinct sentence per distinct colour
    const states: Parameters<typeof serverStatusDotClass>[0][] = [
      { ready: true, serverHealth: true, issue: false },
      { ready: true, serverHealth: true, attention: true, issue: true },
      { ready: true, serverHealth: true, issue: true },
      { ready: true, serverHealth: false, issue: false },
      { ready: false, serverHealth: undefined, issue: false },
    ]
    const colours = new Set(states.map((s) => serverStatusDotClass(s)))
    const labels = new Set(states.map((s) => serverStatusDotLabelKey(s)))
    expect(labels.size).toBe(colours.size)
  })
})
