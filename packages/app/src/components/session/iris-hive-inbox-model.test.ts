import { describe, expect, test } from "bun:test"
import {
  applyFilter,
  bodyAfterTitle,
  bodyNote,
  cardLabel,
  dayLabel,
  filterCounts,
  groupByDay,
  hivePillTarget,
  inboxCli,
  inboxRowsOf,
  initials,
  kindLabel,
  matchesQuery,
  needsMe,
  parsePrefs,
  plainPeek,
  peersOf,
  rankInbox,
  replyCount,
  sentState,
  sentTone,
  shortAge,
  subjectOf,
  threadOf,
  unreadOf,
  type SentRow,
} from "./iris-hive-inbox-model"

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
  test("a handoff with a note leads with the note, not the card id", () => {
    expect(subjectOf({ type: "handoff", label: "bloq:item:9 [blocked]", preview: "Ready for review" })).toBe("Ready for review")
    expect(subjectOf({ type: "handoff", label: "bloq:item:9 [blocked]" })).toBe("bloq:item:9 [blocked]")
  })
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

describe("bodyAfterTitle", () => {
  test("drops the first line when the header already shows it", () => {
    expect(bodyAfterTitle("Deploy done\n\nAll three passed.", "Deploy done")).toBe("All three passed.")
  })
  test("keeps the body when the first line is not the title", () => {
    expect(bodyAfterTitle("Hello\nthere", "report.pdf")).toBe("Hello\nthere")
  })
  test("never empties a one-line message", () => expect(bodyAfterTitle("Just this", "Just this")).toBe("Just this"))
})

// ── v2 (#190917) ──────────────────────────────────────────────────────────
describe("needsMe — a rule a person can repeat, not 'everything unread'", () => {
  test("a handoff that is not done needs you, read or not", () => {
    expect(needsMe(row({ type: "handoff", read: true }))).toBe(true)
    expect(needsMe(row({ type: "handoff", done: true }))).toBe(false)
  })
  test("a job needs you only when it failed", () => {
    expect(needsMe(row({ type: "job", status: "completed" }))).toBe(false)
    expect(needsMe(row({ type: "job", status: "failed" }))).toBe(true)
  })
  test("an unread question needs you; an unread statement does not", () => {
    expect(needsMe(row({ preview: "Can you review this?" }))).toBe(true)
    expect(needsMe(row({ preview: "Deploy finished" }))).toBe(false)
    expect(needsMe(row({ preview: "Can you review this?", read: true }))).toBe(false)
  })
})

describe("filters are the SAME set in both lenses", () => {
  const rows = [
    row({ index: 1, type: "handoff" }),
    row({ index: 2, type: "file" }),
    row({ index: 3, type: "message", done: true }),
    row({ index: 4, type: "job", status: "completed" }),
  ]
  const sent: SentRow[] = [{ id: "o", to: "x", text: "hi", sentAt: "2026-10-01T00:00:00Z" }]
  test("done rows live under Done only", () => {
    expect(applyFilter(rows, "all").map((r) => r.index)).toEqual([1, 2, 4])
    expect(applyFilter(rows, "done").map((r) => r.index)).toEqual([3])
  })
  test("handoffs include job results; files are files", () => {
    expect(applyFilter(rows, "handoffs").map((r) => r.index)).toEqual([1, 4])
    expect(applyFilter(rows, "files").map((r) => r.index)).toEqual([2])
  })
  test("counts", () => expect(filterCounts(rows, sent)).toEqual({ all: 3, needs: 1, handoffs: 2, files: 1, sent: 1, done: 1 }))
})

describe("rankInbox — needs you, then unread, then read; newest first in each", () => {
  test("an older handoff outranks a newer unread note", () => {
    const r = rankInbox([
      row({ index: 1, read: true, receivedAt: "2026-10-03T00:00:00Z" }),
      row({ index: 2, read: false, receivedAt: "2026-10-04T00:00:00Z" }),
      row({ index: 3, type: "handoff", read: true, receivedAt: "2026-10-01T00:00:00Z" }),
      row({ index: 4, read: false, receivedAt: "2026-10-02T00:00:00Z" }),
    ])
    expect(r.map((x) => x.index)).toEqual([3, 2, 4, 1])
  })
})

describe("day groups (Activity)", () => {
  const now = new Date(2026, 9, 13, 15, 0).getTime()
  test("Today / Yesterday / weekday / date", () => {
    expect(dayLabel(new Date(2026, 9, 13, 1, 0).toISOString(), now)).toBe("Today")
    expect(dayLabel(new Date(2026, 9, 12, 23, 0).toISOString(), now)).toBe("Yesterday")
    expect(dayLabel(new Date(2026, 9, 10, 9, 0).toISOString(), now)).toBe("Saturday")
    expect(dayLabel(new Date(2026, 8, 1, 9, 0).toISOString(), now)).toBe("Sep 1")
    expect(dayLabel(undefined, now)).toBe("Earlier")
  })
  test("consecutive rows share a group; order is kept", () => {
    const g = groupByDay(
      [new Date(2026, 9, 13, 9).toISOString(), new Date(2026, 9, 13, 8).toISOString(), new Date(2026, 9, 12, 8).toISOString()],
      (x) => x,
      now,
    )
    expect(g.map((x) => [x.day, x.rows.length])).toEqual([["Today", 2], ["Yesterday", 1]])
  })
})

