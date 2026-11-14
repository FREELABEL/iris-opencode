import { describe, expect, test } from "bun:test"
import { decideLeadMatch } from "./comms-send"
import {
  addressOf,
  ingestRecap,
  isReadAiSender,
  matchCalendarEvent,
  meetingFromRow,
  parseRecapAttendees,
  recapKey,
  recapTitle,
  type RecapDeps,
  type RecapMessage,
} from "./meetings-recap"

// Every fixture here is invented. The format is an assumption until a real recap is checked.
const RECAP: RecapMessage = {
  id: "gm1",
  from: "Read AI <notes@e.read.ai>",
  subject: "Meeting Report: Platform Kickoff",
  date: "2026-10-30T18:00:00Z",
  mailbox: "owner@host.example.com",
  rfc822_message_id: "<abc@e.read.ai>",
  body_text: [
    "Summary: we agreed the plan. Contact billing@elsewhere.example.com with questions.",
    "",
    "Participants:",
    "- Ana Reyes <ana@client.example.com>",
    "- bo@client.example.com",
    "- Carl Without Address",
    "",
    "Action items: none",
  ].join("\n"),
}

const EVENT = {
  title: "Platform Kickoff",
  start: "2026-10-30T17:00:00Z",
  seenIn: ["x"],
  attendees: [
    { email: "ana@client.example.com" },
    { email: "invitee@client.example.com", name: "Ivy" },
    { email: "owner@host.example.com" },
  ],
}

const LEADS: Record<string, any[]> = {
  "ana@client.example.com": [{ id: 10, email: "ana@client.example.com" }],
  // The search is fuzzy: this row merely mentions bo. It must never be attached.
  "bo@client.example.com": [{ id: 99, email: "bobby@client.example.com", name: "bo@client.example.com" }],
  "invitee@client.example.com": [
    { id: 20, email: "invitee@client.example.com" },
    { id: 21, contact_info: { email: "Invitee@Client.Example.Com" } },
  ],
}

function fake(over: Partial<RecapDeps> = {}) {
  const meetings = new Map<string, Record<string, unknown>>()
  const notes = new Map<number, string[]>()
  const deps: RecapDeps = {
    findEvents: async () => ({ events: [EVENT], complete: true }),
    resolveLead: async (email) => decideLeadMatch(LEADS[email] ?? [], email),
    writeMeeting: async (p) => {
      const k = String(p.external_message_id)
      const created = !meetings.has(k)
      if (created) meetings.set(k, p)
      return { id: 1, created }
    },
    leadNotes: async (id) => notes.get(id) ?? [],
    writeLeadNote: async (id, p) => {
      notes.set(id, [...(notes.get(id) ?? []), String(p.message)])
    },
    ...over,
  }
  return { deps, meetings, notes }
}

describe("sender", () => {
  test("the domain decides, not a substring", () => {
    expect(isReadAiSender("Read AI <notes@e.read.ai>")).toBe(true)
    expect(isReadAiSender("x@read.ai")).toBe(true)
    expect(isReadAiSender("x@thread.ai")).toBe(false)
    expect(isReadAiSender("x@read.ai.example.com")).toBe(false)
    expect(isReadAiSender('"x@read.ai" <mallory@example.com>')).toBe(false)
  })
  test("the address is the last bracket", () => {
    expect(addressOf('"a <b@c.d>" <E@F.g>')).toBe("e@f.g")
  })
})

describe("recapKey", () => {
  test("the Message-ID wins, brackets dropped, so two mailboxes share a key", () => {
    expect(recapKey({ id: "a", mailbox: "x", rfc822_message_id: "<m@1>" })).toBe("rfc822:m@1")
    expect(recapKey({ id: "b", mailbox: "y", rfc822_message_id: "m@1" })).toBe("rfc822:m@1")
  })
  test("a Gmail id is only unique inside its mailbox", () => {
    expect(recapKey({ id: "a", mailbox: "x" })).not.toBe(recapKey({ id: "a", mailbox: "y" }))
    expect(recapKey({ id: "" })).toBeNull()
  })
})

