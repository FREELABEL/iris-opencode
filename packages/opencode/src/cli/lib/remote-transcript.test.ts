import { describe, expect, test } from "bun:test"
import { appendedSince, messageLine, transcriptPath } from "./remote-transcript"

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