describe("threads", () => {
  const rows = [
    row({ index: 1, id: "a", from: "iris-hive-001", receivedAt: "2026-10-13T09:38:00Z", read: true }),
    row({ index: 2, id: "b", from: "studio-mac", receivedAt: "2026-10-13T08:47:00Z" }),
    row({ index: 3, id: "c", from: "IRIS-HIVE-001", receivedAt: "2026-10-13T09:41:00Z" }),
  ]
  const sent: SentRow[] = [{ id: "o", to: "iris-hive-001", text: "Gate it.", sentAt: "2026-10-13T09:40:00Z", replyTo: "a" }]
  test("a thread is both directions with one computer, oldest first, name case-insensitive", () => {
    expect(threadOf("iris-hive-001", rows, sent).map((x) => (x.dir === "in" ? x.row.id : x.sent.id))).toEqual(["a", "o", "c"])
  })
  test("the rail: most recent first, with unread counts", () => {
    expect(peersOf(rows, sent).map((p) => [p.peer, p.unread])).toEqual([["iris-hive-001", 1], ["studio-mac", 1]])
  })
  test("reply count follows replyTo", () => {
    expect(replyCount("a", sent)).toBe(1)
    expect(replyCount("c", sent)).toBe(0)
    expect(replyCount(undefined, sent)).toBe(0)
  })
})

describe("words on screen", () => {
  test("initials", () => {
    expect(initials("iris-hive-001")).toBe("IH")
    expect(initials("studio-mac")).toBe("SM")
    expect(initials("Riley (agent)")).toBe("RA")
    expect(initials("x")).toBe("X")
  })
  test("cardLabel", () => {
    expect(cardLabel("bloq:item:190875")).toBe("#190875")
    expect(cardLabel(undefined)).toBeUndefined()
  })
  test("accepted is not delivered; nothing ever claims read", () => {
    const base = { id: "1", to: "a", text: "x", sentAt: "", taskId: "t" }
    expect(sentState(base)).toBe("accepted by IRIS")
    expect(sentState({ ...base, via: "relay" })).toBe("accepted by IRIS · via relay")
    for (const s of [base, { ...base, via: "relay" }, { id: "1", to: "a", text: "x", sentAt: "" }])
      expect(sentState(s)).not.toMatch(/deliver|read|seen/i)
  })
  test("delivery from the task: delivered, waiting, refused with the reason (#190982)", () => {
    const base = { id: "1", to: "a", text: "x", sentAt: "", taskId: "t" }
    const d = { ...base, delivery: "delivered" as const }
    const f = { ...base, delivery: "failed" as const, deliveryReason: "their computer was busy (CPU at 137%)" }
    const w = { ...base, delivery: "waiting" as const }
    expect(sentState(d)).toBe("delivered to their inbox")
    expect(sentState(f)).toBe("not delivered — their computer was busy (CPU at 137%)")
    expect(sentState(w)).toBe("waiting for their computer")
    expect([sentTone(d), sentTone(f), sentTone(w), sentTone(base)]).toEqual(["ok", "fail", "wait", "plain"])
    for (const s of [d, f, w]) expect(sentState(s)).not.toMatch(/\bread\b|seen/i)
  })
  test("matchesQuery looks at sender, subject and label", () => {
    expect(matchesQuery({ from: "studio-mac", label: "x", preview: "Deploy" }, "deploy")).toBe(true)
    expect(matchesQuery({ from: "studio-mac", label: "x" }, "STUDIO")).toBe(true)
    expect(matchesQuery({ from: "a", label: "b" }, "zzz")).toBe(false)
  })
})

describe("parsePrefs — remembered lens, filter, selection", () => {
  test("round trip", () => expect(parsePrefs(JSON.stringify({ lens: "activity", filter: "files", selected: "m1" }))).toEqual({ lens: "activity", filter: "files", selected: "m1" }))
  test("garbage and unknown values fall back, never throw", () => {
    expect(parsePrefs("{nope")).toEqual({ lens: "inbox", filter: "all" })
    expect(parsePrefs(JSON.stringify({ lens: "x", filter: "y" }))).toEqual({ lens: "inbox", filter: "all", selected: undefined })
    expect(parsePrefs(null)).toEqual({ lens: "inbox", filter: "all" })
  })
})

describe("plainPeek", () => {
  test("drops markdown markup, keeps the words", () => {
    expect(plainPeek("I rewrote the **welcome screen**.\n\n- Shorter headline\n- [Plans](https://x.y) link")).toBe(
      "I rewrote the welcome screen.\n\n• Shorter headline\n• Plans link",
    )
    expect(plainPeek("## Title\nUse `iris hive` and _this_")).toBe("Title\nUse iris hive and this")
  })
  test("snake_case and a * b survive", () => expect(plainPeek("set max_retries to 3 * 2")).toBe("set max_retries to 3 * 2"))
})
