import { describe, expect, test } from "bun:test"
import { eventKitStatusReason, fromGoogleEvent, isComplete, localSource, matchesQuery, mergeEvents, parseAppleCalendar, uniqueAttendees, type FoundEvent } from "./calendar-search"

// The case that created this command (epic #187374): an invite with six guests, organised by
// Constellation, found nowhere because it went to an unconnected account.
const invite = {
  id: "abc",
  iCalUID: "uid-1@google.com",
  summary: "Kickoff: Gate AI Integration",
  start: { dateTime: "2026-09-30T12:00:00-05:00" },
  end: { dateTime: "2026-09-30T13:00:00-05:00" },
  organizer: { email: "dave@constellationnetwork.io" },
  attendees: [
    { email: "dave@constellationnetwork.io", organizer: true, responseStatus: "accepted" },
    { email: "alex@constellationnetwork.io", responseStatus: "accepted" },
    { email: "amayo@mypathwaysai.com", self: true, responseStatus: "accepted" },
    { email: "junaid@savelife.ai", responseStatus: "accepted" },
    { email: "rdelgado@vanguardhcs.com", responseStatus: "accepted" },
    { email: "dc@m42.com", responseStatus: "needsAction" },
    { email: "c_room@resource.calendar.google.com", resource: true },
  ],
}

describe("fromGoogleEvent", () => {
  test("keeps every human guest with their email, drops rooms, reads object-shaped times", () => {
    const ev = fromGoogleEvent(invite, "x@y · Work")
    expect(ev.attendees.map((a) => a.email)).toEqual([
      "dave@constellationnetwork.io",
      "alex@constellationnetwork.io",
      "amayo@mypathwaysai.com",
      "junaid@savelife.ai",
      "rdelgado@vanguardhcs.com",
      "dc@m42.com",
    ])
    expect(ev.start).toBe("2026-09-30T12:00:00-05:00")
    expect(ev.attendees[0].organizer).toBe(true)
  })

  test("an organizer who is not listed as an attendee is still returned — they sent the invite", () => {
    const ev = fromGoogleEvent({ summary: "x", start: { date: "2026-10-01" }, organizer: { email: "Sender@Co.com" }, attendees: [] }, "s")
    expect(ev.attendees).toEqual([{ email: "sender@co.com", organizer: true }])
  })
})

describe("matchesQuery — the same rule for every source", () => {
  const ev = fromGoogleEvent(invite, "s")
  test("matches title words, case-insensitively, all terms required", () => {
    expect(matchesQuery(ev, "gate kickoff")).toBe(true)
    expect(matchesQuery(ev, "gate dinner")).toBe(false)
  })
  test("matches an attendee's email or domain — 'who was on the call with m42'", () => {
    expect(matchesQuery(ev, "m42.com")).toBe(true)
    expect(matchesQuery(ev, "constellationnetwork")).toBe(true)
  })
})

describe("mergeEvents — one meeting seen in several places is one row", () => {
  test("merges on iCalUID and unions attendees and sources", () => {
    const a = fromGoogleEvent(invite, "alex@freelabel.net · Work")
    const b: FoundEvent = { ...fromGoogleEvent({ ...invite, attendees: [{ email: "new@x.com" }] }, "Apple Calendar · Work") }
    const m = mergeEvents([a, b])
    expect(m).toHaveLength(1)
    expect(m[0].seenIn).toEqual(["alex@freelabel.net · Work", "Apple Calendar · Work"])
    expect(m[0].attendees.map((x) => x.email)).toContain("new@x.com")
  })
  test("merges a copy with no UID onto one that has it, by title and start minute", () => {
    const a = fromGoogleEvent(invite, "google")
    const b: FoundEvent = { title: "Kickoff: Gate AI Integration", start: "2026-09-30T17:00:00.000Z", attendees: [], seenIn: ["Apple Calendar · X"] }
    expect(mergeEvents([a, b])).toHaveLength(1)
  })
  test("a recurring series is ONE uid and MANY meetings — each instance keeps its own row", () => {
    // Measured 2026-09-30: four weekly Saddle Pass sprints, same iCalUID, came back as one row.
    const weeks = ["2026-09-22", "2026-09-29", "2026-10-06", "2026-10-13"].map((d) =>
      fromGoogleEvent({ ...invite, iCalUID: "series@google.com", start: { dateTime: `${d}T15:00:00-05:00` } }, "g"),
    )
    expect(mergeEvents(weeks)).toHaveLength(4)
  })
  test("does not merge two different meetings", () => {
    const a = fromGoogleEvent(invite, "g")
    const b = fromGoogleEvent({ ...invite, iCalUID: "uid-2", summary: "Other", start: { dateTime: "2026-10-05T12:00:00-05:00" } }, "g")
    expect(mergeEvents([b, a]).map((e) => e.title)).toEqual(["Kickoff: Gate AI Integration", "Other"])
  })
})

