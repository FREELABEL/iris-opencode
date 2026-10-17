import { describe, expect, test } from "bun:test"
import { fleetCards, fleetHeadline, inboxKind, inboxPill, localNotes, restartWords, type LocalDaemon } from "./dialog-hive-model"
import type { HiveNodeRow } from "./session/iris-hive-scripts-model"

const NOW = Date.parse("2026-10-17T09:00:00Z")
const mac = (over: Partial<HiveNodeRow> = {}): HiveNodeRow => ({
  id: "mac-1",
  name: "Alexs-MacBook-Pro-11711",
  online: true,
  lastHeartbeat: "2026-10-17T08:59:40Z",
  os: "darwin",
  cores: 10,
  memoryGb: 16,
  diskTotalGb: 460,
  diskFreeGb: 11,
  capabilities: ["camera", "bluetooth"],
  activeTasks: 0,
  maxConcurrent: 3,
  ...over,
})
const local = (over: Partial<LocalDaemon> = {}): LocalDaemon => ({
  supported: true,
  nodeId: "mac-1",
  running: true,
  pid: 12271,
  program: "/Users/a/.iris/iris-daemon-wrapper.sh",
  programOk: true,
  version: "f140c6e",
  behind: 0,
  fetchedAt: null,
  localEdits: 0,
  ...over,
})

describe("machines dialog", () => {
  test("a healthy daemon says nothing", () => {
    expect(localNotes(local())).toEqual([])
  })

  // The three things the hub could not see on 2026-10-17, each with the button that fixes it.
  test("not running is critical and offers the restart", () => {
    const [n] = localNotes(local({ running: false, pid: null }))
    expect(n.level).toBe("crit")
    expect(n.action).toBe("restart")
  })
  test("a launch agent from /tmp is a warning with the restart that repairs it", () => {
    const [n] = localNotes(local({ programOk: false, program: "/tmp/iris-fresh/.iris/iris-daemon-wrapper.sh" }))
    expect(n.text).toContain("temporary folder")
    expect(n.action).toBe("restart")
  })
  test("14 behind warns; 2 behind is only housekeeping; behind offers no button yet", () => {
    expect(localNotes(local({ behind: 14 }))[0]).toMatchObject({ level: "warn", text: "14 updates behind" })
    expect(localNotes(local({ behind: 2 }))[0].level).toBe("info")
    expect(localNotes(local({ behind: 14 }))[0].action).toBeUndefined()
  })
  test("unknown is not zero: no local reading means no local notes, not a clean bill", () => {
    expect(localNotes(null)).toEqual([])
    expect(localNotes(local({ supported: false, running: false }))).toEqual([])
  })

  test("this computer comes first and folds its old registrations", () => {
    const nodes = [
      mac({ id: "pi", name: "iris-hive-001", os: "linux", cores: 4, memoryGb: 8, diskTotalGb: 120 }),
      mac({ id: "mac-old", online: false, lastHeartbeat: "2026-10-01T00:00:00Z" }),
      mac(),
    ]
    const cards = fleetCards(nodes, local(), NOW)
    expect(cards[0].self).toBe(true)
    expect(cards[0].regs).toBe(2)
    expect(cards).toHaveLength(2)
  })
  test("a sleeping Mac's old registration still matches by id", () => {
    const cards = fleetCards([mac({ id: "mac-new" }), mac({ id: "mac-1", online: false })], local(), NOW)
    expect(cards[0].self).toBe(true)
  })
  test("local notes appear only on this computer", () => {
    const cards = fleetCards([mac(), mac({ id: "pi", name: "pi", os: "linux", cores: 4 })], local({ running: false }), NOW)
    expect(cards.find((c) => c.self)!.notes.some((n) => n.action === "restart")).toBe(true)
    expect(cards.find((c) => !c.self)!.notes.some((n) => n.action === "restart")).toBe(false)
  })

  test("headline counts only real problems", () => {
    const cards = fleetCards([mac()], local({ behind: 2 }), NOW)
    expect(fleetHeadline(cards)).toBe("1 of 1 computer online")
    expect(fleetHeadline(fleetCards([mac()], local({ behind: 20 }), NOW))).toBe("1 of 1 computer online · 1 needs you")
  })

  test("a restart counts only when a new process exists", () => {
    expect(restartWords({ measured: true, before: 1, after: 2, repaired: false })).toBe("Restarted — it is running again")
    expect(restartWords({ measured: true, before: 1, after: 2, repaired: true })).toContain("right place")
    expect(restartWords({ measured: false, reason: "launchd refused the restart", before: 1, after: null, repaired: false })).toBe(
      "Did not restart — launchd refused the restart",
    )
  })
})

describe("inbox dialog", () => {
  test("kinds in words", () => {
    expect(inboxKind("message")).toBe("Message")
    expect(inboxKind("handoff")).toBe("Work handed to you")
    expect(inboxKind("pdf")).toBe("File")
  })
  test("pill: count when unread, empty when none, dash when unmeasured", () => {
    expect(inboxPill(3, false)).toBe("3")
    expect(inboxPill(0, false)).toBe("")
    expect(inboxPill(null, false)).toBe("—")
    expect(inboxPill(2, true)).toBe("—")
  })
})
