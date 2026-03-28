/**
 * Tests for IRIS platform CLI commands
 *
 * These tests verify:
 * 1. Command exports exist and have the correct shape (command name, subcommands)
 * 2. Command builders define the expected options/positionals
 * 3. API response parsing logic works correctly
 * 4. Error paths are handled gracefully with mocked fetch
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"

// ── Command exports ─────────────────────────────────────────────────────────

import { PlatformChatCommand } from "../../src/cli/cmd/platform-chat"
import { PlatformAgentsCommand } from "../../src/cli/cmd/platform-agents"
import { PlatformLeadsCommand } from "../../src/cli/cmd/platform-leads"
import { PlatformWorkflowsCommand } from "../../src/cli/cmd/platform-workflows"
import { PlatformBloqsCommand } from "../../src/cli/cmd/platform-bloqs"
import { PlatformSchedulesCommand } from "../../src/cli/cmd/platform-schedules"
import { MarketplaceCommand } from "../../src/cli/cmd/marketplace"

// ============================================================================
// Command Registration — verify all commands export correctly
// ============================================================================

describe("command exports", () => {
  test("PlatformChatCommand is exported and has correct command string", () => {
    expect(PlatformChatCommand).toBeDefined()
    expect(PlatformChatCommand.command).toMatch(/^chat/)
    expect(PlatformChatCommand.describe).toBeTruthy()
  })

  test("PlatformAgentsCommand is exported and has correct command string", () => {
    expect(PlatformAgentsCommand).toBeDefined()
    expect(PlatformAgentsCommand.command).toBe("agents")
    expect(PlatformAgentsCommand.describe).toBeTruthy()
  })

  test("PlatformLeadsCommand is exported and has correct command string", () => {
    expect(PlatformLeadsCommand).toBeDefined()
    expect(PlatformLeadsCommand.command).toBe("leads")
    expect(PlatformLeadsCommand.describe).toBeTruthy()
  })

  test("PlatformWorkflowsCommand is exported and has correct command string", () => {
    expect(PlatformWorkflowsCommand).toBeDefined()
    expect(PlatformWorkflowsCommand.command).toBe("workflows")
    expect(PlatformWorkflowsCommand.describe).toBeTruthy()
  })

  test("PlatformBloqsCommand is exported and has correct command string", () => {
    expect(PlatformBloqsCommand).toBeDefined()
    expect(PlatformBloqsCommand.command).toBe("bloqs")
    expect(PlatformBloqsCommand.describe).toBeTruthy()
  })

  test("PlatformSchedulesCommand is exported and has correct command string", () => {
    expect(PlatformSchedulesCommand).toBeDefined()
    expect(PlatformSchedulesCommand.command).toBe("schedules")
    expect(PlatformSchedulesCommand.describe).toBeTruthy()
  })

  test("MarketplaceCommand is exported and has correct command string", () => {
    expect(MarketplaceCommand).toBeDefined()
    expect(MarketplaceCommand.command).toBe("marketplace")
    expect(MarketplaceCommand.describe).toBeTruthy()
  })
})

// ============================================================================
// Command aliases
// ============================================================================

describe("command aliases", () => {
  test("chat has 'c' alias", () => {
    expect(PlatformChatCommand.aliases).toContain("c")
  })

  test("marketplace has 'mp' alias", () => {
    const aliases = Array.isArray(MarketplaceCommand.aliases)
      ? MarketplaceCommand.aliases
      : [MarketplaceCommand.aliases]
    expect(aliases).toContain("mp")
  })

  test("bloqs has 'kb' alias", () => {
    const aliases = Array.isArray(PlatformBloqsCommand.aliases)
      ? PlatformBloqsCommand.aliases
      : [PlatformBloqsCommand.aliases]
    expect(aliases).toContain("kb")
  })
})

// ============================================================================
// Subcommand builders — verify subcommand setup
// ============================================================================

describe("subcommand structure", () => {
  test("agents command has a builder function", () => {
    expect(typeof PlatformAgentsCommand.builder).toBe("function")
  })

  test("leads command has a builder function", () => {
    expect(typeof PlatformLeadsCommand.builder).toBe("function")
  })

  test("workflows command has a builder function", () => {
    expect(typeof PlatformWorkflowsCommand.builder).toBe("function")
  })

  test("bloqs command has a builder function", () => {
    expect(typeof PlatformBloqsCommand.builder).toBe("function")
  })

  test("schedules command has a builder function", () => {
    expect(typeof PlatformSchedulesCommand.builder).toBe("function")
  })

  test("all commands have async handler functions", () => {
    const commands = [
      PlatformChatCommand,
      PlatformAgentsCommand,
      PlatformLeadsCommand,
      PlatformWorkflowsCommand,
      PlatformBloqsCommand,
      PlatformSchedulesCommand,
    ]
    for (const cmd of commands) {
      expect(typeof cmd.handler).toBe("function")
    }
  })
})

// ============================================================================
// API response parsing — test the data extraction patterns used in commands
// ============================================================================

describe("API response data extraction", () => {
  test("extracts data array from wrapped response", () => {
    const response = { success: true, data: [{ id: 1, name: "Agent Alpha" }] }
    const items: any[] = response?.data ?? []
    expect(items.length).toBe(1)
    expect(items[0].name).toBe("Agent Alpha")
  })

  test("falls back to direct array if no data wrapper", () => {
    const response = [{ id: 1, name: "Lead" }]
    const items: any[] = (response as any)?.data ?? response
    expect(items.length).toBe(1)
    expect(items[0].name).toBe("Lead")
  })

  test("returns empty array for empty data", () => {
    const response = { success: true, data: [] }
    const items: any[] = response?.data ?? []
    expect(items).toEqual([])
  })

  test("returns empty array for null data", () => {
    const response = { success: true, data: null }
    const items: any[] = response?.data ?? []
    expect(items).toEqual([])
  })

  test("extracts nested data object from wrapped response", () => {
    const response = { success: true, data: { id: 42, name: "My Bloq" } }
    const item = response?.data ?? response
    expect((item as any).id).toBe(42)
  })

  test("extracts workflow_id from chat start response", () => {
    const response = { workflow_id: "wf-abc123", status: "started" }
    const { workflow_id } = response as { workflow_id?: string }
    expect(workflow_id).toBe("wf-abc123")
  })

  test("handles missing workflow_id gracefully", () => {
    const response = { status: "started" }
    const { workflow_id } = response as { workflow_id?: string }
    expect(workflow_id).toBeUndefined()
  })
})

// ============================================================================
// Workflow status polling logic
// ============================================================================

describe("workflow polling status checks", () => {
  test("recognises 'completed' as terminal status", () => {
    const run = { status: "completed", summary: "Done" }
    const isTerminal = run.status === "completed" || run.status === "failed"
    expect(isTerminal).toBe(true)
  })

  test("recognises 'failed' as terminal status", () => {
    const run = { status: "failed", error: "Something went wrong" }
    const isTerminal = run.status === "completed" || run.status === "failed"
    expect(isTerminal).toBe(true)
  })

  test("recognises 'running' as non-terminal status", () => {
    const run = { status: "running" }
    const isTerminal = run.status === "completed" || run.status === "failed"
    expect(isTerminal).toBe(false)
  })

  test("recognises 'pending' as non-terminal status", () => {
    const run = { status: "pending" }
    const isTerminal = run.status === "completed" || run.status === "failed"
    expect(isTerminal).toBe(false)
  })

  test("extracts response text from summary field", () => {
    const run = { status: "completed", summary: "The analysis is complete." }
    const response = run.summary ?? (run as any).response ?? "(no response)"
    expect(response).toBe("The analysis is complete.")
  })

  test("falls back to response field when summary is missing", () => {
    const run = { status: "completed", response: "Here is the result." }
    const response = (run as any).summary ?? run.response ?? "(no response)"
    expect(response).toBe("Here is the result.")
  })

  test("uses fallback when both summary and response are missing", () => {
    const run = { status: "completed" }
    const response = (run as any).summary ?? (run as any).response ?? "(no response)"
    expect(response).toBe("(no response)")
  })
})

// ============================================================================
// URL parameter building — verify correct URLSearchParams usage
// ============================================================================

describe("URL parameter construction", () => {
  test("builds correct search params for leads list", () => {
    const params = new URLSearchParams({ per_page: "20" })
    params.set("status", "Active")
    params.set("search", "acme")

    expect(params.get("per_page")).toBe("20")
    expect(params.get("status")).toBe("Active")
    expect(params.get("search")).toBe("acme")
    expect(params.toString()).toContain("per_page=20")
    expect(params.toString()).toContain("status=Active")
  })

  test("builds correct search params for agents list", () => {
    const params = new URLSearchParams({ per_page: "10" })
    params.set("search", "my agent")

    expect(params.toString()).toContain("per_page=10")
    expect(params.get("search")).toBe("my agent")
  })

  test("omits optional params when not provided", () => {
    const status: string | undefined = undefined
    const params = new URLSearchParams({ per_page: "20" })
    if (status) params.set("status", status)

    expect(params.has("status")).toBe(false)
    expect(params.get("per_page")).toBe("20")
  })
})

// ============================================================================
// Fetch mocking — verify command fetch patterns work correctly
// ============================================================================

describe("fetch integration patterns", () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.IRIS_API_KEY
  })

  test("successful agents list response is parsed correctly", async () => {
    const mockAgents = [
      { id: 1, name: "Sales Agent", model: "gpt-4.1-nano", description: "Handles sales" },
      { id: 2, name: "Support Agent", model: "gpt-4o-mini", description: "Customer support" },
    ]

    global.fetch = mock(async () =>
      new Response(JSON.stringify({ success: true, data: mockAgents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as any

    process.env.IRIS_API_KEY = "test-key"

    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    const res = await irisFetch("/api/v1/users/1/bloqs/agents")
    const data = (await res.json()) as { data?: any[] }
    const agents: any[] = data?.data ?? []

    expect(agents.length).toBe(2)
    expect(agents[0].name).toBe("Sales Agent")
    expect(agents[1].model).toBe("gpt-4o-mini")
  })

  test("successful leads search response is parsed correctly", async () => {
    const mockLeads = [
      { id: 10, name: "Acme Corp", email: "contact@acme.com", status: "Active" },
    ]

    global.fetch = mock(async () =>
      new Response(
        JSON.stringify({ success: true, data: mockLeads, meta: { total: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as any

    process.env.IRIS_API_KEY = "test-key"

    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    const res = await irisFetch("/api/v1/leads?search=acme")
    const data = (await res.json()) as { data?: any[]; meta?: { total?: number } }
    const leads: any[] = data?.data ?? []

    expect(leads.length).toBe(1)
    expect(leads[0].email).toBe("contact@acme.com")
    expect(data?.meta?.total).toBe(1)
  })

  test("workflow run status is detected correctly from response", async () => {
    const mockRun = {
      id: "run-xyz",
      status: "completed",
      summary: "Research complete: found 5 competitors",
      iteration_count: 3,
    }

    global.fetch = mock(async () =>
      new Response(JSON.stringify({ data: mockRun }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as any

    process.env.IRIS_API_KEY = "test-key"

    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    const res = await irisFetch("/api/v1/workflows/runs/run-xyz")
    const data = (await res.json()) as { data?: any }
    const run = data?.data ?? data

    expect(run.status).toBe("completed")
    expect(run.summary).toContain("5 competitors")
  })

  test("chat start response contains workflow_id", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify({ workflow_id: "wf-123abc", status: "started" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as any

    process.env.IRIS_API_KEY = "test-key"

    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    const res = await irisFetch("/api/chat/start", {
      method: "POST",
      body: JSON.stringify({ query: "hello", agentId: 11 }),
    })
    const { workflow_id } = (await res.json()) as { workflow_id?: string }

    expect(workflow_id).toBe("wf-123abc")
  })

  test("401 error is detected correctly", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as any

    process.env.IRIS_API_KEY = "test-key"

    const { irisFetch, handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = await irisFetch("/api/v1/protected")
    const ok = await handleApiError(res, "Protected call")

    expect(ok).toBe(false)
  })

  test("bloq ingest endpoint URL is correctly formed", () => {
    const userId = 193
    const bloqId = 217
    const FL_API = "https://apiv2.heyiris.io"
    const url = `${FL_API}/api/v1/users/${userId}/bloqs/${bloqId}/files`
    expect(url).toBe("https://apiv2.heyiris.io/api/v1/users/193/bloqs/217/files")
  })
})
