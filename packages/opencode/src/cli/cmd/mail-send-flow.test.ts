import { describe, expect, test } from "bun:test"
import { composeOutgoing, replyRecipients, splitAddresses, toBridgePayload, isGmailId, type MailEnvelope } from "./mail-compose"
import { bridgeTransport, gmailTransport, gmailReplyMismatch, planLeads, planRefusal, sendAndLog, lookupOnMac, envelopeFromGmail, type LogSink } from "./mail-send-flow"
import { decideLeadMatch, type LeadResolution } from "./comms-send"
import { unloggedSent } from "./comms-mail-applescript"

/**
 * #191605. Every outside party is a fake: the bridge (Mail.app), Gmail, the leads API and the comms
 * log. What is under test is the message that would leave — its recipients and threading headers —
 * and the log rows that would be written for it.
 */

// The Vanguard thread (task #191602, lead #15743), with stand-in addresses.
const ME = "amayo@mypathwaysai.com"
const RICHARD = "richard@vanguard.example"
const SEAN = "sean@vanguard.example"
const JUNAID = "junaid@vanguard.example"
const ROBYN = "robyn@vanguard.example"
const TERRY = "terry@vanguard.example"

const ORIGINAL: MailEnvelope = {
  message_id: "CAF1234abc@mail.gmail.com",
  subject: "Phase 1 kickoff",
  from: RICHARD,
  reply_to: null,
  to: [ME, SEAN],
  cc: [JUNAID, ROBYN, TERRY],
  references: ["root-1@vanguard.example"],
  account: "Pathways",
  mailbox: "INBOX",
}

/** A leads API that knows Richard (#15743) and Sean (#15744); nobody else is a lead. */
const LEADS: Record<string, any[]> = {
  [RICHARD]: [{ id: 15743, name: "Richard", email: RICHARD }],
  [SEAN]: [{ id: 15744, name: "Sean", email: SEAN }],
}
const resolve = async (a: string): Promise<LeadResolution> => decideLeadMatch(LEADS[a.toLowerCase()] ?? [], a)

/** A bridge that records what it was asked to send and answers like the new iris-daemon. */
function fakeBridge(opts: { caps?: Record<string, unknown> | null; send?: { status: number; body: any } } = {}) {
  const calls: Array<{ path: string; init?: any }> = []
  const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const fetch = async (path: string, init?: any) => {
    calls.push({ path, init })
    if (path === "/api/mail/capabilities") return opts.caps === null ? json(404, { error: "Not found" }) : json(200, opts.caps ?? { ok: true, multi_to: true, bcc: true, reply: true })
    if (path === "/api/mail/send") return json(opts.send?.status ?? 200, opts.send?.body ?? { ok: true, mode: init && JSON.parse(init.body).draft ? "draft" : "sent" })
    if (path.startsWith("/api/mail/message")) return json(200, { ok: true, ...ORIGINAL, to: ORIGINAL.to, cc: ORIGINAL.cc })
    return json(404, {})
  }
  const sent = () => calls.filter((c) => c.path === "/api/mail/send").map((c) => JSON.parse(c.init.body))
  return { fetch, calls, sent }
}

/** A comms log that records every row and answers 201 with the row on the right lead. */
function fakeLog(fail: number[] = []) {
  const rows: any[] = []
  const spooled: any[] = []
  const sink: LogSink = {
    post: async (body) => {
      rows.push(body)
      if (fail.includes(Number(body.lead_id))) return { status: 500, payload: { error: "boom" } }
      return { status: 201, payload: { data: { record: { id: 9000 + rows.length, lead_id: body.lead_id } } } }
    },
    spool: async (e) => {
      spooled.push(e)
      return "/tmp/spool.jsonl"
    },
  }
  return { sink, rows, spooled }
}

const deps = (transport: any, log: LogSink) => ({ transport, log, now: () => "2026-10-28T17:00:00.000Z", groupId: "grp_test01", origin: "iris mail send" })

