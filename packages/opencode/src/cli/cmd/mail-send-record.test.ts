import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { composeOutgoing } from "./mail-compose"
import { bridgeTransport, gmailTransport, envelopeFromGmail, planLeads, sendAndLog, type LogSink } from "./mail-send-flow"
import { decideLeadMatch, type LeadResolution } from "./comms-send"
import { collectArgs, mailComposeOptions, needsComposedSend } from "./platform-mail"

/**
 * #184795 / #183515 / #181928 — `iris mail send --from/--cc/--attachment` sent the email and the
 * record of it said nothing about the from address or the files. Every outside party is a fake:
 * nothing here can reach Mail.app, Gmail or the API.
 */

const ME = "alex@sender.example"
const CLIENT = "client@lead.example"
const COLLEAGUE = "colleague@other.example"
const LEADS: Record<string, any[]> = { [CLIENT]: [{ id: 28363, name: "Client", email: CLIENT }] }
const resolve = async (a: string): Promise<LeadResolution> => decideLeadMatch(LEADS[a.toLowerCase()] ?? [], a)

function fakeBridge(send: { status: number; body: any } = { status: 200, body: { ok: true, mode: "sent" } }) {
  const calls: any[] = []
  const fetch = async (path: string, init?: any) => {
    calls.push({ path, init })
    return new Response(JSON.stringify(path === "/api/mail/send" ? send.body : { ok: true }), {
      status: path === "/api/mail/send" ? send.status : 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  return { fetch, sends: () => calls.filter((c) => c.path === "/api/mail/send") }
}

function fakeLog(fail = false) {
  const rows: any[] = []
  const spooled: any[] = []
  const sink: LogSink = {
    post: async (body) => {
      rows.push(body)
      if (fail) return { status: 500, payload: { error: "boom" } }
      return { status: 201, payload: { data: { record: { id: 1, lead_id: body.lead_id } } } }
    },
    spool: async (e) => (spooled.push(e), "/tmp/spool.jsonl"),
  }
  return { sink, rows, spooled }
}

const deps = (transport: any, log: LogSink) => ({ transport, log, now: () => "2026-10-30T12:00:00.000Z", groupId: "grp_rec01", origin: "iris mail send" })

function mail(over: Record<string, any> = {}) {
  const b = composeOutgoing({ to: [CLIENT], subject: "The toolkit", body: "Deck attached.", ...over })
  if (!b.ok) throw new Error(b.error)
  return b.mail
}

describe("a successful send records exactly one outbound message, with what was actually sent", () => {
  test("--from + --cc + --attachment over the bridge: one row, from/to/cc/subject/files all on it", async () => {
    const m = mail({ from: ME, cc: [COLLEAGUE], attachments: ["/Users/alex/Desktop/deck.pdf", "/tmp/rates.xlsx"] })
    const bridge = fakeBridge()
    const log = fakeLog()
    const r = await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(bridge.fetch as any), log.sink))

    expect(r.sent).toBe(true)
    expect(bridge.sends()).toHaveLength(1)
    expect(log.rows).toHaveLength(1)
    const row = log.rows[0]
    expect(row.lead_id).toBe(28363)
    expect(row.direction).toBe("outbound")
    expect(row.channel).toBe("apple_mail")
    expect(row.subject).toBe("The toolkit")
    expect(row.from_identifier).toBe(ME)
    expect(row.to_identifiers).toEqual([CLIENT])
    expect(row.metadata.from).toBe(ME)
    expect(row.metadata.cc_all).toEqual([COLLEAGUE])
    expect(row.metadata.cc).toEqual([COLLEAGUE])
    expect(row.metadata.attachments).toEqual(["deck.pdf", "rates.xlsx"])
    expect(row.metadata.provider).toBe("apple_mail")
    expect(log.spooled).toEqual([])
  })

  test("--from alone is recorded", async () => {
    const m = mail({ from: ME })
    const log = fakeLog()
    await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0].from_identifier).toBe(ME)
  })

  test("--attachment alone is recorded by file name, never by local path", async () => {
    const m = mail({ attachments: ["/Users/alex/private/deck.pdf"] })
    const log = fakeLog()
    await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0].metadata.attachments).toEqual(["deck.pdf"])
    expect(JSON.stringify(log.rows[0])).not.toContain("/Users/alex/private")
  })

  test("no --from: the sender is unknown and is not guessed", async () => {
    const m = mail({ cc: [COLLEAGUE] })
    const log = fakeLog()
    await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(log.rows).toHaveLength(1)
    expect("from_identifier" in log.rows[0]).toBe(false)
    expect("from" in log.rows[0].metadata).toBe(false)
  })

  test("a provider message id the bridge returns is kept", async () => {
    const m = mail({ from: ME })
    const log = fakeLog()
    const bridge = fakeBridge({ status: 200, body: { ok: true, mode: "sent", message_id: "<abc@sender.example>" } })
    await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(bridge.fetch as any), log.sink))
    expect(log.rows[0].metadata.provider_message_id).toBe("<abc@sender.example>")
  })

  test("Gmail: the connected mailbox is the from, and Gmail's message/thread ids are recorded", async () => {
    const orig = envelopeFromGmail({
      id: "18c2f0a1b2c3d4e5",
      thread_id: "18c2f0a1b2c3d4e0",
      from: CLIENT,
      to: ME,
      subject: "Toolkit?",
      message_id_header: "<q@lead.example>",
    })
    const b = composeOutgoing({ to: [CLIENT], cc: [COLLEAGUE], body: "Here it is.", original: orig })
    if (!b.ok) throw new Error(b.error)
    const exec = async () => ({ success: true, message_id: "19a0000000000001", thread_id: "18c2f0a1b2c3d4e0" })
    const log = fakeLog()
    const r = await sendAndLog(b.mail, await planLeads(b.mail, resolve), deps(gmailTransport(exec, () => ME), log.sink))
    expect(r.sent).toBe(true)
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0].channel).toBe("gmail")
    expect(log.rows[0].from_identifier).toBe(ME)
    expect(log.rows[0].metadata.provider_message_id).toBe("19a0000000000001")
    expect(log.rows[0].metadata.provider_thread_id).toBe("18c2f0a1b2c3d4e0")
    expect(log.rows[0].metadata.cc_all).toEqual([COLLEAGUE])
  })
})

