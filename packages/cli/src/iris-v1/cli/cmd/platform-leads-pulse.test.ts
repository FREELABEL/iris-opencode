import { describe, test, expect } from "bun:test"

// =============================================================================
// Multi-Email Resolution Tests
// =============================================================================

/**
 * Extracts all known emails from a lead object — mirrors the logic in pulse command.
 * Primary email + contact_info.nurture_email + contact_info.emails[]
 */
function resolveAllEmails(lead: {
  email?: string
  contact_info?: {
    nurture_email?: string
    emails?: string[]
    email?: string
  }
}): string[] {
  const allEmails: string[] = []
  const email = lead.email ?? ""
  if (email) allEmails.push(email.toLowerCase())
  const ci = lead.contact_info ?? {}
  if (ci.nurture_email && !allEmails.includes(ci.nurture_email.toLowerCase()))
    allEmails.push(ci.nurture_email.toLowerCase())
  if (Array.isArray(ci.emails)) {
    for (const e of ci.emails) {
      if (e && !allEmails.includes(String(e).toLowerCase()))
        allEmails.push(String(e).toLowerCase())
    }
  }
  return allEmails
}

describe("resolveAllEmails", () => {
  test("single primary email", () => {
    const result = resolveAllEmails({ email: "alex@example.com" })
    expect(result).toEqual(["alex@example.com"])
  })

  test("primary + nurture email", () => {
    const result = resolveAllEmails({
      email: "jon@dentsociety.com",
      contact_info: { nurture_email: "Arango5231@gmail.com" },
    })
    expect(result).toEqual(["jon@dentsociety.com", "arango5231@gmail.com"])
  })

  test("primary + contact_info.emails array", () => {
    const result = resolveAllEmails({
      email: "glrivera@creativegs.co",
      contact_info: { emails: ["arevirlg@gmail.com", "gniice@music.com"] },
    })
    expect(result).toEqual(["glrivera@creativegs.co", "arevirlg@gmail.com", "gniice@music.com"])
  })

  test("primary + nurture + extras — no duplicates", () => {
    const result = resolveAllEmails({
      email: "main@example.com",
      contact_info: {
        nurture_email: "nurture@example.com",
        emails: ["extra@example.com", "main@example.com"], // dupe of primary
      },
    })
    expect(result).toEqual(["main@example.com", "nurture@example.com", "extra@example.com"])
  })

  test("case-insensitive dedup", () => {
    const result = resolveAllEmails({
      email: "Alex@Example.COM",
      contact_info: { emails: ["alex@example.com", "ALEX@EXAMPLE.COM"] },
    })
    expect(result).toEqual(["alex@example.com"])
  })

  test("no email at all", () => {
    const result = resolveAllEmails({})
    expect(result).toEqual([])
  })

  test("empty contact_info.emails array", () => {
    const result = resolveAllEmails({
      email: "test@example.com",
      contact_info: { emails: [] },
    })
    expect(result).toEqual(["test@example.com"])
  })

  test("null/undefined values in emails array are skipped", () => {
    const result = resolveAllEmails({
      email: "test@example.com",
      contact_info: { emails: [null as any, undefined as any, "", "valid@example.com"] },
    })
    expect(result).toEqual(["test@example.com", "valid@example.com"])
  })
})

// =============================================================================
// Gmail Thread Filter Tests (multi-email matching)
// =============================================================================

function filterGmailThreads(
  threads: Array<{ from?: string; subject?: string }>,
  allEmails: string[],
): Array<{ from?: string; subject?: string }> {
  return threads.filter((m) => {
    if (!m.from) return true // keep if no from info
    const fromLower = m.from.toLowerCase()
    return allEmails.some((e) => fromLower.includes(e))
  })
}

describe("filterGmailThreads (multi-email)", () => {
  const threads = [
    { from: "glrivera@creativegs.co", subject: "Project update" },
    { from: "arevirlg@gmail.com", subject: "Invoice attached" },
    { from: "random@spam.com", subject: "You won a prize" },
    { from: "GlRivera@CreativeGs.CO", subject: "Follow up" }, // case mismatch
    { from: undefined, subject: "No sender" }, // no from
  ]

  test("single email only matches primary", () => {
    const result = filterGmailThreads(threads, ["glrivera@creativegs.co"])
    expect(result.length).toBe(3) // 2 matches + 1 no-from
    expect(result.map((t) => t.subject)).toContain("Project update")
    expect(result.map((t) => t.subject)).toContain("Follow up")
    expect(result.map((t) => t.subject)).toContain("No sender")
    expect(result.map((t) => t.subject)).not.toContain("Invoice attached")
  })

  test("multi-email matches both addresses", () => {
    const result = filterGmailThreads(threads, ["glrivera@creativegs.co", "arevirlg@gmail.com"])
    expect(result.length).toBe(4) // 2 primary + 1 alt + 1 no-from
    expect(result.map((t) => t.subject)).toContain("Invoice attached")
  })

  test("no emails matches nothing (except no-from)", () => {
    const result = filterGmailThreads(threads, [])
    expect(result.length).toBe(1) // only the no-from thread
  })

  test("case-insensitive matching", () => {
    const result = filterGmailThreads(threads, ["glrivera@creativegs.co"])
    expect(result.map((t) => t.subject)).toContain("Follow up") // was GlRivera@CreativeGs.CO
  })
})