describe("the acceptance send: --to a --to b --cc c --cc d --cc e --from … --reply-to <id>", () => {
  const built = composeOutgoing({
    to: splitAddresses([RICHARD], [SEAN]),
    cc: splitAddresses([JUNAID], [ROBYN], [TERRY]),
    from: ME,
    body: "Thanks all — notes below.",
    original: ORIGINAL,
  })
  if (!built.ok) throw new Error(built.error)
  const m = built.mail

  test("the message that comes out has all five recipients and threads on the original", () => {
    expect(m.to).toEqual([RICHARD, SEAN])
    expect(m.cc).toEqual([JUNAID, ROBYN, TERRY])
    expect(m.headers["In-Reply-To"]).toBe("<CAF1234abc@mail.gmail.com>")
    expect(m.headers.References).toBe("<root-1@vanguard.example> <CAF1234abc@mail.gmail.com>")
    expect(m.subject).toBe("Re: Phase 1 kickoff")
  })

  test("one send to the bridge carries all five and the reply fields, after a capability check", async () => {
    const bridge = fakeBridge()
    const log = fakeLog()
    const plan = await planLeads(m, resolve)
    const r = await sendAndLog(m, plan, deps(bridgeTransport(bridge.fetch as any), log.sink))

    expect(r.sent).toBe(true)
    expect(bridge.calls.map((c) => c.path)).toEqual(["/api/mail/capabilities", "/api/mail/send"])
    expect(bridge.sent()).toEqual([
      {
        to_email: [RICHARD, SEAN],
        cc_email: [JUNAID, ROBYN, TERRY],
        from_email: ME,
        subject: "Re: Phase 1 kickoff",
        body_text: "Thanks all — notes below.",
        in_reply_to: "<CAF1234abc@mail.gmail.com>",
        reply_account: "Pathways",
        reply_mailbox: "INBOX",
      },
    ])
  })

  test("it is logged ONCE per matching lead, as one message, with the non-lead CCs recorded", async () => {
    const log = fakeLog()
    const plan = await planLeads(m, resolve)
    expect(plan.leads.map((l) => l.lead_id)).toEqual([15743, 15744])
    expect(plan.nonLeads).toEqual([JUNAID, ROBYN, TERRY])

    const r = await sendAndLog(m, plan, deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(r.results.map((x) => [x.lead_id, x.outcome])).toEqual([
      [15743, "logged"],
      [15744, "logged"],
    ])
    expect(log.rows).toHaveLength(2)
    for (const row of log.rows) {
      expect(row.channel).toBe("apple_mail")
      expect(row.direction).toBe("outbound")
      expect(row.message_group_id).toBe("grp_test01")
      expect(row.sent_at).toBe("2026-10-28T17:00:00.000Z")
      expect(row.to_identifiers).toEqual([RICHARD, SEAN])
      expect(row.metadata.cc).toEqual([JUNAID, ROBYN, TERRY])
      expect(row.metadata.in_reply_to).toBe("<CAF1234abc@mail.gmail.com>")
      expect(row.metadata.recipients.map((x: any) => x.lead_id)).toEqual([15743, 15744])
      expect(row.metadata.logged_via).toBe("iris mail send")
    }
    expect(log.spooled).toEqual([])
  })
})

describe("iris mail reply <id> --all — recipients from the original, minus yourself", () => {
  test("reply-all: To = sender + original To, CC = original CC; me removed", () => {
    expect(replyRecipients(ORIGINAL, [ME], true)).toEqual({ to: [RICHARD, SEAN], cc: [JUNAID, ROBYN, TERRY] })
  })

  test("plain reply: only the sender", () => {
    expect(replyRecipients(ORIGINAL, [ME], false)).toEqual({ to: [RICHARD], cc: [] })
  })

  test("Reply-To wins over From", () => {
    expect(replyRecipients({ ...ORIGINAL, reply_to: "list@vanguard.example" }, [ME], false).to).toEqual(["list@vanguard.example"])
  })

  test("yourself is removed case-insensitively, from To and CC, under every address you send as", () => {
    const o = { ...ORIGINAL, to: ["AMAYO@MyPathwaysAI.com", SEAN], cc: [JUNAID, "alex@freelabel.example"] }
    expect(replyRecipients(o, [ME, "alex@freelabel.example"], true)).toEqual({ to: [RICHARD, SEAN], cc: [JUNAID] })
  })

  test("replying to your own sent message goes to its To, not back to you", () => {
    const mine = { ...ORIGINAL, from: ME, to: [RICHARD], cc: [SEAN] }
    expect(replyRecipients(mine, [ME], true)).toEqual({ to: [RICHARD], cc: [SEAN] })
  })

  test("a plain reply to your own sent message goes to whoever you sent it to", () => {
    expect(replyRecipients({ ...ORIGINAL, from: ME, to: [RICHARD, SEAN] }, [ME], false)).toEqual({ to: [RICHARD, SEAN], cc: [] })
  })

  test("someone on both To and CC appears once", () => {
    expect(replyRecipients({ ...ORIGINAL, cc: [SEAN, JUNAID] }, [ME], true)).toEqual({ to: [RICHARD, SEAN], cc: [JUNAID] })
  })

  test("the original is read from the bridge by Message-ID", async () => {
    const bridge = fakeBridge()
    const env = await lookupOnMac(bridge.fetch as any, "<CAF1234abc@mail.gmail.com>")
    expect(bridge.calls[0].path).toBe("/api/mail/message?id=CAF1234abc%40mail.gmail.com")
    expect(env).toMatchObject({ message_id: "CAF1234abc@mail.gmail.com", account: "Pathways", mailbox: "INBOX", from: RICHARD })
  })
})

describe("the bridge transport refuses rather than sending less than was asked", () => {
  const multi = composeOutgoing({ to: [RICHARD, SEAN], subject: "Hi", body: "b" })
  if (!multi.ok) throw new Error(multi.error)

  test("an older bridge (no capabilities endpoint) gets NOTHING sent to it", async () => {
    const bridge = fakeBridge({ caps: null })
    const log = fakeLog()
    const r = await sendAndLog(multi.mail, await planLeads(multi.mail, resolve), deps(bridgeTransport(bridge.fetch as any), log.sink))
    expect(r.sent).toBe(false)
    expect(r.error).toContain("multi_to")
    expect(bridge.sent()).toEqual([])
    expect(log.rows).toEqual([])
  })

  test("a bridge without reply support is refused for a reply", async () => {
    const built = composeOutgoing({ to: [RICHARD], body: "b", original: ORIGINAL })
    if (!built.ok) throw new Error(built.error)
    const bridge = fakeBridge({ caps: { ok: true, multi_to: true, bcc: true } })
    const r = await bridgeTransport(bridge.fetch as any).deliver(built.mail)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("reply")
    expect(bridge.sent()).toEqual([])
  })

  test("a plain one-To message needs no capability check (works with an old bridge)", async () => {
    const one = composeOutgoing({ to: [RICHARD], cc: [JUNAID], subject: "Hi", body: "b" })
    if (!one.ok) throw new Error(one.error)
    const bridge = fakeBridge({ caps: null })
    expect((await bridgeTransport(bridge.fetch as any).deliver(one.mail)).ok).toBe(true)
    expect(bridge.sent()[0].to_email).toBe(RICHARD) // a plain string, the old contract
  })

  test("a bridge error is not sent, not logged", async () => {
    const log = fakeLog()
    const bridge = fakeBridge({ send: { status: 422, body: { error: "no account" } } })
    const r = await sendAndLog(multi.mail, await planLeads(multi.mail, resolve), deps(bridgeTransport(bridge.fetch as any), log.sink))
    expect(r.sent).toBe(false)
    expect(log.rows).toEqual([])
  })

  test("a draft is not logged — nobody has received it", async () => {
    const d = composeOutgoing({ to: [RICHARD, SEAN], subject: "Hi", body: "b", draft: true })
    if (!d.ok) throw new Error(d.error)
    const log = fakeLog()
    const r = await sendAndLog(d.mail, await planLeads(d.mail, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(r.drafted).toBe(true)
    expect(log.rows).toEqual([])
  })
})

describe("a copy that does not land is spooled for iris mail audit", () => {
  test("one lead's log fails: the other is logged, the failed one is spooled with its lead", async () => {
    const built = composeOutgoing({ to: [RICHARD, SEAN], subject: "Hi", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const log = fakeLog([15744])
    const r = await sendAndLog(built.mail, await planLeads(built.mail, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(r.results.map((x) => x.outcome)).toEqual(["logged", "failed"])
    expect(log.spooled).toHaveLength(1)
    expect(log.spooled[0]).toMatchObject({ leadId: 15744, channel: "apple_mail", subject: "Hi", to: `${RICHARD}, ${SEAN}` })
  })

  test("--force with no lead: sent, and spooled unattributed", async () => {
    const built = composeOutgoing({ to: [JUNAID], subject: "Hi", body: "b", bcc: [] })
    if (!built.ok) throw new Error(built.error)
    const log = fakeLog()
    const r = await sendAndLog(built.mail, await planLeads(built.mail, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(r.sent).toBe(true)
    expect(log.rows).toEqual([])
    expect(log.spooled).toHaveLength(1)
    expect(log.spooled[0].leadId).toBeUndefined()
  })
})

describe("who is it for — every address, before sending", () => {
  const twins = async (a: string) =>
    decideLeadMatch(a === SEAN ? [{ id: 1, name: "Sean A", email: SEAN }, { id: 2, name: "Sean B", email: SEAN }] : LEADS[a] ?? [], a)

  test("a tie on any address refuses the whole send; --force does not break it", async () => {
    const built = composeOutgoing({ to: [RICHARD, SEAN], subject: "Hi", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const plan = await planLeads(built.mail, twins)
    expect(planRefusal(plan, true)).toContain("--lead 1")
  })

  test("--lead breaks the tie for the address it is a candidate of", async () => {
    const built = composeOutgoing({ to: [RICHARD, SEAN], subject: "Hi", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const plan = await planLeads(built.mail, twins, [2])
    expect(planRefusal(plan, false)).toBeNull()
    expect(plan.leads.map((l) => [l.lead_id, l.email])).toEqual([
      [2, SEAN],
      [15743, RICHARD],
    ])
  })

  test("no lead at all is refused unless --force", async () => {
    const built = composeOutgoing({ to: [JUNAID, ROBYN], subject: "Hi", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const plan = await planLeads(built.mail, resolve)
    expect(planRefusal(plan, false)).toContain("no recipient is a lead")
    expect(planRefusal(plan, true)).toBeNull()
  })

  test("a lead lookup that failed is not 'not a lead'", async () => {
    const built = composeOutgoing({ to: [RICHARD, JUNAID], subject: "Hi", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const flaky = async (a: string): Promise<LeadResolution> => (a === JUNAID ? { ok: false, matches: [], reason: "error", error: "leads API returned 503" } : resolve(a))
    expect(planRefusal(await planLeads(built.mail, flaky), false)).toContain("could not check")
  })

  test("a BCC'd lead is logged too — and its row says who it actually went To", async () => {
    const built = composeOutgoing({ to: [JUNAID], bcc: [SEAN], subject: "Hi", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const plan = await planLeads(built.mail, resolve)
    expect(plan.leads.map((l) => l.lead_id)).toEqual([15744])
    const log = fakeLog()
    await sendAndLog(built.mail, plan, deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(log.rows.map((r) => [r.lead_id, r.to_identifiers, r.metadata.bcc])).toEqual([[15744, [JUNAID], [SEAN]]])
  })
})

describe("composing", () => {
  test("repeatable and comma-separated values, display names stripped, duplicates dropped", () => {
    expect(splitAddresses([`${RICHARD}, "Sean, S." <${SEAN}>`], [RICHARD.toUpperCase()])).toEqual([RICHARD, SEAN])
  })

  test("To beats CC beats BCC", () => {
    const r = composeOutgoing({ to: [RICHARD], cc: [RICHARD, SEAN], bcc: [SEAN, TERRY], subject: "s", body: "b" })
    expect(r.ok && [r.mail.to, r.mail.cc, r.mail.bcc]).toEqual([[RICHARD], [SEAN], [TERRY]])
  })

  test("refuses a non-address, an empty body, a missing subject on a new message", () => {
    expect(composeOutgoing({ to: ["Richard"], subject: "s", body: "b" })).toEqual({ ok: false, error: "not an email address: Richard" })
    expect(composeOutgoing({ to: [RICHARD], subject: "s", body: "  " }).ok).toBe(false)
    expect(composeOutgoing({ to: [RICHARD], body: "b" }).ok).toBe(false)
  })

  test("a subject already starting Re: is not doubled", () => {
    const r = composeOutgoing({ to: [RICHARD], body: "b", original: { ...ORIGINAL, subject: "RE: Phase 1" } })
    expect(r.ok && r.mail.subject).toBe("RE: Phase 1")
  })

  test("BCC reaches the bridge as bcc_email", () => {
    const r = composeOutgoing({ to: [RICHARD], bcc: [TERRY], subject: "s", body: "b" })
    if (!r.ok) throw new Error(r.error)
    expect(toBridgePayload(r.mail).bcc_email).toEqual([TERRY])
  })

  test("Gmail ids and Message-IDs are told apart", () => {
    expect(isGmailId("18c2f0a1b2c3d4e5")).toBe(true)
    expect(isGmailId("<CAF1234abc@mail.gmail.com>")).toBe(false)
  })
})

describe("the Gmail route (fake server)", () => {
  const gmailOrig = envelopeFromGmail({
    id: "18c2f0a1b2c3d4e5",
    thread_id: "18c2f0a1b2c3d4e0",
    from: `Richard <${RICHARD}>`,
    to: `${ME}, ${SEAN}`,
    cc: `${JUNAID}, ${ROBYN}, ${TERRY}`,
    reply_to: "",
    subject: "Phase 1 kickoff",
    message_id_header: "<CAF1234abc@mail.gmail.com>",
    references: "<root-1@vanguard.example>",
  })

  test("a reply-all goes to reply_to_email: To is the sender, everyone else CC", async () => {
    const calls: any[] = []
    const exec = async (action: string, params: any) => (calls.push({ action, params }), { success: true, id: "x" })
    const built = composeOutgoing({ to: [RICHARD, SEAN], cc: [JUNAID, ROBYN, TERRY], body: "b", original: gmailOrig })
    if (!built.ok) throw new Error(built.error)
    expect(gmailReplyMismatch(built.mail, gmailOrig)).toBeNull()
    const log = fakeLog()
    const r = await sendAndLog(built.mail, await planLeads(built.mail, resolve), { ...deps(gmailTransport(exec), log.sink) })
    expect(r.sent).toBe(true)
    expect(calls).toEqual([
      { action: "reply_to_email", params: { message_id: "18c2f0a1b2c3d4e5", body: "b", cc: `${SEAN}, ${JUNAID}, ${ROBYN}, ${TERRY}`, bcc: "" } },
    ])
    expect(log.rows.map((x) => [x.lead_id, x.channel])).toEqual([
      [15743, "gmail"],
      [15744, "gmail"],
    ])
    expect(built.mail.headers["In-Reply-To"]).toBe("<CAF1234abc@mail.gmail.com>")
  })

  test("a different first To is refused, not rewritten", () => {
    const built = composeOutgoing({ to: [SEAN], body: "b", original: gmailOrig })
    if (!built.ok) throw new Error(built.error)
    expect(gmailReplyMismatch(built.mail, gmailOrig)).toContain(RICHARD)
  })

  test("a draft goes to create_draft with the exact recipients and is not logged", async () => {
    const calls: any[] = []
    const exec = async (action: string, params: any) => (calls.push({ action, params }), { success: true, draft_id: "d1" })
    const built = composeOutgoing({ to: [RICHARD, SEAN], cc: [JUNAID], body: "b", original: gmailOrig, draft: true })
    if (!built.ok) throw new Error(built.error)
    const log = fakeLog()
    const r = await sendAndLog(built.mail, await planLeads(built.mail, resolve), deps(gmailTransport(exec), log.sink))
    expect(r.drafted).toBe(true)
    expect(calls[0]).toEqual({ action: "create_draft", params: { to: `${RICHARD}, ${SEAN}`, cc: JUNAID, bcc: "", subject: "Re: Phase 1 kickoff", body: "b", message_id: "18c2f0a1b2c3d4e5" } })
    expect(log.rows).toEqual([])
  })

  test("a new (non-reply) send is refused — the server has no Composio send", async () => {
    const built = composeOutgoing({ to: [RICHARD], subject: "s", body: "b" })
    if (!built.ok) throw new Error(built.error)
    const r = await gmailTransport(async () => ({ success: true })).deliver(built.mail)
    expect(r.ok).toBe(false)
  })
})

describe("iris mail audit --sent: a send that skipped the router is still found", () => {
  const leadOf = (a: string) => ({ [RICHARD]: 15743, [SEAN]: 15744 })[a] ?? null

  test("the raw-osascript reply-all (on no record) is reported for both leads", () => {
    const sent = [{ subject: "Re: Phase 1 kickoff", sent_at: "2026-10-28T16:00:00Z", to: [RICHARD, SEAN], cc: [JUNAID, ROBYN, TERRY], bcc: [] }]
    expect(unloggedSent(sent, leadOf, () => []).map((g) => g.missing)).toEqual([[15743, 15744]])
  })

  test("logged on one lead only → reported for the other", () => {
    const sent = [{ subject: "Re: Phase 1 kickoff", sent_at: "2026-10-28T16:00:00Z", to: [RICHARD, SEAN], cc: [], bcc: [] }]
    const ledger = (id: number) => (id === 15743 ? [{ direction: "outbound", subject: "Re: Phase 1 kickoff", sent_at: "2026-10-28T16:00:40Z" }] : [])
    expect(unloggedSent(sent, leadOf, ledger)).toEqual([{ item: sent[0], missing: [15744], logged: [15743] }])
  })

  test("mail to nobody's lead is not the ledger's business", () => {
    expect(unloggedSent([{ subject: "lunch", sent_at: "2026-10-28T16:00:00Z", to: ["friend@x.example"], cc: [], bcc: [] }], leadOf, () => [])).toEqual([])
  })
})
