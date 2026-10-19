import { describe, expect, test } from "bun:test"
import {
  fetchLeadMail,
  leadMailRows,
  mailExternalId,
  mergeLeadMail,
  unansweredInbound,
  appleMailLedgerItems,
} from "./comms-apple-mail"

// #189941 — measured 2026-10-19. The bridge answers { emails: [...] }; pulse and sync-comms
// read `data.messages`, so Apple Mail was ALWAYS empty for every lead, however much mail there
// was. Sender-only search also meant outbound mail could never be seen.

const NOW = new Date("2026-10-19T18:00:00Z")
const h = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString()

const newBridge = (emails: any[]) => ({ emails, count: emails.length, source: "envelope-index", capabilities: ["participant", "body"] })

function fakeFetch(routes: (url: string) => { status: number; body: any }) {
  const calls: string[] = []
  const fn = async (url: string) => {
    calls.push(url)
    const r = routes(url)
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  return { fn, calls }
}

describe("#189941 lead mail — reading the bridge's actual contract", () => {
  test("rows under `emails` are read (the key every lead caller missed)", () => {
    const rows = leadMailRows(newBridge([{ subject: "Following up", sender: "hpk@m42.com", date_sent: h(30), direction: "inbound", message_id: "1" }]), "hpk@m42.com")
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe(h(30))
    expect(rows[0].direction).toBe("inbound")
  })

  test("an old bridge with no direction: sender match is inbound, anything else outbound", () => {
    const rows = leadMailRows({ messages: [{ subject: "a", sender: "HPK@M42.com", date: h(1) }, { subject: "b", sender: "alex@freelabel.net", date: h(2) }] }, "hpk@m42.com")
    expect(rows.map((r) => r.direction)).toEqual(["inbound", "outbound"])
  })

  test("display-name-only sender (no address) does not crash and is not called inbound from the lead", () => {
    const rows = leadMailRows(newBridge([{ subject: "x", sender: "", sender_name: "Haripurkh Khalsa", date_sent: h(1) }]), "hpk@m42.com")
    expect(rows[0].direction).toBe("outbound")
  })

  test("an unrecognised response throws instead of reading as 'no mail'", () => {
    expect(() => leadMailRows({ ok: true }, "a@b.c")).toThrow(/not an empty mailbox/)
  })
})

describe("dedupe — one message in INBOX + All Mail + Sent counts once", () => {
  test("same message_id across mailboxes and across two lead addresses → one row", () => {
    const a = leadMailRows(newBridge([
      { subject: "Re: demo", sender: "alex@freelabel.net", date_sent: h(5), direction: "outbound", message_id: "333", mailbox: "imap://x/%5BGmail%5D/All%20Mail" },
    ]), "hpk@m42.com")
    const b = leadMailRows(newBridge([
      { subject: "Re: demo", sender: "alex@freelabel.net", date_sent: h(5), direction: "outbound", message_id: "333", mailbox: "imap://x/%5BGmail%5D/Sent%20Mail" },
      { subject: "Re: demo", sender: "alex@freelabel.net", date_sent: h(5), direction: "outbound", message_id: "333", mailbox: "imap://x/INBOX" },
    ]), "HPK+crm@m42.com")
    const merged = mergeLeadMail([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0].mailboxes?.length).toBe(3)
  })

  test("no message_id (old bridge) falls back to sender+date+subject, and never merges different messages", () => {
    const rows = mergeLeadMail([
      leadMailRows({ messages: [{ subject: "a", sender: "hpk@m42.com", date: h(5) }, { subject: "a", sender: "hpk@m42.com", date: h(5) }, { subject: "b", sender: "hpk@m42.com", date: h(5) }] }, "hpk@m42.com"),
    ])
    expect(rows).toHaveLength(2)
  })

  test("merged result is newest first", () => {
    const rows = mergeLeadMail([leadMailRows(newBridge([
      { subject: "old", sender: "hpk@m42.com", date_sent: h(100), message_id: "1", direction: "inbound" },
      { subject: "new", sender: "hpk@m42.com", date_sent: h(1), message_id: "2", direction: "inbound" },
    ]), "hpk@m42.com")])
    expect(rows.map((r) => r.subject)).toEqual(["new", "old"])
  })
})

describe("fetchLeadMail — participant= first, honest about older bridges", () => {
  test("asks for participant=, not from= (from= hides every outbound message)", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: newBridge([]) }))
    await fetchLeadMail(["hpk@m42.com"], { days: 30, limit: 50 }, fn)
    expect(calls[0]).toContain("participant=hpk%40m42.com")
    expect(calls[0]).not.toContain("from=")
  })

  test("both directions come back, deduped across addresses", async () => {
    const { fn } = fakeFetch(() => ({
      status: 200,
      body: newBridge([
        { subject: "Iris demo", sender: "hpk@m42.com", date_sent: h(80), direction: "inbound", message_id: "1" },
        { subject: "Re: Iris demo", sender: "alex@freelabel.net", date_sent: h(2), direction: "outbound", message_id: "2" },
      ]),
    }))
    const r = await fetchLeadMail(["hpk@m42.com", "HPK@M42.COM"], { days: 30, limit: 50 }, fn)
    expect(r.messages.map((m) => m.direction)).toEqual(["outbound", "inbound"])
    expect(r.outboundBlind).toBe(false)
    expect(r.errors).toEqual([])
  })

  test("an older bridge (400 on participant-only) falls back to from= and SAYS outbound is not covered", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.includes("participant=")
        ? { status: 400, body: { error: "from (or subject) query param is required" } }
        : { status: 200, body: { emails: [{ subject: "x", sender: "hpk@m42.com", date_sent: h(3) }] } },
    )
    const r = await fetchLeadMail(["hpk@m42.com"], { days: 30, limit: 50 }, fn)
    expect(calls.some((c) => c.includes("from=hpk%40m42.com"))).toBe(true)
    expect(r.messages).toHaveLength(1)
    expect(r.outboundBlind).toBe(true)
  })

  test("a bridge failure is an error, never an empty mailbox", async () => {
    const { fn } = fakeFetch(() => ({ status: 503, body: { error: "the iris daemon has no Full Disk Access" } }))
    const r = await fetchLeadMail(["hpk@m42.com"], { days: 30, limit: 50 }, fn)
    expect(r.messages).toEqual([])
    expect(r.errors[0]).toContain("Full Disk Access")
  })

  test("a network failure is an error too", async () => {
    const r = await fetchLeadMail(["hpk@m42.com"], { days: 30, limit: 50 }, async () => {
      throw new Error("Unable to connect")
    })
    expect(r.errors[0]).toContain("Unable to connect")
  })

  test("no addresses → nothing fetched, no error", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: newBridge([]) }))
    const r = await fetchLeadMail(["", "  "], { days: 30, limit: 50 }, fn)
    expect(calls).toHaveLength(0)
    expect(r.messages).toEqual([])
  })
})

