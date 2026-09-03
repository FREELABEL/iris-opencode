import { describe, test, expect } from "bun:test"
import {
  parseLabel,
  attachLabels,
  filterPayments,
  sortPayments,
  paginate,
  summarise,
  reconcile,
  type Payment,
  type RawMessage,
} from "../src/cli/lib/payments"

/**
 * Payment search / filter / sort / drill-down (#178595, #178599).
 *
 * Written BEFORE the implementation. The contract these pin down comes from
 * real data on Alex's machine, not from imagination:
 *
 *   - 149 Apple Cash balloons exist in chat.db; `iris imessage read` surfaced 0,
 *     because the reader requires a text body and a payment has none.
 *   - The AMOUNT IS NOT IN THE DATABASE. Confirmed by comparing a screenshot
 *     ($50) against its own DB row. Not in text, not in message_summary_info,
 *     not in payload_data. Any API that returns a non-null amount from chat.db
 *     alone is lying, so `amount` is optional and defaults to undefined.
 *   - The only label a payment carries is a SEPARATE message sent seconds
 *     later: "IRIS BUG BOUNTY #001 - FLO SMITH".
 *   - The same human appears under multiple contact cards — the money went to
 *     "Flozzel Smith" while every lookup for "Flo" resolves to "Flo Smith".
 *     Attachment broke on exactly that.
 */

// ── Fixtures: the real events, anonymised only in phone digits ───────────────

const FLO_PAYMENT: Payment = {
  id: "177900",
  date: "2026-07-29T14:01:50",
  direction: "sent",
  handle: "+18175269825",
  contact: "Flozzel Smith",
  rail: "apple_cash",
}

const RASHAD_PAYMENT: Payment = {
  id: "178848",
  date: "2026-07-30T20:57:46",
  direction: "sent",
  handle: "+16023150414",
  contact: "Rashad Bernard",
  rail: "apple_cash",
}

const RASHAD_EARLIER: Payment = {
  id: "178610",
  date: "2026-07-27T23:39:34",
  direction: "sent",
  handle: "+16023150414",
  contact: "Rashad Bernard",
  rail: "apple_cash",
}

const INBOUND: Payment = {
  id: "177341",
  date: "2026-07-16T17:51:41",
  direction: "received",
  handle: "+16023150414",
  contact: "Rashad Bernard",
  rail: "apple_cash",
}

const ALL: Payment[] = [FLO_PAYMENT, RASHAD_PAYMENT, RASHAD_EARLIER, INBOUND]

// ─────────────────────────────────────────────────────────────────────────────
// 1. LABEL PARSING — the convention already in use by hand
// ─────────────────────────────────────────────────────────────────────────────