// =============================================================================
// Timeout Wrapper Tests
// =============================================================================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ])
}

describe("withTimeout", () => {
  test("resolves fast promise normally", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test")
    expect(result).toBe("ok")
  })

  test("rejects slow promise with timeout error", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 5000))
    try {
      await withTimeout(slow, 50, "SlowChannel")
      throw new Error("should not reach")
    } catch (e: any) {
      expect(e.message).toBe("SlowChannel timed out after 0.05s")
    }
  })

  test("propagates original error if it rejects before timeout", async () => {
    const failing = Promise.reject(new Error("API 500"))
    try {
      await withTimeout(failing, 5000, "test")
      throw new Error("should not reach")
    } catch (e: any) {
      expect(e.message).toBe("API 500")
    }
  })
})

// =============================================================================
// Calendar Event Filter Tests (multi-email)
// =============================================================================

function filterCalendarEvents(
  events: Array<{ summary?: string; description?: string; attendees?: any[] }>,
  emailsToMatch: string[],
  nameL: string,
): Array<{ summary?: string; description?: string; attendees?: any[] }> {
  return events.filter((ev) => {
    const haystack = [ev.summary, ev.description, JSON.stringify(ev.attendees ?? [])]
      .join(" ")
      .toLowerCase()
    if (emailsToMatch.some((e) => haystack.includes(e))) return true
    if (nameL && nameL.length > 2 && haystack.includes(nameL)) return true
    return false
  })
}

describe("filterCalendarEvents (multi-email)", () => {
  const events = [
    { summary: "Call with GNiice", attendees: [{ email: "glrivera@creativegs.co" }] },
    { summary: "Music review", attendees: [{ email: "arevirlg@gmail.com" }] },
    { summary: "Team standup", attendees: [{ email: "internal@company.com" }] },
    { summary: "Lunch with GNiice", description: "Discuss album release" },
  ]

  test("single email misses alt-email events", () => {
    const result = filterCalendarEvents(events, ["glrivera@creativegs.co"], "gniice")
    // Matches: "Call with GNiice" (email), "Music review" (NO - wrong email), "Lunch with GNiice" (name)
    expect(result.length).toBe(2)
    expect(result.map((e) => e.summary)).toContain("Call with GNiice")
    expect(result.map((e) => e.summary)).toContain("Lunch with GNiice")
    expect(result.map((e) => e.summary)).not.toContain("Music review")
  })

  test("multi-email catches all events", () => {
    const result = filterCalendarEvents(
      events,
      ["glrivera@creativegs.co", "arevirlg@gmail.com"],
      "gniice",
    )
    expect(result.length).toBe(3) // both email matches + name match
    expect(result.map((e) => e.summary)).toContain("Music review")
  })

  test("name-only match works when no emails match", () => {
    const result = filterCalendarEvents(events, ["nobody@example.com"], "gniice")
    expect(result.length).toBe(2) // "Call with GNiice" + "Lunch with GNiice" via name
  })
})

// =============================================================================
// Bridge Attachment Parser Tests
// =============================================================================

function parseAttachmentField(raw: string): Array<{
  name: string
  mime_type: string
  size: number
  saved_path?: string
  save_error?: string
}> {
  if (!raw) return []
  return raw
    .split(";;;")
    .filter((a) => a)
    .map((a) => {
      const [name, mime, size, savedPath] = a.split("|")
      const att: any = {
        name: name || "",
        mime_type: mime || "",
        size: parseInt(size || "0", 10),
      }
      if (savedPath && !savedPath.startsWith("SAVE_ERROR")) att.saved_path = savedPath
      if (savedPath && savedPath.startsWith("SAVE_ERROR")) att.save_error = savedPath
      return att
    })
}

describe("parseAttachmentField", () => {
  test("empty string returns empty array", () => {
    expect(parseAttachmentField("")).toEqual([])
  })

  test("single attachment without save path", () => {
    const result = parseAttachmentField("report.pdf|application/pdf|102400")
    expect(result).toEqual([
      { name: "report.pdf", mime_type: "application/pdf", size: 102400 },
    ])
  })

  test("single attachment with save path", () => {
    const result = parseAttachmentField(
      "report.pdf|application/pdf|102400|/tmp/iris-mail-attachments/report.pdf",
    )
    expect(result).toEqual([
      {
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 102400,
        saved_path: "/tmp/iris-mail-attachments/report.pdf",
      },
    ])
  })

  test("multiple attachments separated by ;;;", () => {
    const result = parseAttachmentField(
      "article1.docx|application/vnd.openxmlformats|54321;;;article2.pdf|application/pdf|98765",
    )
    expect(result.length).toBe(2)
    expect(result[0].name).toBe("article1.docx")
    expect(result[1].name).toBe("article2.pdf")
  })

  test("save error is captured", () => {
    const result = parseAttachmentField("file.pdf|application/pdf|1000|SAVE_ERROR:permission denied")
    expect(result[0].save_error).toBe("SAVE_ERROR:permission denied")
    expect(result[0].saved_path).toBeUndefined()
  })

  test("handles missing fields gracefully", () => {
    const result = parseAttachmentField("unnamed||0")
    expect(result[0]).toEqual({ name: "unnamed", mime_type: "", size: 0 })
  })
})