describe("unanswered inbound — say it, don't hide it behind INSUFFICIENT DATA", () => {
  const msg = (hoursAgo: number, isOutbound: boolean | "other") => ({
    date: h(hoursAgo),
    isOutbound: isOutbound === true,
    direction: isOutbound === "other" ? ("other" as const) : isOutbound ? ("outbound" as const) : ("inbound" as const),
  })

  test("their message is last and older than 48h → unanswered, with the count of the run", () => {
    const u = unansweredInbound([msg(200, true), msg(150, false), msg(100, false), msg(60, false)], NOW)
    expect(u).not.toBeNull()
    expect(u!.count).toBe(3)
    expect(Math.round(u!.ageHours)).toBe(60)
    expect(u!.since).toBe(h(150))
  })

  test("their message is last but fresh (<48h) → not flagged yet", () => {
    expect(unansweredInbound([msg(100, true), msg(10, false)], NOW)).toBeNull()
  })

  test("we replied after them → nothing to flag", () => {
    expect(unansweredInbound([msg(100, false), msg(90, false), msg(5, true)], NOW)).toBeNull()
  })

  test("a third-party message on the thread is not a reply", () => {
    const u = unansweredInbound([msg(100, false), msg(80, "other")], NOW)
    expect(u?.count).toBe(1)
  })

  test("only inbound, ever → flagged", () => {
    expect(unansweredInbound([msg(72, false)], NOW)?.count).toBe(1)
  })

  test("empty → null", () => {
    expect(unansweredInbound([], NOW)).toBeNull()
  })
})

describe("ledger items — one id per physical message, real direction", () => {
  test("outbound mail is filed as outbound, from me, with the same id from every mailbox copy", () => {
    const rows = leadMailRows(newBridge([
      { subject: "Re: demo", sender: "alex@freelabel.net", date_sent: h(5), direction: "outbound", message_id: "333", to: ["hpk@m42.com"], cc: ["dc@m42.com"] },
    ]), "hpk@m42.com")
    const items = appleMailLedgerItems(rows, "hpk@m42.com", "comms_sync_task")
    expect(items[0].direction).toBe("outbound")
    expect(items[0].from_identifier).toBe("alex@freelabel.net")
    expect(items[0].metadata.cc).toEqual(["dc@m42.com"])
    expect(items[0].external_message_id).toBe(mailExternalId(rows[0], "hpk@m42.com"))
  })

  test("the id formula matches what `atlas:comms ingest` already writes (no duplicate rows on rerun)", () => {
    const row = leadMailRows(newBridge([{ subject: "s", sender: "HPK@m42.com", date_sent: "2026-10-19T03:13:36.000Z" }]), "hpk@m42.com")[0]
    expect(mailExternalId(row, "hpk@m42.com")).toBe("mailenv_hpk@m42.com_2026-10-19T03:13:36.000Z_s")
  })

  test("third-party thread mail is not filed as the lead's inbound", () => {
    const rows = leadMailRows(newBridge([{ subject: "x", sender: "dave@c.io", date_sent: h(5), direction: "other" }]), "hpk@m42.com")
    expect(appleMailLedgerItems(rows, "hpk@m42.com", "t")).toEqual([])
  })
})