describe("uniqueAttendees", () => {
  test("excludes the user's own connected addresses and dedupes across events", () => {
    const ev = fromGoogleEvent(invite, "s")
    const out = uniqueAttendees([ev, ev], ["AMAYO@mypathwaysai.com"])
    expect(out.map((a) => a.email)).toEqual([
      "dave@constellationnetwork.io",
      "alex@constellationnetwork.io",
      "junaid@savelife.ai",
      "rdelgado@vanguardhcs.com",
      "dc@m42.com",
    ])
  })
})

describe("isComplete — 'no events' must never mean 'did not look'", () => {
  test("a failed source makes the search incomplete even when another succeeded", () => {
    expect(
      isComplete([
        { name: "alex@freelabel.net", kind: "google", status: "ok", count: 0 },
        { name: "google-calendar #85", kind: "google", status: "failed", count: 0, reason: "connection no longer exists" },
      ]),
    ).toBe(false)
  })
  test("unsupported sources are reported but are not failures", () => {
    expect(
      isComplete([
        { name: "a", kind: "google", status: "ok", count: 0 },
        { name: "b", kind: "outlook", status: "unsupported", count: 0 },
      ]),
    ).toBe(true)
  })
  test("nothing searched is not complete", () => {
    expect(isComplete([])).toBe(false)
    expect(isComplete([{ name: "b", kind: "outlook", status: "unsupported", count: 0 }])).toBe(false)
  })
})

describe("parseAppleCalendar", () => {
  test("applies the query, strips mailto:, and labels the calendar", () => {
    const out = JSON.stringify({
      calendars: 2,
      errors: [],
      events: [
        { calendar: "Work", title: "Kickoff: Gate AI Integration", start: "2026-09-30T17:00:00.000Z", attendees: [{ email: "mailto:DC@m42.com", name: "Darren" }] },
        { calendar: "Personal", title: "Workout", start: "2026-09-30T13:00:00.000Z", attendees: [] },
      ],
    })
    const r = parseAppleCalendar(out, "gate")
    expect(r.calendars).toBe(2)
    expect(r.events).toHaveLength(1)
    expect(r.events[0].attendees).toEqual([{ email: "dc@m42.com", name: "Darren" }])
    expect(r.events[0].seenIn).toEqual(["Apple Calendar · Work"])
  })
})

describe("parseAppleCalendar — names", () => {
  test("a participant 'name' that is just their address is dropped (EventKit does this)", () => {
    const out = JSON.stringify({ calendars: 1, errors: [], events: [{ calendar: "W", title: "Gate", start: "2026-10-05T17:00:00Z", attendees: [{ email: "mailto:ldorsett@aiaiholdings.com", name: "ldorsett@aiaiholdings.com" }] }] })
    expect(parseAppleCalendar(out, "gate").events[0].attendees).toEqual([{ email: "ldorsett@aiaiholdings.com" }])
  })
})

describe("localSource", () => {
  test("names the reader per OS, and says when there is none", () => {
    expect(localSource("darwin").kind).toBe("apple")
    expect(localSource("win32").kind).toBe("windows-outlook")
    expect(localSource("linux").kind).toBe(null)
  })
})

describe("eventKitStatusReason — a refusal says what to do", () => {
  test("full access reads; write-only (this Mac, 2026-09-30) is named as such with the fix", () => {
    expect(eventKitStatusReason(3)).toBe(null)
    expect(eventKitStatusReason(4)).toContain("write-only")
    expect(eventKitStatusReason(4)).toContain("Full Access")
    expect(eventKitStatusReason(0)).toContain("never been granted")
  })
})
