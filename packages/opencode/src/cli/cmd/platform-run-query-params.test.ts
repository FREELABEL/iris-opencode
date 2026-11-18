import { describe, expect, test } from "bun:test"
import { attendeeLines, parseParams, stripWrappingQuotes, validateActionParams, withParamSynonyms } from "./platform-run"
import { fromGoogleEvent } from "./calendar-search"
import { listSearchParams } from "./platform-calendar"

// #191935: finding a past meeting, and a reply check that must never look empty by accident.
describe("key=value keeps a search intact", () => {
  test("a query that ends in a quoted phrase keeps its quotes", () => {
    const q = 'from:a OR "b c"'
    expect(parseParams([`query=${q}`]).query).toBe(q)
  })
  test("a query that starts and ends with different phrases is not unwrapped", () => {
    const q = '"a b" OR "c d"'
    expect(parseParams([`query=${q}`]).query).toBe(q)
  })
  test("parentheses and OR pass through", () => {
    const q = '(a OR "b c" OR d.io) newer_than:60d'
    expect(parseParams([`query=${q}`]).query).toBe(q)
  })
  test("quotes around the whole value still come off", () => {
    expect(stripWrappingQuotes('"hello world"')).toBe("hello world")
    expect(stripWrappingQuotes("'hello'")).toBe("hello")
    expect(stripWrappingQuotes('"')).toBe('"')
    expect(stripWrappingQuotes('say "hi')).toBe('say "hi')
  })
})

describe("query on a declared action", () => {
  const sig = { name: "get_events", description: "", writes: false, parameters: [{ name: "query", type: "string", required: false, description: "" }] }
  test("q is accepted once the action declares query, and is broadcast the same way", () => {
    expect(validateActionParams(sig as any, { q: "x" }, [["query", "q"]]).ok).toBe(true)
    expect(withParamSynonyms({ query: "x" }).q).toBe("x")
  })
})

describe("attendees", () => {
  test("one line per person with name, email and response, from either shape", () => {
    expect(attendeeLines([{ name: "Ann", email: "a@example.com", response_status: "accepted" }])).toEqual(["Ann · a@example.com (accepted)"])
    expect(attendeeLines([{ displayName: "Bo", email: "b@example.com", responseStatus: "declined", organizer: true }])).toEqual(["Bo · b@example.com (declined) organizer"])
    expect(attendeeLines(undefined)).toEqual([])
  })
  test("a search reads the server's attendee fields as well as Google's", () => {
    const fe = fromGoogleEvent({ summary: "s", start: "2026-10-20", attendees: [{ name: "Ann", email: "A@example.com", response_status: "accepted" }] }, "x")
    expect(fe.attendees[0]).toEqual({ email: "a@example.com", name: "Ann", response: "accepted" })
    const room = fromGoogleEvent({ summary: "s", start: "2026-10-20", attendees: [{ email: "room@example.com", resource: true }] }, "x")
    expect(room.attendees).toEqual([])
  })
})

describe("list --search", () => {
  test("asks Google, rather than filtering one page", () => {
    expect(listSearchParams("kickoff")).toEqual({ q: "kickoff" })
    expect(listSearchParams(" ")).toEqual({})
    expect(listSearchParams(undefined)).toEqual({})
  })
})
