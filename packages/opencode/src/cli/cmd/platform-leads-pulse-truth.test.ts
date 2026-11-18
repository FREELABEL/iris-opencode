import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  countLeadTasks,
  describeDrops,
  emailChannelLabel,
  isTaskDone,
  readCalendarEvents,
  selectPulseLeads,
  shouldFileComms,
} from "./platform-leads-honesty"

// #189155 — the places `iris pulse` / `iris leads pulse` read wrong, measured 2026-10-12.

describe("leads pulse is a read", () => {
  test("filing comms is opt-in: only --save writes", () => {
    expect(shouldFileComms({})).toBe(false)
    expect(shouldFileComms({ save: false })).toBe(false)
    expect(shouldFileComms({ save: "true" })).toBe(false)
    expect(shouldFileComms({ save: true })).toBe(true)
  })
  test("the ingest loop in the pulse command is gated on --save", () => {
    const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
    const pulse = src.slice(src.indexOf("const LeadsPulseCommand"), src.indexOf("const LeadsPulseCommand") + 80000)
    const ingest = pulse.indexOf('irisFetch("/api/v1/atlas/comms/ingest"')
    expect(ingest).toBeGreaterThan(0)
    const before = pulse.slice(0, ingest)
    expect(before.lastIndexOf("for (const ch of fileComms ? channels : [])")).toBeGreaterThan(before.lastIndexOf("const fileComms"))
  })
})

describe("channels are named for what they read", () => {
  test("an email log with no received mail is 'Sent by IRIS', not Gmail", () => {
    expect(emailChannelLabel([{ received_count: 0 }, { received_count: "0" }])).toBe("Sent by IRIS")
    expect(emailChannelLabel([])).toBe("Sent by IRIS")
    expect(emailChannelLabel([{ received_count: 0 }, { received_count: 2 }])).toBe("Gmail")
  })
  test("an unread calendar throws 'not measured' instead of returning no meetings", () => {
    expect(readCalendarEvents({ success: true, events: [{ id: 1 }] })).toEqual([{ id: 1 }])
    expect(readCalendarEvents([{ id: 2 }])).toEqual([{ id: 2 }])
    expect(readCalendarEvents({ data: { events: [] } })).toEqual([])
    expect(() => readCalendarEvents({ success: false, error: "Google Calendar not connected" })).toThrow(/not measured/)
    expect(() => readCalendarEvents(null)).toThrow(/not measured/)
    expect(() => readCalendarEvents({ ok: 1 })).toThrow(/not measured/)
  })
})

describe("tasks are counted the way the API writes them", () => {
  const now = new Date("2026-10-12T00:00:00Z")
  test("is_completed marks a task done — pulse-all used to read only status/completed", () => {
    expect(isTaskDone({ is_completed: true })).toBe(true)
    expect(isTaskDone({ is_completed: 1 })).toBe(true)
    expect(isTaskDone({ is_completed: false, due_date: "2026-01-01" })).toBe(false)
    expect(
      countLeadTasks(
        [
          { is_completed: true, due_date: "2026-01-01" }, // done, past due — NOT overdue
          { is_completed: false, due_date: "2026-01-01" },
          { is_completed: false, due_date: "2027-01-01" },
          { is_completed: false },
        ],
        now,
      ),
    ).toEqual({ pending: 3, overdue: 1, completed: 1 })
  })
})

describe("one rule picks the deals a pulse scores", () => {
  const all = [
    { id: 1, email: "a@x.com", full_name: "A" },
    { id: 1, email: "a@x.com", full_name: "A" }, // duplicate (two status fetches)
    { id: 2, full_name: "No contact" },
    { id: 3, email: "c@x.com", name: "Lead #3" }, // placeholder name only
    { id: 4, email: "d@instagram.com", full_name: "Social", status: "Won" },
    { id: 5, email: "e@instagram.com", phone: "1", full_name: "Hand picked", status: "Negotiating" },
    { id: 6, phone: "2", company: "Co" },
  ]
  test("dedupes, needs contact and a name, drops social handles unless hand-picked", () => {
    const { leads, dropped } = selectPulseLeads(all)
    expect(leads.map((l) => l.id)).toEqual([1, 5, 6])
    expect(dropped).toEqual({ duplicate: 1, noContact: 1, noName: 1, social: 1 })
    expect(describeDrops(dropped)).toBe("left out: 1 duplicate, 1 no email/phone, 1 no name, 1 social-handle email")
  })
  test("pulse --admin and pulse-all both call it", () => {
    const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
    expect(src.match(/selectPulseLeads\(/g)?.length).toBe(2)
  })
})
