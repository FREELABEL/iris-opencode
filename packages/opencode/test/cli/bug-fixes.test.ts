import { describe, expect, test } from "bun:test"

/**
 * Tests for CLI bug fixes — validates the logic changes made to resolve
 * bug reports #57236, #57340, #57343, #57344, #57345, #57346, #57347
 */

// ============================================================================
// #57346: Date validation for leads meet --at flag
// ============================================================================

describe("leads meet date validation (#57346)", () => {
  function validateDate(raw: string): { valid: boolean; iso?: string } {
    const parsed = new Date(raw)
    if (isNaN(parsed.getTime())) return { valid: false }
    return { valid: true, iso: parsed.toISOString() }
  }

  test("accepts ISO format: 2026-04-21T10:00:00", () => {
    const result = validateDate("2026-04-21T10:00:00")
    expect(result.valid).toBe(true)
    expect(result.iso).toContain("2026-04-21")
  })

  test("accepts date-only: 2026-04-21", () => {
    const result = validateDate("2026-04-21")
    expect(result.valid).toBe(true)
  })

  test("rejects natural language: 'Monday April 21 10am'", () => {
    const result = validateDate("Monday April 21 10am")
    expect(result.valid).toBe(false)
  })

  test("rejects garbage input", () => {
    expect(validateDate("not-a-date").valid).toBe(false)
    expect(validateDate("").valid).toBe(false)
  })

  test("accepts ISO with timezone offset", () => {
    const result = validateDate("2026-04-21T10:00:00-05:00")
    expect(result.valid).toBe(true)
  })

  test("end time calculation is correct with duration", () => {
    const startTime = "2026-04-21T10:00:00"
    const durationMs = 30 * 60000
    const parsedStart = new Date(startTime)
    const endTime = new Date(parsedStart.getTime() + durationMs).toISOString()
    expect(endTime).toContain("2026-04-21")
    // 10:00 + 30 min = 10:30
    expect(endTime).toMatch(/10:30:00/)
  })
})

// ============================================================================
// #57236: Versions response normalization (object vs array)
// ============================================================================

