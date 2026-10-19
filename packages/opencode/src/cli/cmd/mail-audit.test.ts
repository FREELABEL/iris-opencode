import { describe, expect, test } from "bun:test"
import { parseCcList, routedCcConfirmed, reconcileSent, subjectKey, auditSentMail, type SentMail } from "./mail-audit"

// #189942 — measured 2026-10-19: three emails to leads 29285/29284 went out of Mail.app with a CC,
// because `iris mail send --sender` refused --cc. None reached the comms ledger, and
// `iris mail audit` said "Nothing unlogged … Clean" — it only read the CLI's own spool.

describe("--cc parsing", () => {
  test("comma/space separated, trimmed, lowercased, deduped", () => {
    expect(parseCcList("DC@m42.com, hpk@m42.com dc@m42.com")).toEqual({ list: ["dc@m42.com", "hpk@m42.com"] })
  })
  test("repeated flags (yargs array) work too", () => {
    expect(parseCcList(["a@b.co", "c@d.co"])).toEqual({ list: ["a@b.co", "c@d.co"] })
  })
  test("a non-address is refused before anything is sent", () => {
    expect("error" in parseCcList("dc@m42.com, Darren")).toBe(true)
    expect("error" in parseCcList("x@y.z; DROP")).toBe(true)
  })
  test("empty → no cc", () => {
    expect(parseCcList(undefined)).toEqual({ list: [] })
    expect(parseCcList("  ")).toEqual({ list: [] })
  })
})

describe("routed --cc: never send a different email than asked for", () => {
  test("a server that echoes the cc list has applied it", () => {
    expect(routedCcConfirmed({ cc: ["dc@m42.com"] }, ["dc@m42.com"])).toBe(true)
  })
  test("a server that ignores cc (older API: validate() drops unknown keys) is NOT confirmation", () => {
    expect(routedCcConfirmed({ channel: "apple_mail", reason: "x" }, ["dc@m42.com"])).toBe(false)
  })
  test("a partial echo is not confirmation", () => {
    expect(routedCcConfirmed({ cc: ["dc@m42.com"] }, ["dc@m42.com", "hpk@m42.com"])).toBe(false)
  })
  test("case does not matter", () => {
    expect(routedCcConfirmed({ cc: ["DC@M42.com"] }, ["dc@m42.com"])).toBe(true)
  })
})

const NOW = new Date("2026-10-19T18:00:00Z")
const sent = (over: Partial<SentMail>): SentMail => ({
  message_id: "1",
  subject: "Iris demo and discussion - week of Oct 19th?",
  sender: "alex@freelabel.net",
  date: "2026-10-19T14:46:11.000Z",
  to: ["hpk@m42.com"],
  cc: [],
  ...over,
})

describe("reconcileSent — a sent message to a lead with no ledger row is reported", () => {
  const leads = new Map<string, number[]>([
    ["hpk@m42.com", [29285]],
    ["dc@m42.com", [29284]],
  ])

  test("the measured case: three sends, no ledger rows → three findings, attributed", () => {
    const out = reconcileSent(
      [
        sent({ message_id: "1" }),
        sent({ message_id: "2", subject: "Following up: Gate × IRIS next steps", to: ["dc@m42.com"], date: "2026-10-19T14:44:51.000Z" }),
        sent({ message_id: "3", date: "2026-10-19T14:23:37.000Z", cc: ["dc@m42.com"] }),
      ],
      leads,
      new Map(),
    )
    expect(out.map((u) => u.leadIds)).toEqual([[29285], [29284], [29285, 29284]])
    expect(out[2].cc).toEqual(["dc@m42.com"])
  })

  test("a ledger row with the same subject (Re:/Fwd: folded) within 36h on ANY recipient lead counts as logged", () => {
    const ledger = new Map([[29284, [{ subject: "Iris demo and discussion - week of Oct 19th?", sent_at: "2026-10-19T14:47:00Z" }]]])
    const out = reconcileSent([sent({ cc: ["dc@m42.com"] })], leads, ledger)
    expect(out).toEqual([])
  })

  test("a reply in the same thread days later is NOT matched by an older row", () => {
    const ledger = new Map([[29285, [{ subject: "Iris demo and discussion - week of Oct 19th?", sent_at: "2026-10-14T10:00:00Z" }]]])
    expect(reconcileSent([sent({})], leads, ledger)).toHaveLength(1)
  })

  test("the ledger's mailenv external id matches regardless of subject", () => {
    const m = sent({ subject: "x" })
    const ledger = new Map([[29285, [{ subject: "something else", sent_at: "2026-10-01T00:00:00Z", external_message_id: "mailenv_alex@freelabel.net_2026-10-19T14:46:11.000Z_x" }]]])
    expect(reconcileSent([m], leads, ledger)).toEqual([])
  })

  test("mail to non-leads is not a finding", () => {
    expect(reconcileSent([sent({ to: ["someone@else.com"] })], leads, new Map())).toEqual([])
  })

  test("plus-tag / uppercase recipient still resolves to the lead", () => {
    expect(reconcileSent([sent({ to: ["HPK+x@M42.com"] })], leads, new Map())[0]?.leadIds).toEqual([29285])
  })

  test("ambiguous address (two leads) is reported as ambiguous, not guessed", () => {
    const amb = new Map([["hpk@m42.com", [1, 2]]])
    const out = reconcileSent([sent({})], amb, new Map())
    expect(out[0].ambiguous).toEqual(["hpk@m42.com"])
    expect(out[0].leadIds).toEqual([])
  })

  test("subjectKey folds reply prefixes and whitespace", () => {
    expect(subjectKey("RE: Fwd:  Re:   Hello  World ")).toBe("hello world")
  })
})