describe("recapTitle", () => {
  test("strips reply prefixes and the recap label", () => {
    expect(recapTitle("Fwd: Re: Meeting Report: Kickoff")).toBe("Kickoff")
    expect(recapTitle("Recap: Kickoff: Phase 2")).toBe("Kickoff: Phase 2")
    expect(recapTitle("Kickoff")).toBe("Kickoff")
  })
})

describe("parseRecapAttendees", () => {
  test("reads the block, keeps a nameless person as a name, ignores addresses elsewhere", () => {
    const r = parseRecapAttendees(RECAP.body_text)
    expect(r.attendees.map((a) => a.email)).toEqual(["ana@client.example.com", "bo@client.example.com"])
    expect(r.attendees[0].name).toBe("Ana Reyes")
    expect(r.names).toEqual(["Carl Without Address"])
  })
  test("an inline list works, and no block means nobody", () => {
    expect(parseRecapAttendees("Attendees: a@x.io, B <b@x.io>").attendees.map((a) => a.email)).toEqual(["a@x.io", "b@x.io"])
    expect(parseRecapAttendees("write to a@x.io").attendees).toEqual([])
  })
})

describe("matchCalendarEvent", () => {
  const at = new Date(RECAP.date)
  test("exact title inside the window", () => {
    expect(matchCalendarEvent({ events: [EVENT], complete: true }, "platform kickoff", at).match).toBe("matched")
  })
  test("a title that only contains it is not it", () => {
    const ev = { ...EVENT, title: "Platform Kickoff Prep" }
    expect(matchCalendarEvent({ events: [ev], complete: true }, "Platform Kickoff", at).match).toBe("none")
  })
  test("last week's run of the same call is not it", () => {
    const ev = { ...EVENT, start: "2026-10-23T17:00:00Z" }
    expect(matchCalendarEvent({ events: [ev], complete: true }, "Platform Kickoff", at).match).toBe("none")
  })
  test("two candidates are refused", () => {
    const ev = { ...EVENT, start: "2026-10-30T09:00:00Z" }
    const r = matchCalendarEvent({ events: [EVENT, ev], complete: true }, "Platform Kickoff", at)
    expect(r.match).toBe("ambiguous")
    expect(r.event).toBeUndefined()
  })
  test("no event from an incomplete search is not reported as none", () => {
    expect(matchCalendarEvent({ events: [], complete: false }, "x", at).match).toBe("unavailable")
  })
})