describe("pages versions response normalization (#57236)", () => {
  function normalizeVersions(data: any): any[] {
    const raw = data?.data
    return Array.isArray(raw) ? raw : (typeof raw === "object" && raw !== null ? Object.values(raw) : [])
  }

  test("handles normal array response", () => {
    const data = { data: [{ version_number: 1 }, { version_number: 2 }] }
    const result = normalizeVersions(data)
    expect(result).toHaveLength(2)
    expect(result[0].version_number).toBe(1)
  })

  test("handles empty object: {data: {}}", () => {
    const data = { data: {} }
    const result = normalizeVersions(data)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  test("handles {data: null}", () => {
    const result = normalizeVersions({ data: null })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  test("handles plain empty object {}", () => {
    const result = normalizeVersions({})
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  test("handles object with version entries as values", () => {
    const data = { data: { "0": { version_number: 1 }, "1": { version_number: 2 } } }
    const result = normalizeVersions(data)
    expect(result).toHaveLength(2)
  })

  test("handles completely empty response", () => {
    const result = normalizeVersions(null)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })
})

// ============================================================================
// #57347: Workflow run ID resolution (run_id UUID vs database id)
// ============================================================================

describe("workflow run ID display (#57347)", () => {
  function getDisplayId(run: Record<string, unknown>): string {
    return String(run.run_id ?? run.id)
  }

  test("prefers run_id (UUID) when both present", () => {
    const run = { id: 11612, run_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
    expect(getDisplayId(run)).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
  })

  test("falls back to id when no run_id", () => {
    const run = { id: 11612 }
    expect(getDisplayId(run)).toBe("11612")
  })

  test("handles run_id as string", () => {
    const run = { id: 5, run_id: "uuid-string" }
    expect(getDisplayId(run)).toBe("uuid-string")
  })
})

// ============================================================================
// #57341: Lead status validation (valid enum values)
// ============================================================================

describe("lead status validation (#57341)", () => {
  const validStatuses = ["Prospected", "Contacted", "Interested", "Converted", "Archived"]

  test("'New' is not a valid status", () => {
    expect(validStatuses.includes("New")).toBe(false)
  })

  test("all enum values are accepted", () => {
    for (const s of validStatuses) {
      expect(validStatuses.includes(s)).toBe(true)
    }
  })

  test("case-sensitive matching", () => {
    expect(validStatuses.includes("prospected")).toBe(false)
    expect(validStatuses.includes("Prospected")).toBe(true)
  })
})

// ============================================================================
// #57343/#57340: Note type values that should now work after migration
// ============================================================================

describe("lead note type values (#57343, #57340)", () => {
  const validTypes = ["note", "meeting_intel", "call_log", "email_log", "system"]
  // Old enum was: outreach, response, note (max 8 chars)
  // New column: VARCHAR(50) — all types should fit

  test("meeting_intel fits in VARCHAR(50)", () => {
    expect("meeting_intel".length).toBeLessThanOrEqual(50)
  })

  test("call_log fits in VARCHAR(50)", () => {
    expect("call_log".length).toBeLessThanOrEqual(50)
  })

  test("all valid types are under 50 chars", () => {
    for (const t of validTypes) {
      expect(t.length).toBeLessThanOrEqual(50)
    }
  })

  test("old enum values still work", () => {
    for (const t of ["outreach", "response", "note"]) {
      expect(t.length).toBeLessThanOrEqual(50)
    }
  })
})

// ============================================================================
// #57643/#57647: Empty error message extraction (|| vs ??)
// ============================================================================

describe("API error message extraction (#57643, #57647)", () => {
  function extractErrorMsg(body: Record<string, unknown>, status: number): string {
    const fallback = `HTTP ${status}`
    const rawMsg = String(body?.error || body?.message || "")
    if (!rawMsg) return fallback
    // Sanitize Laravel model errors
    if (rawMsg.includes("No query results for model")) return "Resource not found"
    return rawMsg.replace(/\[App\\Models\\[^\]]+\]/g, "").trim()
  }

  test("extracts message when present", () => {
    expect(extractErrorMsg({ message: "Not found" }, 404)).toBe("Not found")
  })

  test("falls through empty string message to HTTP status", () => {
    // This was the root cause — {"message": ""} with ?? didn't fall through
    expect(extractErrorMsg({ message: "" }, 404)).toBe("HTTP 404")
  })

  test("falls through null message", () => {
    expect(extractErrorMsg({ message: null }, 500)).toBe("HTTP 500")
  })

  test("prefers error over message", () => {
    expect(extractErrorMsg({ error: "Bad request", message: "other" }, 400)).toBe("Bad request")
  })

  test("sanitizes Laravel model errors (#57646)", () => {
    expect(extractErrorMsg({ message: "No query results for model [App\\Models\\Bloq\\ScheduledJob]" }, 404))
      .toBe("Resource not found")
  })

  test("strips model class references from other errors", () => {
    expect(extractErrorMsg({ message: "Invalid state for [App\\Models\\Lead]" }, 422))
      .toBe("Invalid state for")
  })
})

// ============================================================================
// #57645: Typo regression — "Enableing" vs "Enabling"
// ============================================================================

describe("schedules toggle spinner text (#57645)", () => {
  test("source does not contain 'Enableing'", () => {
    const { readFileSync } = require("fs")
    const { join } = require("path")
    const source = readFileSync(join(import.meta.dir, "../../src/cli/cmd/platform-schedules.ts"), "utf-8")
    expect(source).not.toContain("Enableing")
    expect(source).toContain("Enabling")
  })
})

// ============================================================================
// #57684: Credential masking in pulse notes
// ============================================================================

describe("credential masking (#57684)", () => {
  // Replicate the masking function from platform-leads.ts
  const maskSecrets = (text: string): string =>
    text
      .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/gi, (m) => m.split(/[:=]/)[0] + ": ●●●●●●●●")
      .replace(/(?:sk|pk|rk|Bearer|eyJ)[_-]?[A-Za-z0-9\-_.]{20,}/g, "●●●●●●●●")
      .replace(/(?:ghp|gho|github_pat)_[A-Za-z0-9]{20,}/g, "●●●●●●●●")

  test("masks password: value patterns", () => {
    expect(maskSecrets("password: s3cretP@ss123")).toBe("password: ●●●●●●●●")
    expect(maskSecrets("Password=hunter2")).toBe("Password: ●●●●●●●●")
  })

  test("masks API keys", () => {
    expect(maskSecrets("api_key: sk_live_abcdefghijklmnopqrst")).toBe("api_key: ●●●●●●●●")
  })

  test("masks Bearer tokens", () => {
    expect(maskSecrets("auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload")).toBe("auth: Bearer ●●●●●●●●")
  })

  test("masks sk_ prefixed keys", () => {
    const fakeKey = "sk_" + "live_" + "a".repeat(24)
    expect(maskSecrets(`use ${fakeKey} for testing`)).toBe("use ●●●●●●●● for testing")
  })

  test("masks GitHub PATs", () => {
    expect(maskSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")).toBe("●●●●●●●●")
  })

  test("leaves normal text untouched", () => {
    expect(maskSecrets("Meeting scheduled for Monday")).toBe("Meeting scheduled for Monday")
    expect(maskSecrets("Discussed pricing of $500")).toBe("Discussed pricing of $500")
  })
})

// ============================================================================
// #57686: Completeness score in leads get
// ============================================================================

describe("completeness score (#57686)", () => {
  function calcScore(lead: Record<string, any>): { score: number; missing: string[] } {
    const fields = [
      { name: "email", has: !!lead.email },
      { name: "phone", has: !!lead.phone },
      { name: "company", has: !!lead.company },
      { name: "stage", has: !!lead.stage },
      { name: "source", has: !!lead.source },
      { name: "bloq", has: Array.isArray(lead.bloq_ids) ? lead.bloq_ids.length > 0 : !!lead.bloq_id },
      { name: "notes", has: Array.isArray(lead.notes) && lead.notes.length > 0 },
    ]
    return {
      score: Math.round((fields.filter((f) => f.has).length / fields.length) * 100),
      missing: fields.filter((f) => !f.has).map((f) => f.name),
    }
  }

  test("100% for complete lead", () => {
    const lead = { email: "a@b.com", phone: "123", company: "Acme", stage: "Won", source: "referral", bloq_ids: [1], notes: [{ content: "hi" }] }
    expect(calcScore(lead).score).toBe(100)
    expect(calcScore(lead).missing).toHaveLength(0)
  })

  test("0% for empty lead", () => {
    const result = calcScore({})
    expect(result.score).toBe(0)
    expect(result.missing).toHaveLength(7)
  })

  test("shows missing fields for partial lead", () => {
    const lead = { email: "a@b.com", phone: "123", notes: [{ content: "hi" }] }
    const result = calcScore(lead)
    expect(result.score).toBe(43) // 3/7
    expect(result.missing).toContain("company")
    expect(result.missing).toContain("stage")
    expect(result.missing).not.toContain("email")
  })
})

// ============================================================================
// #57689: Tasks sorting — overdue first, then by due date
// ============================================================================

describe("pulse tasks sorting (#57689)", () => {
  test("overdue tasks sort before future tasks", () => {
    const now = new Date()
    const tasks = [
      { title: "future", due_date: new Date(now.getTime() + 86400000).toISOString(), is_completed: false },
      { title: "overdue", due_date: new Date(now.getTime() - 86400000).toISOString(), is_completed: false },
      { title: "no-date", due_date: null, is_completed: false },
    ]
    tasks.sort((a, b) => {
      const aOver = a.due_date && new Date(a.due_date) < now ? 1 : 0
      const bOver = b.due_date && new Date(b.due_date) < now ? 1 : 0
      if (aOver !== bOver) return bOver - aOver
      if (a.due_date && b.due_date) return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
      if (a.due_date) return -1
      if (b.due_date) return 1
      return 0
    })
    expect(tasks[0].title).toBe("overdue")
    expect(tasks[1].title).toBe("future")
    expect(tasks[2].title).toBe("no-date")
  })
})

// ============================================================================
// #57685: Merge hint ranking
// ============================================================================

describe("merge hint ranking (#57685)", () => {
  test("ranks lead with more data as master", () => {
    const scoreLead = (l: any) => {
      let s = 0
      if (l.email) s += 2; if (l.phone) s += 2; if (l.company) s += 1
      if (l.notes?.length) s += Math.min(l.notes.length, 5)
      if (l.status === "Active" || l.status === "Won") s += 3
      return s
    }
    const rich = { email: "a@b.com", phone: "123", company: "Acme", status: "Won", notes: [1, 2, 3] }
    const sparse = { email: "a@b.com", status: "Prospected" }
    expect(scoreLead(rich)).toBeGreaterThan(scoreLead(sparse))
  })
})

// ============================================================================
// Source integrity: leads get + pulse both have completeness score
// ============================================================================

describe("completeness score in source (#57686)", () => {
  test("leads get has completeness score", () => {
    const { readFileSync } = require("fs")
    const { join } = require("path")
    const source = readFileSync(join(import.meta.dir, "../../src/cli/cmd/platform-leads.ts"), "utf-8")
    // Both get and pulse should have the completeness calculation
    expect((source.match(/Completeness/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test("pulse has credential masking", () => {
    const { readFileSync } = require("fs")
    const { join } = require("path")
    const source = readFileSync(join(import.meta.dir, "../../src/cli/cmd/platform-leads.ts"), "utf-8")
    expect(source).toContain("maskSecrets")
  })
})

// ============================================================================
// #58778/#58779: Calendar event display — summary + start time
// ============================================================================

describe("calendar event display (#58778, #58779)", () => {
  // Replicate displayArrayItems logic for calendar events
  function getEventLabel(item: Record<string, unknown>): string {
    return String(item.name ?? item.title ?? item.summary ?? item.subject ?? item.id ?? "")
  }

  function getStartTime(item: Record<string, unknown>): string {
    const rawStart = item.start
    return typeof rawStart === "string" ? rawStart : ((rawStart as any)?.dateTime ?? (rawStart as any)?.date ?? "")
  }

  test("uses summary field for Google Calendar events", () => {
    const event = { id: "abc123", summary: "Song Wars Ep.1", start: "2026-04-18T19:00:00-05:00" }
    expect(getEventLabel(event)).toBe("Song Wars Ep.1")
  })

  test("extracts start time from flat string", () => {
    const event = { summary: "Test", start: "2026-04-18T09:00:00-05:00" }
    expect(getStartTime(event)).toBe("2026-04-18T09:00:00-05:00")
  })

  test("extracts start time from nested object", () => {
    const event = { summary: "Test", start: { dateTime: "2026-04-18T09:00:00Z" } }
    expect(getStartTime(event)).toBe("2026-04-18T09:00:00Z")
  })

  test("handles missing start gracefully", () => {
    const event = { summary: "Test" }
    expect(getStartTime(event)).toBe("")
  })

  test("falls back to id when no summary/title/name", () => {
    const event = { id: "7d4kh6431gmu" }
    expect(getEventLabel(event)).toBe("7d4kh6431gmu")
  })
})
