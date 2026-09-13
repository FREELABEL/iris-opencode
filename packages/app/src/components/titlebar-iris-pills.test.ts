import { describe, expect, test } from "bun:test"
import { fleetLabel, inboxLabel } from "./titlebar-iris-pills"

describe("fleetLabel", () => {
  test("an unreachable fleet is a dash, never 0/0", () => {
    // "0/0" says we looked and everything is down — which sends someone to go check a machine
    // that is probably fine. "—" says we could not look.
    expect(fleetLabel({ measured: false, reason: "iris-api 401", nodes: [] })).toBe("—")
    expect(fleetLabel(undefined)).toBe("—")
  })

  test("a measured fleet counts online against total", () => {
    expect(fleetLabel({ measured: true, nodes: [{ online: true }, { online: false }, { online: true }] })).toBe("2/3")
  })

  test("a measured fleet that really is all down says so", () => {
    expect(fleetLabel({ measured: true, nodes: [{ online: false }] })).toBe("0/1")
  })
})

describe("inboxLabel", () => {
  test("nothing waiting shows nothing — a permanent 0 is furniture", () => {
    expect(inboxLabel({ unread: 0, unreadable: false })).toBeNull()
  })

  test("an unreadable manifest is a dash, not silence", () => {
    // Silence here would be indistinguishable from an empty inbox, which is the exact failure
    // that let four messages sit unread on 2026-09-11.
    expect(inboxLabel({ unread: null, unreadable: true })).toBe("—")
    expect(inboxLabel({ unread: null, unreadable: false })).toBe("—")
  })

  test("unread shows the count", () => {
    expect(inboxLabel({ unread: 4, unreadable: false })).toBe("4")
  })
})