describe("ingestRecap", () => {
  test("attaches only exact matches and reports the rest", async () => {
    const { deps, notes } = fake()
    const r = (await ingestRecap(RECAP, deps))!
    expect(r.attached.map((a) => a.lead_id)).toEqual([10])
    expect(r.unmatched).toEqual(["bo@client.example.com"])
    expect(r.ambiguous).toEqual([{ email: "invitee@client.example.com", lead_ids: [20, 21] }])
    expect(notes.has(99)).toBe(false)
    expect(notes.has(20)).toBe(false)
    expect(r.names_without_email).toEqual(["Carl Without Address"])
  })

  test("a run twice writes nothing twice", async () => {
    const { deps, meetings, notes } = fake()
    const first = (await ingestRecap(RECAP, deps))!
    const second = (await ingestRecap(RECAP, deps))!
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(meetings.size).toBe(1)
    expect(notes.get(10)).toHaveLength(1)
    expect(second.attached[0].already).toBe(true)
  })

  test("the meeting row can never be guessed onto a lead by the server", async () => {
    const { deps, meetings } = fake()
    await ingestRecap(RECAP, deps)
    const row = [...meetings.values()][0]
    expect(row).not.toHaveProperty("from_identifier")
    expect(row).not.toHaveProperty("lead_id")
    expect((row.metadata as any).sender).toBe("notes@e.read.ai")
  })

  test("the lead's note carries nobody else and nothing that was said", async () => {
    const { deps, notes } = fake()
    await ingestRecap(RECAP, deps)
    const note = notes.get(10)![0]
    expect(note).toContain("Platform Kickoff")
    expect(note).not.toContain("invitee@client.example.com")
    expect(note).not.toContain("we agreed the plan")
  })

  test("recap and invite stay distinguishable, and the row is findable by a person", async () => {
    const { deps, meetings } = fake()
    const r = (await ingestRecap(RECAP, deps))!
    const by = (e: string) => r.attendees.find((a) => a.email === e)!.sources
    expect(by("ana@client.example.com")).toEqual(["recap", "calendar"])
    expect(by("invitee@client.example.com")).toEqual(["calendar"])
    expect(String([...meetings.values()][0].body)).toContain("<invitee@client.example.com> (invited, on the calendar event)")
  })

  test("your own address is an attendee and never a lead match", async () => {
    let asked: string[] = []
    const { deps } = fake({
      resolveLead: async (e) => {
        asked.push(e)
        return decideLeadMatch(LEADS[e] ?? [], e)
      },
    })
    const r = (await ingestRecap(RECAP, deps))!
    expect(r.attendees.map((a) => a.email)).toContain("owner@host.example.com")
    expect(asked).not.toContain("owner@host.example.com")
  })

  test("a failed lookup is a failure, not 'unmatched'", async () => {
    const { deps } = fake({
      resolveLead: async () => ({ ok: false, matches: [], reason: "error", error: "leads API returned 500" }),
    })
    const r = (await ingestRecap(RECAP, deps))!
    expect(r.unmatched).toEqual([])
    expect(r.failed[0].reason).toContain("500")
  })

  test("a failed note retries on the next run", async () => {
    let fail = true
    const { deps, notes } = fake()
    const write = deps.writeLeadNote
    deps.writeLeadNote = async (id, p) => {
      if (fail) throw new Error("HTTP 500")
      await write(id, p)
    }
    const first = (await ingestRecap(RECAP, deps))!
    expect(first.failed).toHaveLength(1)
    expect(first.attached).toEqual([])
    fail = false
    const second = (await ingestRecap(RECAP, deps))!
    expect(second.attached[0].already).toBe(false)
    expect(notes.get(10)).toHaveLength(1)
  })

  test("if the meeting cannot be stored, nothing goes on a lead", async () => {
    const { deps, notes } = fake({
      writeMeeting: async () => {
        throw new Error("HTTP 500")
      },
    })
    await expect(ingestRecap(RECAP, deps)).rejects.toThrow("500")
    expect(notes.size).toBe(0)
  })

  test("a dry run writes nothing", async () => {
    const { deps, meetings, notes } = fake()
    const r = (await ingestRecap(RECAP, deps, { dryRun: true }))!
    expect(r.attached[0].lead_id).toBe(10)
    expect(meetings.size).toBe(0)
    expect(notes.size).toBe(0)
  })

  test("a calendar outage still files the recap's own attendees", async () => {
    const { deps } = fake({
      findEvents: async () => {
        throw new Error("down")
      },
    })
    const r = (await ingestRecap(RECAP, deps))!
    expect(r.calendar).toBe("unavailable")
    expect(r.attendees.map((a) => a.email)).toEqual(["ana@client.example.com", "bo@client.example.com"])
  })
})

describe("meetingFromRow", () => {
  test("reads a stored row and survives one with no metadata", () => {
    const m = meetingFromRow({ id: 5, subject: "T", sent_at: "d", metadata: { attendees: [{ email: "a@x.io", sources: ["recap"] }] } })
    expect(m.attendees[0].email).toBe("a@x.io")
    expect(meetingFromRow({ id: 6 }).attendees).toEqual([])
  })
})