describe("auditSentMail — orchestration, bounded and honest", () => {
  const bridgeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      message_id: String(i),
      subject: `s${i}`,
      sender: "alex@freelabel.net",
      date_sent: new Date(NOW.getTime() - i * 60_000).toISOString(),
      to: [i === 0 ? "hpk@m42.com" : `n${i}@x.com`],
      cc: [],
    }))

  test("asks the bridge for from_me with --days and a hard cap, and says when the cap was hit", async () => {
    const urls: string[] = []
    const r = await auditSentMail(
      { days: 14, limit: 200 },
      {
        bridge: async (path) => {
          urls.push(path)
          return new Response(JSON.stringify({ emails: bridgeRows(200), capabilities: ["from_me"] }))
        },
        resolveLead: async (addr) => (addr === "hpk@m42.com" ? [29285] : []),
        ledger: async () => [],
      },
    )
    expect(urls[0]).toContain("from_me=1")
    expect(urls[0]).toContain("days=14")
    expect(urls[0]).toContain("limit=200")
    expect(r.truncated).toBe(true)
    expect(r.unlogged.map((u) => u.leadIds)).toEqual([[29285]])
  })

  test("caps distinct recipient lookups so a huge Sent folder cannot fan out to thousands of API calls", async () => {
    let lookups = 0
    const r = await auditSentMail(
      { days: 90, limit: 200, maxLookups: 25 },
      {
        bridge: async () => new Response(JSON.stringify({ emails: bridgeRows(200), capabilities: ["from_me"] })),
        resolveLead: async () => {
          lookups++
          return []
        },
        ledger: async () => [],
      },
    )
    expect(lookups).toBe(25)
    expect(r.unresolvedAddresses).toBe(175)
  })

  test("a bridge without from_me is an error, never 'Clean'", async () => {
    const r = await auditSentMail(
      { days: 14, limit: 200 },
      {
        bridge: async () => new Response(JSON.stringify({ error: "from (or subject) query param is required" }), { status: 400 }),
        resolveLead: async () => [],
        ledger: async () => [],
      },
    )
    expect(r.error).toContain("cannot list sent mail")
  })

  test("a 200 from a bridge that does not advertise from_me is not trusted as 'what I sent'", async () => {
    const r = await auditSentMail(
      { days: 14, limit: 200 },
      {
        bridge: async () => new Response(JSON.stringify({ emails: [{ subject: "x", sender: "someone@else.com", date_sent: NOW.toISOString(), to: ["hpk@m42.com"] }] })),
        resolveLead: async () => [29285],
        ledger: async () => [],
      },
    )
    expect(r.error).toContain("cannot list sent mail")
    expect(r.unlogged).toEqual([])
  })

  test("a ledger read failure is an error for that lead, not a finding and not clean", async () => {
    const r = await auditSentMail(
      { days: 14, limit: 200 },
      {
        bridge: async () => new Response(JSON.stringify({ emails: bridgeRows(1), capabilities: ["from_me"] })),
        resolveLead: async () => [29285],
        ledger: async () => {
          throw new Error("HTTP 500")
        },
      },
    )
    expect(r.unlogged).toEqual([])
    expect(r.ledgerErrors[0]).toContain("29285")
  })
})
