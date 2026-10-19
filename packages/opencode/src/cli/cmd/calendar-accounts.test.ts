import { describe, expect, test } from "bun:test"
import { calendarHealthFrom, forEachAccount, intersectFreeSlots, mergeAccountEvents, type AccountResult } from "./calendar-accounts"

// #189944 — measured 2026-10-19: pulse printed "Google Calendar connected + verified" in the same
// minute `iris calendar free` said the account was disconnected. The check was the bridge's
// /api/calendar/events — the MAC's Calendar store — labelled "Google Calendar". And with 5
// accounts, `calendar free` and pulse's Meetings refused a READ and demanded --account.

const conn = (id: number, email?: string) => ({ id, type: "google-calendar", account_email: email })
const ok = <T>(c: any, value: T): AccountResult<T> => ({ conn: c, label: c.account_email ?? `google-calendar #${c.id}`, ok: true, value })
const bad = (c: any, error: string): AccountResult<any> => ({ conn: c, label: c.account_email ?? `google-calendar #${c.id}`, ok: false, error })

describe("Google Calendar health is a per-account check", () => {
  test("0 accounts → not connected (never verified)", () => {
    const h = calendarHealthFrom([])
    expect(h.ok).toBe(false)
    expect(h.status).toBe("not_connected")
  })

  test("5 accounts, all answered a real API call → verified, and says how many", () => {
    const h = calendarHealthFrom([1, 2, 3, 4, 5].map((i) => ok(conn(i, `a${i}@x.com`), true)))
    expect(h.ok).toBe(true)
    expect(h.status).toBe("verified")
    expect(h.detail).toContain("5 of 5")
  })

  test("1 revoked of 5 → NOT verified, names the account and the reason", () => {
    const rs = [1, 2, 3, 4].map((i) => ok(conn(i, `a${i}@x.com`), true))
    rs.push(bad(conn(85, "alex@freelabel.net"), "authorization expired — reconnect it"))
    const h = calendarHealthFrom(rs)
    expect(h.ok).toBe(false)
    expect(h.status).toBe("error")
    expect(h.error).toContain("1 of 5")
    expect(h.error).toContain("alex@freelabel.net")
    expect(h.error).toContain("authorization expired")
  })

  test("every account failing is an error too, with the first reason", () => {
    const h = calendarHealthFrom([bad(conn(1), "no active connection")])
    expect(h.ok).toBe(false)
    expect(h.error).toContain("no active connection")
  })
})

describe("forEachAccount — a READ goes to every account", () => {
  test("runs the call with each connection's integration id and keeps per-account failures", async () => {
    const seen: number[] = []
    const rs = await forEachAccount([conn(1, "a@x.com"), conn(2, "b@x.com"), conn(3)], async (id) => {
      seen.push(id)
      if (id === 2) throw new Error("HTTP 401 invalid_grant")
      return { id }
    })
    expect(seen.sort()).toEqual([1, 2, 3])
    expect(rs.filter((r) => r.ok).length).toBe(2)
    expect(rs.find((r) => !r.ok)!.error).toContain("authorization expired")
    expect(rs.find((r) => r.conn.id === 3)!.label).toBe("google-calendar #3")
  })

  test("a {success:false} result is a failure, not a value", async () => {
    const rs = await forEachAccount([conn(1)], async () => ({ success: false, error: "no active connection" }))
    expect(rs[0].ok).toBe(false)
    expect(rs[0].error).toContain("no active connection")
  })
})

describe("free/busy across accounts = the intersection of each account's free time", () => {
  const s = (a: string, b: string) => ({ start: `2026-10-20T${a}:00.000Z`, end: `2026-10-20T${b}:00.000Z` })

  test("overlap only", () => {
    const out = intersectFreeSlots([[s("15:00", "17:00")], [s("16:00", "18:00")]])
    expect(out).toEqual([{ ...s("16:00", "17:00"), duration_minutes: 60 }])
  })

  test("one account fully booked → nothing is free", () => {
    expect(intersectFreeSlots([[s("15:00", "17:00")], []])).toEqual([])
  })

  test("several slots each side", () => {
    const out = intersectFreeSlots([
      [s("14:00", "15:00"), s("16:00", "19:00")],
      [s("14:30", "16:30"), s("18:00", "20:00")],
    ])
    expect(out.map((x) => [x.start.slice(11, 16), x.end.slice(11, 16)])).toEqual([
      ["14:30", "15:00"],
      ["16:00", "16:30"],
      ["18:00", "19:00"],
    ])
  })

  test("a single account is returned as-is (durations recomputed)", () => {
    expect(intersectFreeSlots([[s("14:00", "15:30")]])).toEqual([{ ...s("14:00", "15:30"), duration_minutes: 90 }])
  })

  test("touching slots do not produce a zero-length slot", () => {
    expect(intersectFreeSlots([[s("14:00", "15:00")], [s("15:00", "16:00")]])).toEqual([])
  })
})

