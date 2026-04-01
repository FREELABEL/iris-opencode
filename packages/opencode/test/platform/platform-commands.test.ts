/**
 * Tests for IRIS platform CLI commands
 *
 * These tests verify:
 * 1. Command exports exist and have the correct shape (command name, subcommands)
 * 2. Command builders define the expected options/positionals
 * 3. API response parsing logic works correctly
 * 4. Error paths are handled gracefully with mocked fetch
 * 5. Source code integrity — every handler that uses userId declares --user-id
 * 6. Endpoint URL contracts — correct API paths for each resource
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// ── Source file paths for integrity tests ───────────────────────────────────
const SRC_DIR = join(import.meta.dir, "../../src/cli/cmd")
function readSource(filename: string): string {
  return readFileSync(join(SRC_DIR, filename), "utf-8")
}

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

// ============================================================================
// Source code integrity — every requireUserId call must have --user-id option
// ============================================================================
// These tests read the actual source files and verify that:
// - Every handler calling requireUserId also declares .option("user-id"
// - Every URL template with ${userId} has requireUserId called before it
// - No free-variable references to userId (must be declared in scope)
// This catches the class of bugs where userId is used but never defined.

describe("source code integrity: --user-id option declarations", () => {
  const FILES_NEEDING_USER_ID = [
    "platform-agents.ts",
    "platform-bloqs.ts",
    "platform-schedules.ts",
    "platform-workflows.ts",
    "platform-leads.ts",
  ]

  for (const file of FILES_NEEDING_USER_ID) {
    test(`${file}: every requireUserId call is paired with .option("user-id")`, () => {
      const source = readSource(file)

      // Count requireUserId calls (excluding imports)
      const requireCalls = source.match(/await requireUserId\(/g) ?? []
      // Count user-id option declarations
      const optionDecls = source.match(/\.option\("user-id"/g) ?? []

      // Every handler that calls requireUserId should also declare the option
      // Some files (like leads) may not need userId in paths but still use it
      if (requireCalls.length > 0) {
        expect(optionDecls.length).toBeGreaterThanOrEqual(requireCalls.length)
      }
    })
  }

  test("platform-workflows.ts: no (args as any) casts for user-id", () => {
    const source = readSource("platform-workflows.ts")
    expect(source).not.toContain('(args as any)["user-id"]')
  })

  test("platform-schedules.ts: no (args as any) casts for user-id", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).not.toContain('(args as any)["user-id"]')
  })
})

describe("source code integrity: userId scope safety", () => {
  test("platform-workflows.ts: pollRun function takes userId as parameter", () => {
    const source = readSource("platform-workflows.ts")
    // pollRun must accept userId as a function parameter, not use it as a free variable
    expect(source).toMatch(/async function pollRun\(\s*userId/)
  })

  test("platform-workflows.ts: pollRun is called with userId argument", () => {
    const source = readSource("platform-workflows.ts")
    // Every call to pollRun should pass userId as the first arg
    const pollRunCalls = source.match(/await pollRun\(/g) ?? []
    const pollRunWithUserId = source.match(/await pollRun\(userId/g) ?? []
    expect(pollRunCalls.length).toBeGreaterThan(0)
    expect(pollRunWithUserId.length).toBe(pollRunCalls.length)
  })

  test("platform-workflows.ts: every handler with userId URL calls requireUserId", () => {
    const source = readSource("platform-workflows.ts")
    // Split into handler blocks (each async handler(args) { ... })
    const handlers = source.split(/async handler\(args\)/)
    for (const block of handlers.slice(1)) {
      // If this handler references ${userId} in a URL, it must call requireUserId
      if (block.includes("${userId}") || block.includes("pollRun(")) {
        expect(block).toContain("requireUserId")
      }
    }
  })

  test("platform-schedules.ts: every handler calls requireUserId", () => {
    const source = readSource("platform-schedules.ts")
    const handlers = source.split(/async handler\(args\)/)
    for (const block of handlers.slice(1)) {
      if (block.includes("${userId}")) {
        expect(block).toContain("requireUserId")
      }
    }
  })

  test("platform-agents.ts: every handler with userId URL calls requireUserId", () => {
    const source = readSource("platform-agents.ts")
    const handlers = source.split(/async handler\(args\)/)
    for (const block of handlers.slice(1)) {
      if (block.includes("${userId}")) {
        expect(block).toContain("requireUserId")
      }
    }
  })

  test("platform-bloqs.ts: every handler with userId URL calls requireUserId", () => {
    const source = readSource("platform-bloqs.ts")
    const handlers = source.split(/async handler\(args\)/)
    for (const block of handlers.slice(1)) {
      if (block.includes("${userId}")) {
        expect(block).toContain("requireUserId")
      }
    }
  })
})

// ============================================================================
// Endpoint URL contracts — verify correct API paths for each resource
// ============================================================================
// These tests lock down the exact URL patterns each command must use.
// They prevent regressions like:
// - /api/v1/users/ vs /api/v1/user/ (singular vs plural)
// - /history vs /executions
// - Missing /bloqs/ prefix in nested routes
// - Params constructed but not appended to URL

describe("endpoint URL contracts: workflows", () => {
  test("workflows list: /api/v1/users/{userId}/bloqs/workflows", () => {
    const source = readSource("platform-workflows.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/workflows")
  })

  test("workflows run: /api/v1/workflows/{id}/execute/v6", () => {
    const source = readSource("platform-workflows.ts")
    expect(source).toContain("/api/v1/workflows/${args.id}/execute/v6")
  })

  test("workflows status: /api/v1/users/{userId}/bloqs/workflow-runs/{runId}", () => {
    const source = readSource("platform-workflows.ts")
    // Status command should use the user-scoped path
    expect(source).toContain('/api/v1/users/${userId}/bloqs/workflow-runs/${args["run-id"]}')
  })

  test("workflows runs list: /api/v1/users/{userId}/bloqs/workflow-runs", () => {
    const source = readSource("platform-workflows.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/workflow-runs?${params}")
  })

  test("workflows pollRun: /api/v1/users/{userId}/bloqs/workflow-runs/{runId}", () => {
    const source = readSource("platform-workflows.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/workflow-runs/${runId}")
  })

  test("workflows does NOT use old /api/v1/workflows/runs/ path", () => {
    const source = readSource("platform-workflows.ts")
    // The old pre-fix path that returned 404
    expect(source).not.toMatch(/irisFetch\(`\/api\/v1\/workflows\/runs\//)
  })
})

describe("endpoint URL contracts: schedules", () => {
  test("schedules list: /api/v1/users/{userId}/bloqs/scheduled-jobs", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/scheduled-jobs?${params}")
  })

  test("schedules get: /api/v1/users/{userId}/bloqs/scheduled-jobs/{id}", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}")
  })

  test("schedules run: /api/v1/users/{userId}/bloqs/scheduled-jobs/{id}/run", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}/run")
  })

  test("schedules history: uses /executions not /history", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).toContain("/bloqs/scheduled-jobs/${args.id}/executions")
    expect(source).not.toContain("/bloqs/scheduled-jobs/${args.id}/history")
  })

  test("schedules toggle: uses PUT method with is_active payload", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).toContain('method: "PUT"')
    expect(source).toContain("is_active:")
  })

  test("schedules does NOT use old /api/v1/schedules/ path", () => {
    const source = readSource("platform-schedules.ts")
    expect(source).not.toMatch(/irisFetch\(`\/api\/v1\/schedules\//)
  })
})

describe("endpoint URL contracts: bloqs", () => {
  test("bloqs list: uses /api/v1/user/{userId}/bloqs (SINGULAR user)", () => {
    const source = readSource("platform-bloqs.ts")
    expect(source).toContain("/api/v1/user/${userId}/bloqs")
  })

  test("bloqs list: appends query params to URL", () => {
    const source = readSource("platform-bloqs.ts")
    // The params must actually be used in the URL, not just constructed
    expect(source).toMatch(/irisFetch\(`\/api\/v1\/user\/\$\{userId\}\/bloqs\?\$\{params\}`/)
  })

  test("bloqs get: uses /api/v1/users/{userId}/bloqs/{id} (PLURAL users)", () => {
    const source = readSource("platform-bloqs.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/${args.id}")
  })

  test("bloqs lists: uses /api/v1/users/{userId}/bloqs/{id}/lists", () => {
    const source = readSource("platform-bloqs.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/${args.id}/lists")
  })

  test("bloqs create: uses POST /api/v1/users/{userId}/bloqs", () => {
    const source = readSource("platform-bloqs.ts")
    expect(source).toMatch(/irisFetch\(`\/api\/v1\/users\/\$\{userId\}\/bloqs`/)
  })

  test("bloqs ingest: uses POST with /files suffix", () => {
    const source = readSource("platform-bloqs.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/${args.id}/files")
  })
})

describe("endpoint URL contracts: agents", () => {
  test("agents list: /api/v1/users/{userId}/bloqs/agents", () => {
    const source = readSource("platform-agents.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/agents")
  })

  test("agents get: /api/v1/users/{userId}/bloqs/agents/{id}", () => {
    const source = readSource("platform-agents.ts")
    expect(source).toContain("/api/v1/users/${userId}/bloqs/agents/${args.id}")
  })

  test("agents create: POST /api/v1/users/{userId}/bloqs/agents", () => {
    const source = readSource("platform-agents.ts")
    expect(source).toMatch(/irisFetch\(`\/api\/v1\/users\/\$\{userId\}\/bloqs\/agents`/)
  })

  test("agents chat: uses /api/chat/start", () => {
    const source = readSource("platform-agents.ts")
    expect(source).toContain("/api/chat/start")
  })
})

describe("endpoint URL contracts: leads", () => {
  test("leads list: /api/v1/leads (no userId in path)", () => {
    const source = readSource("platform-leads.ts")
    expect(source).toMatch(/irisFetch\(`\/api\/v1\/leads\?/)
  })

  test("leads get: /api/v1/leads/{id}", () => {
    const source = readSource("platform-leads.ts")
    expect(source).toContain("/api/v1/leads/${args.id}")
  })

  test("leads note: POST /api/v1/leads/{id}/notes", () => {
    const source = readSource("platform-leads.ts")
    expect(source).toContain("/api/v1/leads/${args.id}/notes")
  })

  test("leads create: POST /api/v1/leads", () => {
    const source = readSource("platform-leads.ts")
    expect(source).toMatch(/irisFetch\("\/api\/v1\/leads"/)
  })
})

describe("endpoint URL contracts: chat", () => {
  test("chat start: /api/chat/start", () => {
    const source = readSource("platform-chat.ts")
    expect(source).toContain("/api/chat/start")
  })

  test("chat poll: /api/workflows/{workflowId}", () => {
    const source = readSource("platform-chat.ts")
    expect(source).toContain("/api/workflows/${workflowId}")
  })
})

// ============================================================================
// Default model safety — agents create must default to nano model
// ============================================================================

describe("model safety", () => {
  test("agents create defaults to gpt-4.1-nano, not gpt-3.5-turbo", () => {
    const source = readSource("platform-agents.ts")
    expect(source).toContain('gpt-4.1-nano')
    expect(source).not.toContain("gpt-3.5-turbo")
    expect(source).not.toContain("gpt-3.5")
  })
})
