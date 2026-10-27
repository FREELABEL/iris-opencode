import { describe, expect, test } from "bun:test"
import { advance, appendedSince, FOLLOW_PAGE, fromPage, messageLine, transcriptPath } from "./remote-transcript"

// #191230 — read a session's transcript from another machine.
describe("transcriptPath", () => {
  test("builds the server route with only the options given", () => {
    expect(transcriptPath("ses_e86cbbba0ffehvLcmCXNPrnsR3")).toBe("/api/v6/nodes/sessions/ses_e86cbbba0ffehvLcmCXNPrnsR3/transcript")
    expect(transcriptPath("ses_a", { machine: "Alexs-MacBook-Pro-11711", provider: "opencode", limit: 20, since: 0 })).toBe(
      "/api/v6/nodes/sessions/ses_a/transcript?machine=Alexs-MacBook-Pro-11711&provider=opencode&limit=20&since=0",
    )
  })

  test("clamps the limit to what the server accepts", () => {
    expect(transcriptPath("ses_a", { limit: 500 })).toContain("limit=100")
  })

  test("refuses anything that is not a session id before it becomes a path", () => {
    expect(() => transcriptPath("../../users/1")).toThrow()
    expect(() => transcriptPath("a b")).toThrow()
  })
})

describe("messageLine", () => {
  test("a tool call shows the command or file it touched, not an empty text", () => {
    expect(messageLine({ role: "assistant", type: "tool_use", tool: "bash", command: "git status --short" })).toEqual(["bash", "git status --short"])
    expect(messageLine({ role: "assistant", type: "tool_use", tool: "read", command: null, file_path: "/x/package.json" })).toEqual(["read", "/x/package.json"])
  })

  test("a message is one line, cut to width", () => {
    const [label, text] = messageLine({ role: "user", content: "line one\n\nline two " + "x".repeat(300) }, 40)
    expect(label).toBe("user")
    expect(text.length).toBe(40)
    expect(text.startsWith("line one line two")).toBe(true)
  })

  test("structured content still renders", () => {
    expect(messageLine({ role: "assistant", content: [{ type: "text", text: "hi" }] })[1]).toContain("hi")
  })
})

describe("appendedSince (follow without a cursor)", () => {
  const m = (t: string) => ({ role: "assistant", content: t })

  test("an unchanged page adds nothing — the bug was reprinting it every poll", () => {
    expect(appendedSince([m("a"), m("b")], [m("a"), m("b")])).toEqual([])
  })

  test("a shifted page adds only the new tail", () => {
    expect(appendedSince([m("a"), m("b"), m("c")], [m("b"), m("c"), m("d")])).toEqual([m("d")])
  })

  test("a repeated entry is still printed", () => {
    expect(appendedSince([m("a"), m("b")], [m("b"), m("b")])).toEqual([m("b")])
  })

  test("no overlap means a whole page of new entries", () => {
    expect(appendedSince([m("a")], [m("x"), m("y")])).toEqual([m("x"), m("y")])
  })
})

describe("follow (#191302)", () => {
  const m = (t: string) => ({ role: "assistant", content: t })

  test("a reset is never printed as-is — it asks for the latest page", () => {
    // The daemon answers an overflow with NO rows and reset:true; printing that lost ALPHA on 2026-10-27.
    expect(advance({ page: [m("a")], offset: 10 }, { messages: [], offset: 99, reset: true })).toEqual({ refetch: true })
  })

  test("after a reset, only entries past the overlap print — nothing between polls is lost", () => {
    const shown = { page: [m("a"), m("b")], offset: 10 }
    const r = fromPage(shown, [m("a"), m("b"), m("ALPHA"), m("BRAVO")], 200)
    expect(r.print).toEqual([m("ALPHA"), m("BRAVO")])
    expect(r.gap).toBe(false)
    expect(r.state).toEqual({ page: [m("a"), m("b"), m("ALPHA"), m("BRAVO")], offset: 200 })
  })

  test("a page with no overlap is flagged as a gap", () => {
    expect(fromPage({ page: [m("a")], offset: 1 }, [m("x"), m("y")], 2).gap).toBe(true)
  })

  test("with a cursor, appended rows print and extend the baseline", () => {
    const r = advance({ page: [m("a")], offset: 10 }, { messages: [m("b")], offset: 20 })
    expect("print" in r && r.print).toEqual([m("b")])
    expect("state" in r && r.state).toEqual({ page: [m("a"), m("b")], offset: 20 })
  })

  test("without a cursor, the latest page prints only what it adds", () => {
    const r = advance({ page: [m("a"), m("b")], offset: null }, { messages: [m("b"), m("c")], offset: null })
    expect("print" in r && r.print).toEqual([m("c")])
  })

  test("polls ask for the server's cap, not the first screen's size", () => {
    expect(FOLLOW_PAGE).toBe(100)
  })
})