describe("events across accounts", () => {
  test("the same event on two accounts (shared invite) is listed once", () => {
    const ev = { id: "e1", summary: "Gate sync", start: "2026-10-20T15:00:00Z" }
    const out = mergeAccountEvents([ok(conn(1), [ev]), ok(conn(2), [{ ...ev }, { id: "e2", summary: "x", start: "2026-10-21T15:00:00Z" }]), bad(conn(3), "expired")])
    expect(out.events.map((e: any) => e.id)).toEqual(["e1", "e2"])
    expect(out.failed).toEqual(["google-calendar #3: expired"])
    expect(out.read).toBe(2)
  })
})

import { fetchLeadCalendarEvents } from "./pulse-contact-script"

describe("pulse Meetings reads every account (#189944)", () => {
  const lead = { id: 29284, name: "Darren Cummings", email: "dc@m42.com" }
  const future = new Date(Date.now() + 86400_000).toISOString()

  test("5 accounts: one call per account, merged; one revoked account is named, not fatal", async () => {
    const calls: any[] = []
    const r = await fetchLeadCalendarEvents(lead, { days: 30 }, {
      listConnections: async () => [1, 2, 3, 4, 85].map((id) => ({ id, account_email: id === 85 ? "alex@freelabel.net" : `a${id}@x.com` })),
      call: async (_p, o) => {
        calls.push(o.integrationId)
        if (o.integrationId === 85) return { success: false, error: "no active connection" }
        return { success: true, events: [{ id: "gate", summary: "Gate sync with Darren Cummings", start: future }] }
      },
    })
    expect(calls.sort()).toEqual([1, 2, 3, 4, 85])
    expect(r.upcoming).toHaveLength(1)
    expect(r.unread[0]).toContain("alex@freelabel.net")
  })

  test("every account unreadable → throws 'not measured', never an empty list", async () => {
    await expect(
      fetchLeadCalendarEvents(lead, {}, {
        listConnections: async () => [{ id: 1 }, { id: 2 }],
        call: async () => ({ success: false, error: "expired" }),
      }),
    ).rejects.toThrow(/not measured/)
  })

  test("one account → the single call with that integration id", async () => {
    const seen: any[] = []
    await fetchLeadCalendarEvents(lead, {}, {
      listConnections: async () => [{ id: 7 }],
      call: async (_p, o) => {
        seen.push(o)
        return { success: true, events: [] }
      },
    })
    expect(seen).toEqual([{ integrationId: 7 }])
  })
})

describe("per-account get_events answers in Google's raw shape (measured live 2026-10-19)", () => {
  test("data.items with {dateTime} starts is read, and the start is a usable string", async () => {
    const future = new Date(Date.now() + 2 * 86400_000).toISOString()
    const r = await fetchLeadCalendarEvents({ id: 29284, name: "Darren Cummings", email: "dc@m42.com" }, { days: 30 }, {
      listConnections: async () => [{ id: 10 }, { id: 91 }],
      call: async () => ({
        success: true,
        data: { kind: "calendar#events", items: [{ id: "g1", summary: "Gate: Technical Pilot Checkin", start: { dateTime: future }, end: { dateTime: future }, attendees: [{ email: "dc@m42.com" }] }] },
      }),
    })
    expect(r.upcoming).toHaveLength(1)
    expect(typeof r.upcoming[0].start).toBe("string")
    expect(r.unread).toEqual([])
  })
})

import { freeFromEvents } from "./calendar-accounts"

describe("free time derived from events (fallback while the provider's free/busy call is broken)", () => {
  const from = "2026-10-20T19:00:00.000Z"
  const to = "2026-10-20T23:00:00.000Z"
  const ev = (a: string, b: string, extra: any = {}) => ({ start: { dateTime: `2026-10-20T${a}:00.000Z` }, end: { dateTime: `2026-10-20T${b}:00.000Z` }, ...extra })

  test("window minus busy events, overlapping events merged", () => {
    const out = freeFromEvents([ev("20:00", "21:00"), ev("20:30", "21:30"), ev("22:00", "22:15")], from, to)
    expect(out.map((s) => [s.start.slice(11, 16), s.end.slice(11, 16)])).toEqual([
      ["19:00", "20:00"],
      ["21:30", "22:00"],
      ["22:15", "23:00"],
    ])
  })

  test("transparent (free) and declined events do not block time; all-day events do", () => {
    const out = freeFromEvents(
      [
        ev("19:00", "23:00", { transparency: "transparent" }),
        ev("19:00", "23:00", { attendees: [{ self: true, responseStatus: "declined" }] }),
      ],
      from,
      to,
    )
    expect(out).toHaveLength(1)
    expect(freeFromEvents([{ start: { date: "2026-10-20" }, end: { date: "2026-10-21" } }], from, to)).toEqual([])
  })

  test("no events → the whole window is free", () => {
    expect(freeFromEvents([], from, to)).toEqual([{ start: from, end: to, duration_minutes: 240 }])
  })
})
