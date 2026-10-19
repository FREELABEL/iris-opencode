import { afterEach, describe, expect, test } from "bun:test"
import { contactSources, type ContactQuery } from "./pulse-contact-script"

// #189941 — the pulse's Apple Mail channel, against the bridge's REAL response shape.
// Before the fix this source read `d.messages`, so it rendered "Apple Mail (0)" for a lead
// with 8 messages in [Gmail]/All Mail, and asked from= so outbound could never appear.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const q = (over: Partial<ContactQuery> = {}): ContactQuery => ({
  leadId: 29285,
  lead: {},
  name: "Haripurkh Khalsa",
  email: "hpk@m42.com",
  phone: "",
  allEmails: ["hpk@m42.com"],
  days: 30,
  msgLimit: 50,
  timeoutMs: 5000,
  ...over,
})

const ALL = "imap://E5D72C1C/%5BGmail%5D/All%20Mail"
const bridge = {
  emails: [
    { subject: "Re: Iris demo", sender: "alex@freelabel.net", date_sent: "2026-10-19T14:46:11.000Z", mailbox: ALL, mailboxes: [ALL], message_id: "3", direction: "outbound", role: "to", from_me: true },
    { subject: "Iris demo", sender: "hpk@m42.com", date_sent: "2026-10-19T03:13:36.000Z", mailbox: ALL, mailboxes: [ALL, "imap://E5D72C1C/INBOX"], message_id: "1", direction: "inbound", role: "sender" },
    { subject: "Following up", sender: "hpk@m42.com", date_sent: "2026-10-15T14:13:22.000Z", mailbox: ALL, mailboxes: [ALL], message_id: "2", direction: "inbound", role: "sender" },
  ],
  count: 3,
  source: "envelope-index",
  capabilities: ["participant", "body"],
}

describe("pulse Apple Mail source", () => {
  test("reads `emails` — both directions, from All Mail", async () => {
    const seen: string[] = []
    globalThis.fetch = (async (url: any) => {
      seen.push(String(url))
      return new Response(JSON.stringify(bridge), { status: 200 })
    }) as any
    const r = await contactSources.apple_mail.read(q())
    const ch = r.channels[0]
    expect(ch.name).toBe("Apple Mail")
    expect(ch.error).toBeUndefined()
    expect(ch.messages).toHaveLength(3)
    expect(ch.messages.map((m: any) => m.direction)).toEqual(["outbound", "inbound", "inbound"])
    expect(seen[0]).toContain("participant=")
  })

  test("two addresses for one lead return the same message once", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(bridge), { status: 200 })) as any
    const r = await contactSources.apple_mail.read(q({ allEmails: ["hpk@m42.com", "HPK+crm@m42.com"] }))
    expect(r.channels[0].messages).toHaveLength(3)
  })

  test("a bridge failure is shown as an error, not 'No messages'", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "no Full Disk Access" }), { status: 503 })) as any
    const r = await contactSources.apple_mail.read(q())
    expect(r.channels[0].error).toContain("Full Disk Access")
    expect(r.measured).toBe(false)
  })

  test("an older bridge that cannot see outbound says so on the channel label", async () => {
    globalThis.fetch = (async (url: any) =>
      String(url).includes("participant=")
        ? new Response(JSON.stringify({ error: "from (or subject) query param is required" }), { status: 400 })
        : new Response(JSON.stringify({ emails: [bridge.emails[1]] }), { status: 200 })) as any
    const r = await contactSources.apple_mail.read(q())
    expect(r.channels[0].messages).toHaveLength(1)
    expect(r.channels[0].label).toContain("inbound only")
  })
})
