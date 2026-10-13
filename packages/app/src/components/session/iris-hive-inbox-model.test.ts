import { describe, expect, test } from "bun:test"
import { bodyNote, hivePillTarget, inboxCli, inboxRowsOf, kindLabel, shortAge, subjectOf, unreadOf } from "./iris-hive-inbox-model"

// Fictional rows only — this repo is public.
const row = (o: Partial<Parameters<typeof inboxRowsOf>[0] extends readonly (infer R)[] | undefined ? R : never>) => ({
  index: 1,
  read: false,
  type: "message",
  from: "studio-mac",
  label: "x",
  ...o,
})

describe("inboxRowsOf (#189279)", () => {
  test("newest first — an unread OLD message does not sit above a newer one", () => {
    const rows = inboxRowsOf([
      row({ index: 1, read: false, receivedAt: "2026-10-01T10:00:00Z" }),
      row({ index: 2, read: true, receivedAt: "2026-10-03T10:00:00Z" }),
      row({ index: 3, read: false, receivedAt: "2026-10-02T10:00:00Z" }),
    ])
    expect(rows.map((r) => r.index)).toEqual([2, 3, 1])
  })

  test("no timestamp sorts by manifest position, newest appended last", () => {
    expect(inboxRowsOf([row({ index: 1 }), row({ index: 4 }), row({ index: 2 })]).map((r) => r.index)).toEqual([4, 2, 1])
  })

  test("does not mutate what it was given", () => {
    const input = [row({ index: 1 }), row({ index: 2 })]
    inboxRowsOf(input)
    expect(input.map((r) => r.index)).toEqual([1, 2])
  })

  test("undefined is an empty list, not a crash", () => expect(inboxRowsOf(undefined)).toEqual([]))
})

describe("unreadOf", () => {
  test("counts unread", () => expect(unreadOf([row({ read: false }), row({ read: true }), row({ read: false })])).toBe(2))
  test("no rows to count is NOT zero", () => expect(unreadOf(undefined)).toBeNull())
})

describe("hivePillTarget — each pill opens its own pane", () => {
  test("the Hive pill opens Hive › Machines", () => expect(hivePillTarget("machines")).toEqual({ surface: "hive", sub: "machines" }))
  test("the Inbox pill opens Hive › Inbox", () => expect(hivePillTarget("inbox")).toEqual({ surface: "hive", sub: "inbox" }))
})

describe("subjectOf", () => {
  test("a message leads with its first line", () => {
    expect(subjectOf({ type: "message", label: "Deploy is done\nmore", preview: "Deploy is done" })).toBe("Deploy is done")
  })
  test("a file leads with its name, not a preview of its note", () => {
    expect(subjectOf({ type: "file", label: "report.pdf", preview: "see attached" })).toBe("report.pdf")
  })
  test("never blank", () => expect(subjectOf({ type: "message", label: "" })).toBe("(no text)"))
})

describe("presentation helpers", () => {
  const now = Date.parse("2026-10-13T12:00:00Z")
  test("shortAge", () => {
    expect(shortAge("2026-10-13T11:59:30Z", now)).toBe("now")
    expect(shortAge("2026-10-13T11:45:00Z", now)).toBe("15m")
    expect(shortAge("2026-10-13T09:00:00Z", now)).toBe("3h")
    expect(shortAge("2026-10-11T12:00:00Z", now)).toBe("2d")
    expect(shortAge(undefined, now)).toBe("")
    expect(shortAge("garbage", now)).toBe("")
  })
  test("kindLabel names the kinds people see", () => {
    expect(kindLabel("job")).toBe("Job result")
    expect(kindLabel("handoff")).toBe("Handoff")
    expect(kindLabel("custom")).toBe("Custom")
  })
  test("the CLI command takes the MANIFEST position", () => expect(inboxCli({ index: 7 })).toBe("iris hive inbox read 7"))
  test("a missing body is explained, never a blank panel", () => {
    expect(bodyNote({ bodyState: "ok", type: "message" })).toBeNull()
    expect(bodyNote({ bodyState: "binary", type: "file", originalName: "photo.png" })).toContain("photo.png")
    expect(bodyNote({ bodyState: "missing", type: "message" })).toBeTruthy()
    expect(bodyNote({ bodyState: "none", type: "link" })).toBeNull()
  })
})
