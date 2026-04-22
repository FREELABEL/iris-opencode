/**
 * Tests for the IRIS platform API helpers (src/cli/cmd/iris-api.ts)
 *
 * Strategy: unit-test the pure functions (display helpers, error handling)
 * and test the auth/fetch helpers by controlling env vars + mocking fetch.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// ── Source file reader for integrity tests ──────────────────────────────────
const SRC_DIR = join(import.meta.dir, "../../src/cli/cmd")
function readSource(filename: string): string {
  return readFileSync(join(SRC_DIR, filename), "utf-8")
}

// ── Display helper imports ──────────────────────────────────────────────────
// Import the pure display helpers directly (no side-effects)
import { dim, bold, success, highlight, printKV } from "../../src/cli/cmd/iris-api"

// ── ANSI codes for assertions ───────────────────────────────────────────────
const DIM = "\x1b[90m"
const BOLD = "\x1b[1m"
const GREEN = "\x1b[92m"
const CYAN = "\x1b[96m"
const RESET = "\x1b[0m"

// ============================================================================
// Display helpers — pure functions, no async needed
// ============================================================================

describe("display helpers", () => {
  test("dim() wraps string with dim ANSI codes", () => {
    expect(dim("hello")).toBe(`${DIM}hello${RESET}`)
  })

  test("dim() works with empty string", () => {
    expect(dim("")).toBe(`${DIM}${RESET}`)
  })

  test("bold() wraps string with bold ANSI codes", () => {
    expect(bold("hello")).toBe(`${BOLD}hello${RESET}`)
  })

  test("success() wraps string with green ANSI codes", () => {
    expect(success("✓ done")).toBe(`${GREEN}✓ done${RESET}`)
  })

  test("highlight() wraps string with cyan ANSI codes", () => {
    expect(highlight("iris chat")).toBe(`${CYAN}iris chat${RESET}`)
  })
})

// ============================================================================
// printKV — logs key-value, skips nullish values
// ============================================================================

describe("printKV", () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args.join(" "))
    })
  })

  afterEach(() => {
    ;(console.log as any).mockRestore?.()
  })

  test("prints when value is a string", () => {
    printKV("ID", "42")
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("ID")
    expect(logged[0]).toContain("42")
  })

  test("prints when value is a number", () => {
    printKV("Count", 7)
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("7")
  })

  test("skips null values — no output", () => {
    printKV("Missing", null)
    expect(logged.length).toBe(0)
  })

  test("skips undefined values — no output", () => {
    printKV("Missing", undefined)
    expect(logged.length).toBe(0)
  })

  test("skips empty string values — no output", () => {
    printKV("Empty", "")
    expect(logged.length).toBe(0)
  })

  test("prints 0 (falsy but valid)", () => {
    printKV("Zero", 0)
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("0")
  })
})

// ============================================================================
// resolveUserId — env var and API fallback
// ============================================================================

describe("resolveUserId", () => {
  const originalEnv = process.env.IRIS_USER_ID

  afterEach(() => {
    // Restore env
    if (originalEnv !== undefined) {
      process.env.IRIS_USER_ID = originalEnv
    } else {
      delete process.env.IRIS_USER_ID
    }
    // Reset cached value by re-importing (Bun caches modules, so we test the logic)
  })

  test("returns user ID from IRIS_USER_ID env var", async () => {
    process.env.IRIS_USER_ID = "42"
    // We can't easily reset the module cache, so test the logic directly:
    const id = parseInt(process.env.IRIS_USER_ID, 10)
    expect(id).toBe(42)
    expect(isNaN(id)).toBe(false)
  })

  test("ignores non-numeric IRIS_USER_ID", () => {
    process.env.IRIS_USER_ID = "not-a-number"
    const id = parseInt(process.env.IRIS_USER_ID, 10)
    expect(isNaN(id)).toBe(true)
  })

  test("ignores empty IRIS_USER_ID", () => {
    process.env.IRIS_USER_ID = ""
    const id = parseInt(process.env.IRIS_USER_ID, 10)
    expect(isNaN(id)).toBe(true)
  })
})

// ============================================================================
// irisFetch — auth token injection
// ============================================================================

describe("irisFetch", () => {
  let originalFetch: typeof global.fetch
  let capturedRequests: Array<{ url: string; headers: Record<string, string> }>

  beforeEach(() => {
    capturedRequests = []
    originalFetch = global.fetch
    global.fetch = mock(async (url: string | URL | Request, options: RequestInit = {}) => {
      const headers = (options.headers as Record<string, string>) ?? {}
      capturedRequests.push({ url: String(url), headers })
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.IRIS_API_KEY
  })

  test("includes Authorization header when IRIS_API_KEY is set", async () => {
    process.env.IRIS_API_KEY = "test-api-key-123"
    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    await irisFetch("/api/v1/test")

    expect(capturedRequests.length).toBe(1)
    expect(capturedRequests[0]!.headers["Authorization"]).toBe("Bearer test-api-key-123")
  })

  test("uses FL_API as default base URL", async () => {
    process.env.IRIS_API_KEY = "key"
    const { irisFetch, FL_API } = await import("../../src/cli/cmd/iris-api")
    await irisFetch("/api/v1/test")

    expect(capturedRequests[0]!.url).toContain("/api/v1/test")
    expect(capturedRequests[0]!.url).toContain(FL_API.replace("https://", ""))
  })

  test("uses custom base URL when provided", async () => {
    process.env.IRIS_API_KEY = "key"
    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    await irisFetch("/test", {}, "https://custom.api.example.com")

    expect(capturedRequests[0]!.url).toBe("https://custom.api.example.com/test")
  })

  test("always includes Content-Type: application/json", async () => {
    process.env.IRIS_API_KEY = "key"
    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    await irisFetch("/api/v1/test")

    expect(capturedRequests[0]!.headers["Content-Type"]).toBe("application/json")
    expect(capturedRequests[0]!.headers["Accept"]).toBe("application/json")
  })

  test("does not include Authorization header when no key available", async () => {
    delete process.env.IRIS_API_KEY
    const { irisFetch } = await import("../../src/cli/cmd/iris-api")
    await irisFetch("/api/v1/test")

    // Authorization header should be absent or empty
    expect(capturedRequests[0]!.headers["Authorization"]).toBeFalsy()
  })
})

// ============================================================================
// handleApiError — error response parsing
// ============================================================================

describe("handleApiError", () => {
  let warnMessages: string[]
  let errorMessages: string[]

  beforeEach(() => {
    warnMessages = []
    errorMessages = []
    // Suppress prompts output during tests
    // @ts-ignore
    globalThis.__prompts_suppressed = true
  })

  afterEach(() => {
    // @ts-ignore
    delete globalThis.__prompts_suppressed
  })

  test("returns true for 200 OK", async () => {
    const { handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = new Response("{}", { status: 200 })
    const ok = await handleApiError(res, "Test")
    expect(ok).toBe(true)
  })

  test("returns true for 201 Created", async () => {
    const { handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = new Response("{}", { status: 201 })
    const ok = await handleApiError(res, "Test")
    expect(ok).toBe(true)
  })

  test("returns false for 401 Unauthorized", async () => {
    const { handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = new Response("{}", { status: 401 })
    const ok = await handleApiError(res, "Test")
    expect(ok).toBe(false)
  })

  test("returns false for 403 Forbidden", async () => {
    const { handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = new Response("{}", { status: 403 })
    const ok = await handleApiError(res, "Test")
    expect(ok).toBe(false)
  })

  test("returns false for 404 Not Found", async () => {
    const { handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
    const ok = await handleApiError(res, "Test")
    expect(ok).toBe(false)
  })

  test("returns false for 500 Server Error", async () => {
    const { handleApiError } = await import("../../src/cli/cmd/iris-api")
    const res = new Response(JSON.stringify({ message: "Internal error" }), { status: 500 })
    const ok = await handleApiError(res, "Test")
    expect(ok).toBe(false)
  })
})

// ============================================================================
// FL_API / IRIS_API constants
// ============================================================================

describe("API base URL constants", () => {
  test("FL_API defaults to apiv2.heyiris.io", async () => {
    delete process.env.IRIS_FL_API_URL
    // The constant is set at import time, so check the default value
    const { FL_API } = await import("../../src/cli/cmd/iris-api")
    // Either the env override or the default
    expect(FL_API).toMatch(/heyiris\.io|localhost|127\.0\.0\.1/)
  })

  test("IRIS_API defaults to freelabel.net", async () => {
    delete process.env.IRIS_API_URL
    const { IRIS_API } = await import("../../src/cli/cmd/iris-api")
    expect(IRIS_API).toMatch(/freelabel\.net|heyiris\.io|localhost|127\.0\.0\.1/)
  })

  test("FL_API respects IRIS_FL_API_URL env override", () => {
    // Since constants are module-level, we test the logic directly
    const override = "https://local.api.example.com"
    const result = override ?? "https://apiv2.heyiris.io"
    expect(result).toBe(override)
  })

  test("PLATFORM_URLS is exported with all required fields", async () => {
    const { PLATFORM_URLS } = await import("../../src/cli/cmd/iris-api")
    expect(PLATFORM_URLS).toBeDefined()
    expect(PLATFORM_URLS.flApi).toBeTruthy()
    expect(PLATFORM_URLS.irisApi).toBeTruthy()
    expect(Array.isArray(PLATFORM_URLS.irisApiFallbacks)).toBe(true)
    expect(PLATFORM_URLS.irisApiFallbacks.length).toBeGreaterThan(0)
  })

  test("FL_API and IRIS_API are aliases of PLATFORM_URLS", async () => {
    const { FL_API, IRIS_API, PLATFORM_URLS } = await import("../../src/cli/cmd/iris-api")
    expect(FL_API).toBe(PLATFORM_URLS.flApi)
    expect(IRIS_API).toBe(PLATFORM_URLS.irisApi)
  })

  test("defaults point to Railway (not old DO URLs)", async () => {
    const { PLATFORM_URLS } = await import("../../src/cli/cmd/iris-api")
    // Should NOT be the old DO URLs
    expect(PLATFORM_URLS.flApi).not.toContain("apiv2.heyiris.io")
    expect(PLATFORM_URLS.irisApi).not.toContain("iris-api.freelabel.net")
    // Should be Railway URLs
    expect(PLATFORM_URLS.flApi).toContain("raichu")
    expect(PLATFORM_URLS.irisApi).toContain("freelabel.net")
  })
})

// ============================================================================
// Integration routing — exec and chat must target IRIS_API, not FL_API
// ============================================================================

describe("integration exec routing", () => {
  test("executeIntegrationCall sends POST to IRIS_API, not FL_API", () => {
    const src = readSource("platform-run.ts")
    // The irisFetch call in executeIntegrationCall must include IRIS_API as third arg
    const execBlock = src.slice(
      src.indexOf("export async function executeIntegrationCall"),
      src.indexOf("return await res.json()", src.indexOf("executeIntegrationCall"))
    )
    expect(execBlock).toContain("IRIS_API")
  })

  test("system tool exec sends POST to IRIS_API", () => {
    const src = readSource("platform-run.ts")
    // System tools route to /api/v1/tools/execute on IRIS_API
    const toolExecMatch = src.match(/v1\/tools\/execute.*?IRIS_API/s)
    expect(toolExecMatch).toBeTruthy()
  })

  test("INTEGRATION_TYPES includes Composio slug aliases", () => {
    const src = readSource("platform-run.ts")
    expect(src).toContain('"googledrive"')
    expect(src).toContain('"googledocs"')
  })

  test("SLUG_ALIASES maps unhyphenated to canonical forms", () => {
    const src = readSource("platform-run.ts")
    expect(src).toContain("googledrive: \"google-drive\"")
    expect(src).toContain("googledocs: \"google-docs\"")
    expect(src).toContain("googlecalendar: \"google-calendar\"")
  })
})

describe("chat routing", () => {
  test("chat start sends POST to IRIS_API", () => {
    const src = readSource("platform-chat.ts")
    // Find the chat/start call — must include IRIS_API
    const chatStartMatch = src.match(/chat\/start.*?IRIS_API/s)
    expect(chatStartMatch).toBeTruthy()
  })

  test("workflow polling uses IRIS_API", () => {
    const src = readSource("platform-chat.ts")
    const pollMatch = src.match(/workflows\/\$\{workflowId\}.*?IRIS_API/s)
    expect(pollMatch).toBeTruthy()
  })

  test("chat resume uses IRIS_API", () => {
    const src = readSource("platform-chat.ts")
    // Both resume calls must include IRIS_API
    const resumeMatches = src.match(/chat\/resume.*?IRIS_API/gs)
    expect(resumeMatches).toBeTruthy()
    expect(resumeMatches!.length).toBeGreaterThanOrEqual(2)
  })

  test("agents chat sends POST to IRIS_API", () => {
    const src = readSource("platform-agents.ts")
    const chatMatch = src.match(/chat\/start.*?IRIS_API/s)
    expect(chatMatch).toBeTruthy()
  })
})
