import { describe, expect, test } from "bun:test"
import { bellCount, bellLabel, bellRows, replyPrompt, senderName, waitingOnYou, type BellThread } from "./notification-bell-model"

const t = (over: Partial<BellThread>): BellThread => ({
  id: Math.random().toString(36).slice(2),
  subject: "Hello",
  from: "Someone <someone@example.com>",
  snippet: "Hi",
  ...over,
})

const maria = t({ from: "Maria Lopez <maria@example.com>", subject: "Rescheduling Thursday", date: "2026-10-26T10:00:00Z" })
const dev = t({ from: "Dev Patel <dev@example.com>", subject: "Insurance claim", date: "2026-10-25T10:00:00Z" })
const news = t({ from: "Gamma <team@gamma.app>", automated: true, kind: "fyi", date: "2026-10-26T11:00:00Z" })
const mine = t({ from: "Front Desk <frontdesk@brightsmile.example>", date: "2026-10-26T12:00:00Z" })

describe("waitingOnYou", () => {
  test("keeps people, drops newsletters and the account's own mail, newest first", () => {
    const out = waitingOnYou([dev, news, mine, maria], "frontdesk@brightsmile.example")
    expect(out.map((x) => senderName(x.from))).toEqual(["Maria Lopez", "Dev Patel"])
  })

  test("two emails from one person are one person waiting", () => {
    const again = t({ from: "Maria Lopez <MARIA@example.com>", date: "2026-10-26T09:00:00Z" })
    expect(waitingOnYou([maria, again, dev]).length).toBe(2)
  })
})

describe("bellRows and the badge", () => {
  const work = [{ id: "s1", title: "Friday newsletter", subagent: false, retrying: false }]

  test("the badge counts people waiting and unread messages, never running work", () => {
    const rows = bellRows({ waiting: [maria, dev], work, hiveUnread: 3 })
    expect(rows.map((r) => r.kind)).toEqual(["reply", "work", "hive"])
    expect(bellCount(rows)).toBe(5)
  })

  test("only running work: listed, but no number on the bell", () => {
    const rows = bellRows({ waiting: [], work, hiveUnread: 0 })
    expect(rows.length).toBe(1)
    expect(bellLabel(bellCount(rows))).toBeNull()
  })

  test("an unreadable inbox count is not a number to show", () => {
    expect(bellRows({ waiting: [], work: [], hiveUnread: null })).toEqual([])
  })

  test("one person is named; several are counted", () => {
    expect(bellRows({ waiting: [maria], work: [], hiveUnread: 0 })[0].title).toBe("Maria Lopez needs a reply")
    expect(bellRows({ waiting: [maria, dev], work: [], hiveUnread: 0 })[0].title).toBe("2 people need a reply")
  })

  test("labels cap at 99+", () => {
    expect(bellLabel(0)).toBeNull()
    expect(bellLabel(7)).toBe("7")
    expect(bellLabel(140)).toBe("99+")
  })
})

describe("replyPrompt", () => {
  test("names every person, asks through the question tool, and never sends", () => {
    const text = replyPrompt([maria, dev])
    expect(text).toContain("Maria Lopez <maria@example.com>")
    expect(text).toContain("Dev Patel <dev@example.com>")
    expect(text).toContain("question tool")
    expect(text).toContain("Do not send anything")
  })
})
