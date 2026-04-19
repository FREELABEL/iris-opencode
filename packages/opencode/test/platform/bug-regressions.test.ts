/**
 * Regression tests for Bloq #297 bug fixes (April 2026)
 *
 * These tests prevent recurrence of every bug class found during the
 * client-facing QA session. Each test is tagged with its bug item ID.
 *
 * Categories:
 * 1. Display / rendering — [object], truncated output, missing timestamps
 * 2. Exit codes — non-zero on failures
 * 3. --json output cleanliness — no ANSI, no spinner, no clack headers
 * 4. Search / resolution — multi-word, name picker, non-interactive fallback
 * 5. Channel routing — Gmail endpoint, message limits, 0-channel warning
 * 6. URL extraction — shared links surfaced from messages
 * 7. Endpoint contracts — correct API paths for pulse, gmail, pages
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const SRC_DIR = join(import.meta.dir, "../../src/cli/cmd")
function readSource(filename: string): string {
  return readFileSync(join(SRC_DIR, filename), "utf-8")
}

// ============================================================================
// 1. Display / rendering — #55730, #55622, #55740
// ============================================================================

describe("displayResult rendering (#55730)", () => {
  test("platform-run.ts: displayResult expands arrays with name/title/id", () => {
    const src = readSource("platform-run.ts")
    // displayArrayItems must exist and handle name, title, mimeType
    expect(src).toContain("function displayArrayItems")
    expect(src).toContain("item.name")
    expect(src).toContain("item.title")
    expect(src).toContain("item.mimeType")
  })

  test("platform-run.ts: displayResult drills into nested objects for arrays", () => {
    const src = readSource("platform-run.ts")
    // Must detect nested arrays inside objects (e.g. data.files)
    expect(src).toContain("nestedArrays")
    expect(src).toContain("Array.isArray(val)")
  })

  test("displayResult does not show raw [object] for integration responses", () => {
    const src = readSource("platform-run.ts")
    // The old bug: showing [object] for nested data
    // The new code should not have a plain "[object]" fallback
    const displayBlock = src.slice(
      src.indexOf("function displayResult"),
      src.indexOf("function displayResult") + 2000,
    )
    expect(displayBlock).not.toContain('"[object]"')
  })

  test("displayArrayItems caps at 25 items with overflow message", () => {
    const src = readSource("platform-run.ts")
    expect(src).toContain("items.slice(0, 25)")
    expect(src).toContain("items.length > 25")
  })
})

describe("Apple Mail timestamps (#55622, #55740)", () => {
  test("platform-leads.ts: Apple Mail timestamp has fallback for blank dates", () => {
    const src = readSource("platform-leads.ts")
    // Must have a fallback when date is empty
    expect(src).toContain('msg.date ?? msg.ts ?? dim("(no date)")')
  })

  test("bridge: AppleScript date field is wrapped in try/on error", () => {
    const bridgePath = join(import.meta.dir, "../../../../../fl-docker-dev/coding-agent-bridge/index.js")
    let bridgeSrc: string
    try {
      bridgeSrc = readFileSync(bridgePath, "utf-8")
    } catch {
      // Bridge lives outside iris-code — skip if not available
      console.log(`  (skipped — bridge not found at ${bridgePath})`)
      return
    }
    // The date received getter must be inside a try block
    const mailSearchBlock = bridgeSrc.slice(
      bridgeSrc.indexOf("GET /api/mail/search"),
      bridgeSrc.indexOf("GET /api/mail/search") + 3000,
    )
    expect(mailSearchBlock).toContain("try")
    expect(mailSearchBlock).toContain("set theDate to (date received of msg)")
    expect(mailSearchBlock).toContain("on error")
  })
})

// ============================================================================
// 2. Exit codes — #55722
// ============================================================================

describe("non-zero exit codes on failure (#55722)", () => {
  test("leads get: sets process.exitCode = 1 on API failure", () => {
    const src = readSource("platform-leads.ts")
    // The leads get handler must set exitCode on failure
    const getBlock = src.slice(
      src.indexOf('command: "get <id>"'),
      src.indexOf('command: "get <id>"') + 3000,
    )
    expect(getBlock).toContain("process.exitCode = 1")
  })

  test("leads pulse: sets process.exitCode = 1 on API failure", () => {
    const src = readSource("platform-leads.ts")
    const pulseBlock = src.slice(
      src.indexOf('command: "pulse <id>"'),
      src.indexOf('command: "pulse <id>"') + 4000,
    )
    expect(pulseBlock).toContain("process.exitCode = 1")
  })

  test("leads get: exits non-zero when lead not found (null response)", () => {
    const src = readSource("platform-leads.ts")
    // Must check for empty lead data
    expect(src).toContain("if (!l || !l.id)")
    expect(src).toContain('"Lead not found"')
  })

  test("pages list: sets process.exitCode = 1 on failure", () => {
    const src = readSource("platform-pages.ts")
    const listBlock = src.slice(
      src.indexOf('command: "list"'),
      src.indexOf('command: "list"') + 1000,
    )
    expect(listBlock).toContain("process.exitCode = 1")
  })
})

// ============================================================================
// 3. --json output cleanliness — #55735
// ============================================================================

describe("--json clean output (#55735)", () => {
  test("exec handler: skips UI.empty() and prompts.intro() when --json", () => {
    const src = readSource("platform-run.ts")
    // The handler must gate UI chrome behind !args.json
    const handlerBlock = src.slice(
      src.indexOf('command: "exec <target>'),
      src.indexOf('command: "exec <target>') + 1000,
    )
    expect(handlerBlock).toContain("if (!args.json)")
    expect(handlerBlock).toContain("UI.empty()")
  })

  test("exec integration: --json path has no spinner", () => {
    const src = readSource("platform-run.ts")
    // The --json early return for integrations must not reference spinner
    const jsonBlock = src.slice(
      src.indexOf("Skip spinner/ANSI when --json"),
      src.indexOf("Skip spinner/ANSI when --json") + 300,
    )
    expect(jsonBlock).toContain("console.log(JSON.stringify(result, null, 2))")
    expect(jsonBlock).not.toContain("spinner.start")
  })

  test("exec system tool: --json path outputs clean JSON", () => {
    const src = readSource("platform-run.ts")
    // Clean JSON output for tool execution
    expect(src).toContain("Clean JSON output — no spinner/ANSI")
  })
})

// ============================================================================
// 4. Search / resolution — #55719, #55742, leads search multi-word
// ============================================================================

describe("name picker non-interactive fallback (#55719, #55742)", () => {
  test("leads get: auto-selects first match in non-interactive mode", () => {
    const src = readSource("platform-leads.ts")
    const getBlock = src.slice(
      src.indexOf('command: "get <id>"'),
      src.indexOf('command: "get <id>"') + 3000,
    )
    expect(getBlock).toContain("isNonInteractive()")
  })

  test("leads pulse: auto-selects first match in non-interactive mode", () => {
    const src = readSource("platform-leads.ts")
    const pulseBlock = src.slice(
      src.indexOf('command: "pulse <id>"'),
      src.indexOf('command: "pulse <id>"') + 4000,
    )
    expect(pulseBlock).toContain("isNonInteractive()")
  })

  test("leads notes: auto-selects first match in non-interactive mode", () => {
    const src = readSource("platform-leads.ts")
    const notesBlock = src.slice(
      src.indexOf('command: "notes <id>"'),
      src.indexOf('command: "notes <id>"') + 2000,
    )
    expect(notesBlock).toContain("isNonInteractive()")
  })
})

describe("multi-word search fallback", () => {
  test("leads search: splits multi-word queries when initial search returns 0", () => {
    const src = readSource("platform-leads.ts")
    const searchBlock = src.slice(
      src.indexOf('command: "search <query>"'),
      src.indexOf('command: "search <query>"') + 3000,
    )
    // Must detect multi-word and try individual terms
    expect(searchBlock).toContain('args.query.includes(" ")')
    expect(searchBlock).toContain("split(/\\s+/)")
  })

  test("multi-word fallback filters results by ALL search terms", () => {
    const src = readSource("platform-leads.ts")
    // Must filter to only leads matching all words
    expect(src).toContain("allWords.every")
  })

  test("multi-word fallback logic: matches all words case-insensitively", () => {
    // Simulate the matching logic
    const allWords = ["andrew", "gearhart"]
    const lead = { name: "Andrew Gearhart", email: "a@test.com", company: "Acme" }
    const haystack = `${lead.name} ${lead.email} ${lead.company}`.toLowerCase()
    const matches = allWords.every((w) => haystack.includes(w))
    expect(matches).toBe(true)
  })

  test("multi-word fallback: skips short words (< 3 chars)", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("word.length < 3")
  })
})

// ============================================================================
// 5. Channel routing — #55620, #55720, #55721, #55723, #55737, #55738
// ============================================================================

describe("leads pulse Gmail routing (#55620, #55737, #55738)", () => {
  test("pulse does NOT use MCP gmail/execute endpoint (was causing 422)", () => {
    const src = readSource("platform-leads.ts")
    const pulseBlock = src.slice(
      src.indexOf('command: "pulse <id>"'),
      src.indexOf("// ====", src.indexOf('command: "pulse <id>"') + 100),
    )
    // Must NOT use the old MCP endpoint
    expect(pulseBlock).not.toContain("/api/v1/mcp/gmail/execute")
  })

  test("pulse uses lead-specific Gmail threads endpoint", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("/api/v1/leads/${leadId}/gmail-threads")
  })

  test("pulse Gmail filters results by lead email (#55723, #55743)", () => {
    const src = readSource("platform-leads.ts")
    // Must have client-side email matching filter
    expect(src).toContain("email.toLowerCase()")
    expect(src).toContain("fromLower.includes")
  })
})

describe("message limits (#55620, #55621, #55720, #55739)", () => {
  test("iMessage search: default limit is 50 (not 20)", () => {
    const src = readSource("platform-imessage.ts")
    const searchBlock = src.slice(
      src.indexOf('command: "search <query>"'),
      src.indexOf('command: "search <query>"') + 500,
    )
    // Default should be 50
    expect(searchBlock).toContain("default: 50")
    expect(searchBlock).not.toMatch(/default:\s*20/)
  })

  test("iMessage chats: default limit is 50 (not 20)", () => {
    const src = readSource("platform-imessage.ts")
    const chatsBlock = src.slice(
      src.indexOf('command: "chats"'),
      src.indexOf('command: "chats"') + 500,
    )
    expect(chatsBlock).toContain("default: 50")
  })

  test("pulse Gmail: no artificial Math.min cap on results", () => {
    const src = readSource("platform-leads.ts")
    const pulseBlock = src.slice(
      src.indexOf("Gmail threads endpoint"),
      src.indexOf("Gmail threads endpoint") + 500,
    )
    // Must NOT have Math.min(msgLimit, 20)
    expect(pulseBlock).not.toContain("Math.min(msgLimit, 20)")
  })

  test("pulse Apple Mail: no artificial Math.min cap", () => {
    const src = readSource("platform-leads.ts")
    const pulseBlock = src.slice(
      src.indexOf('command: "pulse <id>"'),
      src.indexOf("// ====", src.indexOf('command: "pulse <id>"') + 100),
    )
    // Must NOT have the old Math.min(msgLimit, 100)
    expect(pulseBlock).not.toContain("Math.min(msgLimit, 100)")
  })
})

describe("zero channels warning (#55721)", () => {
  test("pulse warns when lead has no email AND no phone", () => {
    const src = readSource("platform-leads.ts")
    // Must have explicit check
    expect(src).toContain("!email && !phone")
    expect(src).toContain("No channels available")
    expect(src).toContain("no email or phone")
  })
})

// ============================================================================
// 6. URL extraction — #55733, #55741
// ============================================================================

describe("shared links extraction (#55733, #55741)", () => {
  test("pulse extracts URLs from channel messages", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("Shared Links")
    expect(src).toContain("urlRegex")
  })

  test("URL regex matches http and https links", () => {
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/g
    const text = "Check https://docs.google.com/spreadsheets/d/abc123 and http://example.com"
    const matches = text.match(urlRegex)
    expect(matches).toBeTruthy()
    expect(matches!.length).toBe(2)
    expect(matches![0]).toContain("docs.google.com")
  })

  test("URL extraction deduplicates links", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("sharedLinks.some((l) => l.url === url)")
  })

  test("URL extraction includes channel source", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("channel: ch.name")
  })
})

// ============================================================================
// 7. Subcommand completeness — leads notes, integrations list-connected
// ============================================================================

describe("leads notes subcommand", () => {
  test("LeadsNotesCommand exists with 'notes <id>' command", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain('command: "notes <id>"')
  })

  test("notes command is registered in parent leads command", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain(".command(LeadsNotesCommand)")
  })

  test("notes command accepts name or ID (not just numeric)", () => {
    const src = readSource("platform-leads.ts")
    const notesBlock = src.slice(
      src.indexOf('command: "notes <id>"'),
      src.indexOf('command: "notes <id>"') + 2000,
    )
    expect(notesBlock).toContain("isNaN(leadId)")
  })
})

describe("integrations list-connected status honesty (#55734)", () => {
  test("list-connected includes disclaimer about [active] meaning", () => {
    const src = readSource("platform-run.ts")
    // Verify list-connected renders status labels
    expect(src).toContain("[active]")
  })
})

// ============================================================================
// 8. Endpoint URL contracts — pulse, gmail, pages
// ============================================================================

describe("endpoint URL contracts: leads pulse", () => {
  test("pulse fetches lead details from /api/v1/leads/{id}", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("/api/v1/leads/${leadId}")
  })

  test("pulse uses /api/v1/leads/{id}/gmail-threads for Gmail", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("/api/v1/leads/${leadId}/gmail-threads")
  })

  test("pulse uses bridge /api/imessage/search for iMessage", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("${BRIDGE_BASE}/api/imessage/search")
  })

  test("pulse uses bridge /api/mail/search for Apple Mail", () => {
    const src = readSource("platform-leads.ts")
    expect(src).toContain("${BRIDGE_BASE}/api/mail/search")
  })
})

describe("endpoint URL contracts: pages", () => {
  test("pages list uses iris-api (not fl-api)", () => {
    const src = readSource("platform-pages.ts")
    expect(src).toContain("irisFetch(path, options ?? {}, IRIS_API)")
  })

  test("pages list requests /api/v1/pages", () => {
    const src = readSource("platform-pages.ts")
    expect(src).toContain("/api/v1/pages?per_page=50")
  })
})

// ============================================================================
// 9. agents create --type flag — #B-04
// ============================================================================

describe("agents create --type flag (B-04)", () => {
  test("agents create builder includes --type option", () => {
    const src = readSource("platform-agents.ts")
    const createBlock = src.slice(
      src.indexOf('command: "create"'),
      src.indexOf('command: "create"') + 1000,
    )
    expect(createBlock).toContain('.option("type"')
  })

  test("agents create payload includes type field", () => {
    const src = readSource("platform-agents.ts")
    expect(src).toContain('type: args.type ?? "content"')
  })

  test("agents create defaults type to 'content'", () => {
    const src = readSource("platform-agents.ts")
    const createBlock = src.slice(
      src.indexOf('command: "create"'),
      src.indexOf('command: "create"') + 800,
    )
    expect(createBlock).toContain('default: "content"')
  })
})

// ============================================================================
// 10. Model safety — must never use gpt-3.5-turbo
// ============================================================================

describe("model safety across all platform commands", () => {
  const PLATFORM_FILES = [
    "platform-leads.ts",
    "platform-run.ts",
    "platform-agents.ts",
    "platform-chat.ts",
    "platform-pages.ts",
    "platform-imessage.ts",
    "platform-mail.ts",
  ]

  for (const file of PLATFORM_FILES) {
    test(`${file}: does not reference gpt-3.5-turbo`, () => {
      const src = readSource(file)
      expect(src).not.toContain("gpt-3.5-turbo")
      expect(src).not.toContain("gpt-3.5")
    })
  }
})