describe("parseLabel", () => {
  test("extracts the reference and recipient from the real Flo label", () => {
    expect(parseLabel("IRIS BUG BOUNTY #001 - FLO SMITH")).toEqual({
      reference: "IRIS BUG BOUNTY #001",
      sequence: 1,
      claimedRecipient: "FLO SMITH",
    })
  })

  test("handles a label with no recipient — the real Rashad case", () => {
    expect(parseLabel("IRIS BUG BOUNTY #002")).toEqual({
      reference: "IRIS BUG BOUNTY #002",
      sequence: 2,
      claimedRecipient: undefined,
    })
  })

  test("is tolerant of the ways a human actually types it", () => {
    for (const variant of [
      "iris bug bounty #003 - jane doe",
      "IRIS BUG BOUNTY  #003  —  JANE DOE",
      "  IRIS BUG BOUNTY #003 - Jane Doe  ",
    ]) {
      const r = parseLabel(variant)
      expect(r?.sequence).toBe(3)
      expect(r?.claimedRecipient?.toUpperCase()).toBe("JANE DOE")
    }
  })

  test("preserves leading zeros in the reference but reads the number", () => {
    expect(parseLabel("IRIS BUG BOUNTY #007")?.sequence).toBe(7)
    expect(parseLabel("IRIS BUG BOUNTY #007")?.reference).toContain("#007")
  })

  test("returns null for unrelated chatter, so ordinary texts never become labels", () => {
    expect(parseLabel("Yea I'm boutta be a millionaire lol")).toBeNull()
    expect(parseLabel("")).toBeNull()
    expect(parseLabel("thanks!")).toBeNull()
  })

  test("never throws on hostile input", () => {
    for (const bad of [undefined, null, 42, {}, "#", "IRIS BUG BOUNTY #"] as unknown[]) {
      expect(() => parseLabel(bad as string)).not.toThrow()
    }
  })

  test("survives attributedBody decode noise — this is the REAL string from chat.db", () => {
    // Modern macOS stores message text in attributedBody (a binary blob), not
    // the `text` column. Decoding it leaves control-byte residue on the front.
    // The real row for Flo's label decodes to exactly this, and it must parse.
    const fromDb = "+!IRIS BUG BOUNTY #001 - FLO SMITH "
    expect(parseLabel(fromDb)).toEqual({
      reference: "IRIS BUG BOUNTY #001",
      sequence: 1,
      claimedRecipient: "FLO SMITH",
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. ATTACHING LABELS — a payment's meaning lives in a neighbouring message
// ─────────────────────────────────────────────────────────────────────────────

describe("attachLabels", () => {
  const msgs: RawMessage[] = [
    { id: "1", date: "2026-07-29T14:01:52", from_me: true, handle: "+18175269825", text: "IRIS BUG BOUNTY #001 - FLO SMITH" },
    { id: "2", date: "2026-07-30T20:57:46", from_me: true, handle: "+16023150414", text: "IRIS BUG BOUNTY #002" },
    { id: "3", date: "2026-07-30T21:40:00", from_me: true, handle: "+16023150414", text: "thanks for the work" },
  ]

  test("attaches the label sent seconds after the payment", () => {
    const [flo] = attachLabels([FLO_PAYMENT], msgs, { windowSeconds: 120 })
    expect(flo.reference).toBe("IRIS BUG BOUNTY #001")
    expect(flo.claimedRecipient).toBe("FLO SMITH")
  })

  test("attaches a label sent in the SAME second — the real Rashad case", () => {
    const [r] = attachLabels([RASHAD_PAYMENT], msgs, { windowSeconds: 120 })
    expect(r.reference).toBe("IRIS BUG BOUNTY #002")
  })

  test("will not attach a label from a different counterparty", () => {
    const [flo] = attachLabels(
      [FLO_PAYMENT],
      [{ id: "9", date: "2026-07-29T14:01:52", from_me: true, handle: "+16023150414", text: "IRIS BUG BOUNTY #001 - FLO SMITH" }],
      { windowSeconds: 120 },
    )
    expect(flo.reference).toBeUndefined()
  })

  test("will not attach a label outside the window", () => {
    const [flo] = attachLabels([FLO_PAYMENT], msgs, { windowSeconds: 1 })
    expect(flo.reference).toBeUndefined()
  })

  test("picks the CLOSEST label when several are in range", () => {
    const crowded: RawMessage[] = [
      { id: "a", date: "2026-07-30T20:57:46", from_me: true, handle: "+16023150414", text: "IRIS BUG BOUNTY #002" },
      { id: "b", date: "2026-07-30T20:58:30", from_me: true, handle: "+16023150414", text: "IRIS BUG BOUNTY #999" },
    ]
    const [r] = attachLabels([RASHAD_PAYMENT], crowded, { windowSeconds: 600 })
    expect(r.reference).toBe("IRIS BUG BOUNTY #002")
  })

  test("leaves ordinary messages alone — 'thanks for the work' is not a label", () => {
    const [r] = attachLabels([RASHAD_PAYMENT], [msgs[2]], { windowSeconds: 86400 })
    expect(r.reference).toBeUndefined()
  })

  test("never mutates the input payments", () => {
    const before = JSON.stringify(ALL)
    attachLabels(ALL, msgs, { windowSeconds: 120 })
    expect(JSON.stringify(ALL)).toBe(before)
  })

  test("matches an OUTBOUND label, which carries no handle of its own", () => {
    // Verified against chat.db: a message I sent has handle_id 0, so the
    // counterparty must come from the CHAT, not the handle. Feeding an empty
    // handle must not silently drop the label — that produced 0 attachments on
    // the first real-data run while both labels sat right there.
    const outbound: RawMessage[] = [
      { id: "1", date: "2026-07-29T14:01:50", from_me: true, handle: "+18175269825", text: "IRIS BUG BOUNTY #001 - FLO SMITH" },
    ]
    const [flo] = attachLabels([FLO_PAYMENT], outbound, { windowSeconds: 300 })
    expect(flo.reference).toBe("IRIS BUG BOUNTY #001")
  })

  test("an empty handle never buckets, so it cannot cross-attach to the wrong person", () => {
    const orphan: RawMessage[] = [
      { id: "1", date: "2026-07-29T14:01:50", from_me: true, handle: "", text: "IRIS BUG BOUNTY #001 - FLO SMITH" },
    ]
    expect(attachLabels([FLO_PAYMENT], orphan, { windowSeconds: 300 })[0].reference).toBeUndefined()
  })

  test("is linear enough for scale — 5k payments x 20k messages completes quickly", () => {
    const many: Payment[] = Array.from({ length: 5000 }, (_, i) => ({
      ...RASHAD_PAYMENT,
      id: `p${i}`,
      date: `2026-07-30T20:${String(i % 60).padStart(2, "0")}:00`,
    }))
    const manyMsgs: RawMessage[] = Array.from({ length: 20000 }, (_, i) => ({
      id: `m${i}`,
      date: `2026-07-30T20:${String(i % 60).padStart(2, "0")}:01`,
      from_me: true,
      handle: "+16023150414",
      text: i % 100 === 0 ? `IRIS BUG BOUNTY #${i}` : "chatter",
    }))
    const started = Date.now()
    attachLabels(many, manyMsgs, { windowSeconds: 120 })
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. FILTERING — the drill-down surface
// ─────────────────────────────────────────────────────────────────────────────

describe("filterPayments", () => {
  test("no filter returns everything", () => {
    expect(filterPayments(ALL, {})).toHaveLength(4)
  })

  test("by direction", () => {
    expect(filterPayments(ALL, { direction: "sent" })).toHaveLength(3)
    expect(filterPayments(ALL, { direction: "received" })).toHaveLength(1)
  })

  test("by contact name, case-insensitive and partial", () => {
    expect(filterPayments(ALL, { contact: "rashad" })).toHaveLength(3)
    expect(filterPayments(ALL, { contact: "RASHAD BERNARD" })).toHaveLength(3)
  })

  test("by handle, so a raw number works when the contact is unknown", () => {
    expect(filterPayments(ALL, { contact: "8175269825" })).toHaveLength(1)
  })

  test("a partial number still matches", () => {
    expect(filterPayments(ALL, { contact: "5269825" })).toHaveLength(1)
  })

  test("a name containing a digit does NOT match every phone number", () => {
    // Found by the scale matrix: digitsOf("Person 1") is "1", and every phone
    // number contains a 1, so this returned all 10,000 payments. A query only
    // digit-matches when it actually looks like a handle.
    const named: Payment[] = ALL.map((p) => ({ ...p, contact: "Agent 1" }))
    expect(filterPayments(named, { contact: "Agent 1" })).toHaveLength(4)
    expect(filterPayments(named, { contact: "Agent 9" })).toHaveLength(0)
  })

  test("a one- or two-digit query does not match the world", () => {
    expect(filterPayments(ALL, { contact: "1" })).toHaveLength(0)
    expect(filterPayments(ALL, { contact: "18" })).toHaveLength(0)
  })

  test("an email query matches on the handle", () => {
    const withEmail: Payment[] = [
      { ...FLO_PAYMENT, id: "e1", handle: "flo@example.com", contact: undefined },
    ]
    expect(filterPayments(withEmail, { contact: "flo@example.com" })).toHaveLength(1)
    expect(filterPayments(withEmail, { contact: "someone@else.com" })).toHaveLength(0)
  })

  test("CRITICAL: searching 'Flo' finds the payment on the 'Flozzel Smith' card", () => {
    // This is the exact failure that hid Flo's $50. A prefix match on the
    // contact name must reach Flozzel, or attachment breaks again.
    const hits = filterPayments(ALL, { contact: "Flo" })
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(FLO_PAYMENT.id)
  })

  test("by date range, inclusive on both ends", () => {
    expect(filterPayments(ALL, { since: "2026-07-29", until: "2026-07-30" })).toHaveLength(2)
    expect(filterPayments(ALL, { since: "2026-07-31" })).toHaveLength(0)
    expect(filterPayments(ALL, { until: "2026-07-16" })).toHaveLength(1)
  })

  test("by reference, to answer 'where did bounty #001 go'", () => {
    const labelled = ALL.map((p) =>
      p.id === FLO_PAYMENT.id ? { ...p, reference: "IRIS BUG BOUNTY #001" } : p,
    )
    expect(filterPayments(labelled, { reference: "#001" })).toHaveLength(1)
  })

  test("by labelled / unlabelled — unlabelled payments are the reconciliation backlog", () => {
    const labelled = ALL.map((p) =>
      p.id === FLO_PAYMENT.id ? { ...p, reference: "IRIS BUG BOUNTY #001" } : p,
    )
    expect(filterPayments(labelled, { labelled: true })).toHaveLength(1)
    expect(filterPayments(labelled, { labelled: false })).toHaveLength(3)
  })

  test("filters compose (AND, not OR)", () => {
    expect(filterPayments(ALL, { contact: "rashad", direction: "sent" })).toHaveLength(2)
  })

  test("an unmatched filter returns empty rather than everything", () => {
    expect(filterPayments(ALL, { contact: "nobody" })).toEqual([])
  })

  test("never mutates the input", () => {
    const before = JSON.stringify(ALL)
    filterPayments(ALL, { direction: "sent" })
    expect(JSON.stringify(ALL)).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. SORTING
// ─────────────────────────────────────────────────────────────────────────────

describe("sortPayments", () => {
  test("defaults to newest first — the useful default for money", () => {
    expect(sortPayments(ALL, {})[0].id).toBe(RASHAD_PAYMENT.id)
  })

  test("date ascending", () => {
    expect(sortPayments(ALL, { sort: "date", order: "asc" })[0].id).toBe(INBOUND.id)
  })

  test("by contact, alphabetical", () => {
    expect(sortPayments(ALL, { sort: "contact", order: "asc" })[0].contact).toBe("Flozzel Smith")
  })

  test("is stable for equal keys, so repeated runs render identically", () => {
    const dupes: Payment[] = [
      { ...RASHAD_PAYMENT, id: "x1" },
      { ...RASHAD_PAYMENT, id: "x2" },
      { ...RASHAD_PAYMENT, id: "x3" },
    ]
    expect(sortPayments(dupes, { sort: "date" }).map((p) => p.id)).toEqual(["x1", "x2", "x3"])
  })

  test("never mutates the input", () => {
    const before = ALL.map((p) => p.id)
    sortPayments(ALL, { sort: "date", order: "asc" })
    expect(ALL.map((p) => p.id)).toEqual(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. PAGINATION — 149 today, thousands later
// ─────────────────────────────────────────────────────────────────────────────

describe("paginate", () => {
  const many: Payment[] = Array.from({ length: 250 }, (_, i) => ({ ...RASHAD_PAYMENT, id: `p${i}` }))

  test("returns the requested page and the true total", () => {
    const r = paginate(many, { limit: 50, offset: 0 })
    expect(r.items).toHaveLength(50)
    expect(r.total).toBe(250)
    expect(r.hasMore).toBe(true)
  })

  test("the last page reports hasMore false", () => {
    expect(paginate(many, { limit: 50, offset: 200 }).hasMore).toBe(false)
  })

  test("an offset past the end is empty, not an error", () => {
    const r = paginate(many, { limit: 50, offset: 9999 })
    expect(r.items).toEqual([])
    expect(r.total).toBe(250)
  })

  test("defaults are sane when nothing is passed", () => {
    expect(paginate(many, {}).items.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE AMOUNT CONTRACT — the constraint that must never be quietly broken
// ─────────────────────────────────────────────────────────────────────────────

describe("amount is never invented", () => {
  test("a payment read from chat.db has NO amount", () => {
    // Confirmed by comparing a $50 screenshot against its own DB row.
    expect(FLO_PAYMENT.amount).toBeUndefined()
  })

  test("summarise reports a count and explicitly refuses to total unknown amounts", () => {
    const s = summarise(ALL)
    expect(s.count).toBe(4)
    expect(s.sent).toBe(3)
    expect(s.received).toBe(1)
    expect(s.amountKnownCount).toBe(0)
    expect(s.totalCents).toBeUndefined()
  })

  test("once amounts are supplied externally, it totals only the known ones", () => {
    const withAmounts = [
      { ...FLO_PAYMENT, amount: 5000 },
      { ...RASHAD_PAYMENT, amount: 2500 },
      RASHAD_EARLIER,
    ]
    const s = summarise(withAmounts)
    expect(s.amountKnownCount).toBe(2)
    expect(s.totalCents).toBe(7500)
    expect(s.amountUnknownCount).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. RECONCILIATION — surfacing the drift instead of smoothing it
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcile", () => {
  test("flags a label whose named recipient disagrees with the receiving card", () => {
    // The real case: label says FLO SMITH, money landed on the Flozzel Smith card.
    const p = { ...FLO_PAYMENT, reference: "IRIS BUG BOUNTY #001", claimedRecipient: "FLO SMITH" }
    const issues = reconcile([p])
    expect(issues.some((i) => i.kind === "recipient_mismatch" && i.paymentId === p.id)).toBe(true)
  })

  test("does NOT flag when the label matches the card", () => {
    const p = { ...RASHAD_PAYMENT, reference: "IRIS BUG BOUNTY #002", claimedRecipient: "RASHAD BERNARD" }
    expect(reconcile([p]).some((i) => i.kind === "recipient_mismatch")).toBe(false)
  })

  test("flags a duplicate reference — the double-booking guard", () => {
    const a = { ...FLO_PAYMENT, reference: "IRIS BUG BOUNTY #001" }
    const b = { ...RASHAD_PAYMENT, reference: "IRIS BUG BOUNTY #001" }
    expect(reconcile([a, b]).some((i) => i.kind === "duplicate_reference")).toBe(true)
  })

  test("flags gaps in the sequence — a missing #002 means a payment was never labelled", () => {
    const a = { ...FLO_PAYMENT, reference: "IRIS BUG BOUNTY #001", sequence: 1 }
    const c = { ...RASHAD_PAYMENT, reference: "IRIS BUG BOUNTY #003", sequence: 3 }
    const issues = reconcile([a, c])
    expect(issues.some((i) => i.kind === "sequence_gap" && i.detail.includes("2"))).toBe(true)
  })

  test("flags unlabelled sent payments — money out with no stated purpose", () => {
    expect(reconcile([RASHAD_EARLIER]).some((i) => i.kind === "unlabelled")).toBe(true)
  })

  test("does not flag unlabelled RECEIVED payments — inbound needs no purpose from us", () => {
    expect(reconcile([INBOUND]).some((i) => i.kind === "unlabelled")).toBe(false)
  })

  test("returns an empty list for a clean set", () => {
    const clean = { ...RASHAD_PAYMENT, reference: "IRIS BUG BOUNTY #001", sequence: 1, claimedRecipient: "RASHAD BERNARD" }
    expect(reconcile([clean])).toEqual([])
  })

  test("never throws on an empty or malformed set", () => {
    expect(() => reconcile([])).not.toThrow()
    expect(reconcile([])).toEqual([])
  })
})