describe("a failed send records nothing", () => {
  test("bridge refuses a --from with no Mail.app account (422): no row, no spool", async () => {
    const m = mail({ from: ME, cc: [COLLEAGUE], attachments: ["/tmp/deck.pdf"] })
    const log = fakeLog()
    const bridge = fakeBridge({ status: 422, body: { error: "Mail.app has no account" } })
    const r = await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(bridge.fetch as any), log.sink))
    expect(r.sent).toBe(false)
    expect(log.rows).toEqual([])
    expect(log.spooled).toEqual([])
  })

  test("Gmail cannot carry --from or attachments: refused, nothing recorded", async () => {
    for (const over of [{ from: ME }, { attachments: ["/tmp/deck.pdf"] }]) {
      const m = mail({ ...over, draft: true })
      const log = fakeLog()
      const r = await sendAndLog(m, await planLeads(m, resolve), deps(gmailTransport(async () => ({ success: true })), log.sink))
      expect(r.sent).toBe(false)
      expect(log.rows).toEqual([])
    }
  })
})

describe("a send that could not be recorded keeps the whole record for backfill", () => {
  test("the log write fails: the spool holds the exact row (from, cc, files, group id)", async () => {
    const m = mail({ from: ME, cc: [COLLEAGUE], attachments: ["/tmp/deck.pdf"] })
    const log = fakeLog(true)
    const r = await sendAndLog(m, await planLeads(m, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(r.sent).toBe(true)
    expect(log.spooled).toHaveLength(1)
    const e = log.spooled[0]
    expect(e.from).toBe(ME)
    expect(e.payload).toEqual(log.rows[0])
    expect(e.payload.message_group_id).toBe("grp_rec01")
    expect(e.payload.metadata.attachments).toEqual(["deck.pdf"])
  })

  test("--force with no lead: the spooled row has everything but a lead", async () => {
    const b = composeOutgoing({ to: [COLLEAGUE], subject: "s", body: "b", from: ME, attachments: ["/tmp/deck.pdf"] })
    if (!b.ok) throw new Error(b.error)
    const log = fakeLog()
    await sendAndLog(b.mail, await planLeads(b.mail, resolve), deps(bridgeTransport(fakeBridge().fetch as any), log.sink))
    expect(log.rows).toEqual([])
    expect(log.spooled).toHaveLength(1)
    const p = log.spooled[0].payload
    expect("lead_id" in p).toBe(false)
    expect(p.from_identifier).toBe(ME)
    expect(p.to_identifiers).toEqual([COLLEAGUE])
    expect(p.metadata.attachments).toEqual(["deck.pdf"])
    expect(p.metadata.recipients).toEqual([])
  })
})

describe("routing: --from, --cc and --attachment take the path that logs", () => {
  const parse = (argv: string[]) => collectArgs(mailComposeOptions(yargs([]).exitProcess(false)).parseSync(argv), { positional: [CLIENT] })
  test("each flag alone leaves the router for the composed (bridge + log) path", () => {
    for (const flag of [["--from", ME], ["--cc", COLLEAGUE], ["--attachment", "/tmp/deck.pdf"]]) {
      expect(needsComposedSend(parse(["-s", "s", "-b", "b", ...flag]))).toBe(true)
    }
  })
  test("a plain one-To send stays on the comms router", () => {
    expect(needsComposedSend(parse(["-s", "s", "-b", "b"]))).toBe(false)
  })
})
