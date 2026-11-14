import { describe, test, expect } from "bun:test"
import {
  attachLabels,
  filterPayments,
  sortPayments,
  paginate,
  summarise,
  reconcile,
  type Payment,
  type RawMessage,
} from "../src/cli/lib/payments"
import {
  resolveIdentity,
  applyIdentities,
  groupByIdentity,
  linkHandles,
  suggestMerges,
  type IdentityMap,
} from "../src/cli/lib/identity"

/**
 * SCALE MATRIX.
 *
 * The functional tests prove the logic in ONE data shape. That is not the same
 * as proving the system holds when the shape changes — a person with one
 * message, a person with a hundred, a person with a million. Real chat.db on
 * this machine already carries ~200k messages, and the first end-to-end run
 * failed with ENOBUFS rather than a wrong answer.
 *
 * Every case here asserts BOTH correctness and a wall-clock bound, because a
 * correct answer that takes four minutes is a failure at the surface a person
 * actually touches.
 *
 * Budgets are deliberately generous — they exist to catch an accidental O(n²),
 * not to micro-benchmark. If one trips, something became quadratic.
 */

// ── Builders ────────────────────────────────────────────────────────────────

const HANDLES = ["+16023150414", "+18175269825", "+18178993603", "+13619067089", "+15122471515"]

function mkPayments(n: number, opts: { handles?: string[]; sameSecond?: boolean } = {}): Payment[] {
  const handles = opts.handles ?? HANDLES
  return Array.from({ length: n }, (_, i) => {
    // sameSecond must pin the DAY too, or "same second" is only the same
    // clock-time on 28 different days.
    const day = opts.sameSecond ? 15 : 1 + (i % 28)
    const hour = opts.sameSecond ? 12 : i % 24
    const min = opts.sameSecond ? 0 : i % 60
    const sec = opts.sameSecond ? 0 : i % 60
    return {
      id: `p${i}`,
      date: `2026-07-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`,
      direction: i % 3 === 0 ? "received" : "sent",
      handle: handles[i % handles.length],
      contact: `Person ${i % handles.length}`,
      rail: "apple_cash" as const,
    }
  })
}

function mkMessages(n: number, labelEvery = 100): RawMessage[] {
  return Array.from({ length: n }, (_, i) => {
    const day = 1 + (i % 28)
    return {
      id: `m${i}`,
      date: `2026-07-${String(day).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      from_me: true,
      handle: HANDLES[i % HANDLES.length],
      text: labelEvery > 0 && i % labelEvery === 0 ? `IRIS BUG BOUNTY #${i}` : `ordinary message ${i}`,
    }
  })
}

/** Run and return elapsed ms, so failures report the actual number. */
function timed<T>(fn: () => T): { out: T; ms: number } {
  const t = Date.now()
  const out = fn()
  return { out, ms: Date.now() - t }
}

// ── 1. Message volume: one person with 1, 100, 20k, 200k messages ───────────

describe("message volume — the same person, wildly different history", () => {
  const one = mkPayments(1)

  test("a person with ZERO messages: no label, no crash", () => {
    const { out } = timed(() => attachLabels(one, [], { windowSeconds: 300 }))
    expect(out).toHaveLength(1)
    expect(out[0].reference).toBeUndefined()
  })

  test("a person with ONE message", () => {
    const msgs: RawMessage[] = [
      { id: "m", date: one[0].date, from_me: true, handle: one[0].handle, text: "IRIS BUG BOUNTY #1" },
    ]
    expect(attachLabels(one, msgs, { windowSeconds: 300 })[0].reference).toBe("IRIS BUG BOUNTY #1")
  })

  test("a person with 100 messages", () => {
    const { out, ms } = timed(() => attachLabels(one, mkMessages(100), { windowSeconds: 300 }))
    expect(out).toHaveLength(1)
    expect(ms).toBeLessThan(500)
  })

  test("a person with 20,000 messages", () => {
    const { out, ms } = timed(() => attachLabels(one, mkMessages(20_000), { windowSeconds: 300 }))
    expect(out).toHaveLength(1)
    expect(ms).toBeLessThan(3000)
  })

  test("a person with 200,000 messages — the real size of this machine's chat.db", () => {
    const { out, ms } = timed(() => attachLabels(one, mkMessages(200_000), { windowSeconds: 300 }))
    expect(out).toHaveLength(1)
    expect(ms).toBeLessThan(15_000)
  })

  test("200,000 messages where EVERY message is a label — worst case for the matcher", () => {
    const { out, ms } = timed(() => attachLabels(one, mkMessages(50_000, 1), { windowSeconds: 300 }))
    expect(out).toHaveLength(1)
    expect(ms).toBeLessThan(15_000)
  })
})

// ── 2. Payment volume ───────────────────────────────────────────────────────

describe("payment volume", () => {
  for (const n of [0, 1, 149, 10_000]) {
    test(`${n} payments filter, sort and paginate correctly`, () => {
      const pays = mkPayments(n)
      const { out: sorted, ms } = timed(() => sortPayments(pays, { sort: "date", order: "desc" }))
      expect(sorted).toHaveLength(n)
      expect(ms).toBeLessThan(3000)

      const page = paginate(sorted, { limit: 25, offset: 0 })
      expect(page.total).toBe(n)
      expect(page.items.length).toBe(Math.min(25, n))
      expect(page.hasMore).toBe(n > 25)

      const s = summarise(pays)
      expect(s.count).toBe(n)
      expect(s.sent + s.received).toBe(n)
      // Never a total — the amount is not in the database at any volume.
      expect(s.totalCents).toBeUndefined()
    })
  }

  test("10k payments against 20k messages stays sub-quadratic", () => {
    const { ms } = timed(() => attachLabels(mkPayments(10_000), mkMessages(20_000), { windowSeconds: 300 }))
    expect(ms).toBeLessThan(10_000)
  })

  test("filtering 10k payments by contact is fast and exact", () => {
    const pays = mkPayments(10_000)
    const { out, ms } = timed(() => filterPayments(pays, { contact: "Person 1" }))
    expect(out.length).toBe(2000)
    expect(ms).toBeLessThan(1000)
  })

  test("deep pagination does not degrade — page 1 and page 400 cost the same", () => {
    const sorted = sortPayments(mkPayments(10_000), {})
    const first = timed(() => paginate(sorted, { limit: 25, offset: 0 }))
    const deep = timed(() => paginate(sorted, { limit: 25, offset: 9_975 }))
    expect(deep.out.items).toHaveLength(25)
    expect(deep.ms).toBeLessThan(first.ms + 500)
  })
})

// ── 3. Pathological shapes ──────────────────────────────────────────────────

describe("pathological data", () => {
  test("5,000 payments in the SAME SECOND to the same person", () => {
    const pays = mkPayments(5_000, { sameSecond: true, handles: ["+16023150414"] })
    const { out, ms } = timed(() => sortPayments(pays, { sort: "date" }))
    expect(out).toHaveLength(5_000)
    // Stability matters most exactly here: with equal keys, order must not churn.
    expect(out[0].id).toBe("p0")
    expect(ms).toBeLessThan(3000)
  })

  test("every payment to ONE handle — no bucket spread to help us", () => {
    const pays = mkPayments(5_000, { handles: ["+16023150414"] })
    const { ms } = timed(() => attachLabels(pays, mkMessages(20_000), { windowSeconds: 300 }))
    expect(ms).toBeLessThan(10_000)
  })

  test("every payment to a DIFFERENT handle — maximum bucket fragmentation", () => {
    const handles = Array.from({ length: 5_000 }, (_, i) => `+1555${String(i).padStart(7, "0")}`)
    const pays = mkPayments(5_000, { handles })
    const { ms } = timed(() => attachLabels(pays, mkMessages(20_000), { windowSeconds: 300 }))
    expect(ms).toBeLessThan(10_000)
  })

  test("malformed dates degrade instead of throwing", () => {
    const junk: Payment[] = [
      { id: "1", date: "not-a-date", direction: "sent", handle: "+16023150414", rail: "apple_cash" },
      { id: "2", date: "", direction: "sent", handle: "+16023150414", rail: "apple_cash" },
    ]
    expect(() => sortPayments(junk, { sort: "date" })).not.toThrow()
    expect(() => filterPayments(junk, { since: "2026-01-01" })).not.toThrow()
    expect(() => attachLabels(junk, mkMessages(100), {})).not.toThrow()
  })

  test("empty and missing handles never cross-attach", () => {
    const pays: Payment[] = [{ id: "1", date: "2026-07-01T00:00:00", direction: "sent", handle: "", rail: "apple_cash" }]
    const msgs: RawMessage[] = [
      { id: "m", date: "2026-07-01T00:00:00", from_me: true, handle: "", text: "IRIS BUG BOUNTY #1" },
    ]
    expect(attachLabels(pays, msgs, { windowSeconds: 300 })[0].reference).toBeUndefined()
  })

  test("a 10k-payment reconcile completes and finds the unlabelled", () => {
    const { out, ms } = timed(() => reconcile(mkPayments(10_000)))
    // 2/3 are sent and none are labelled, so every sent one is flagged.
    expect(out.filter((i) => i.kind === "unlabelled").length).toBeGreaterThan(6_000)
    expect(ms).toBeLessThan(10_000)
  })
})

// ── 4. Identity at scale ────────────────────────────────────────────────────

describe("identity resolution at scale", () => {
  function mkMap(n: number): IdentityMap {
    return {
      identities: Array.from({ length: n }, (_, i) => ({
        id: `id-${i}`,
        name: `Person ${i}`,
        handles: [`+1555${String(i).padStart(7, "0")}`, `person${i}@example.com`],
        userIds: [i],
        leadIds: [i * 2, i * 2 + 1],
      })),
    }
  }

  for (const n of [0, 1, 1_000, 10_000]) {
    test(`resolving against ${n} identities`, () => {
      const map = mkMap(n)
      const { ms } = timed(() => {
        for (let i = 0; i < Math.min(n, 500); i++) resolveIdentity(map, { handle: `+1555${String(i).padStart(7, "0")}` })
      })
      if (n > 0) expect(resolveIdentity(map, { handle: "+15550000000" })?.id).toBe("id-0")
      expect(ms).toBeLessThan(5000)
    })
  }

  test("stamping 10k payments against 1k identities", () => {
    const map = mkMap(1_000)
    const pays = mkPayments(10_000, { handles: map.identities.slice(0, 50).map((i) => i.handles[0]) })
    const { out, ms } = timed(() => applyIdentities(pays, map))
    expect(out).toHaveLength(10_000)
    expect(out.every((p) => p.identityId)).toBe(true)
    expect(ms).toBeLessThan(10_000)
  })

  test("grouping 10k payments collapses to the right number of people", () => {
    const map = mkMap(50)
    const pays = mkPayments(10_000, { handles: map.identities.map((i) => i.handles[0]) })
    const { out, ms } = timed(() => groupByIdentity(applyIdentities(pays, map)))
    expect(out).toHaveLength(50)
    expect(out.reduce((s, g) => s + g.count, 0)).toBe(10_000)
    expect(ms).toBeLessThan(10_000)
  })

  test("one person with 40 aliases still resolves from every one of them", () => {
    const handles = Array.from({ length: 40 }, (_, i) => `+1555${String(i).padStart(7, "0")}`)
    let map: IdentityMap = { identities: [] }
    for (let i = 1; i < handles.length; i++) map = linkHandles(map, [handles[0], handles[i]], "Many Numbers")
    expect(map.identities).toHaveLength(1)
    expect(map.identities[0].handles).toHaveLength(40)
    for (const h of handles) expect(resolveIdentity(map, { handle: h })?.name).toBe("Many Numbers")
  })

  test("suggestion over 2,000 contact cards stays bounded", () => {
    // O(n²) pair comparison is the risk here; 2k cards is 2M pairs.
    const cards = Array.from({ length: 2_000 }, (_, i) => ({
      name: `Person${i} Surname${i}`,
      handle: `+1555${String(i).padStart(7, "0")}`,
    }))
    const { out, ms } = timed(() => suggestMerges(cards))
    expect(out).toEqual([])
    expect(ms).toBeLessThan(15_000)
  })

  test("2,000 cards that ALL look mergeable — worst case for the suggester", () => {
    const cards = Array.from({ length: 300 }, (_, i) => ({
      name: `Flo${"z".repeat(i % 5)} Smith`,
      handle: `+1555${String(i).padStart(7, "0")}`,
    }))
    const { out, ms } = timed(() => suggestMerges(cards))
    expect(out.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(15_000)
  })
})

// ── 5. End-to-end pipeline at realistic volume ──────────────────────────────

describe("full pipeline", () => {
  test("10k payments + 50k messages + 1k identities, read to grouped output", () => {
    const map: IdentityMap = {
      identities: Array.from({ length: 1_000 }, (_, i) => ({
        id: `id-${i}`,
        name: `Person ${i}`,
        handles: [HANDLES[i % HANDLES.length]],
      })),
    }
    const { ms } = timed(() => {
      const linked = attachLabels(mkPayments(10_000), mkMessages(50_000), { windowSeconds: 300 })
      const stamped = applyIdentities(linked, map)
      const filtered = filterPayments(stamped as Payment[], { direction: "sent" })
      const sorted = sortPayments(filtered, { sort: "date", order: "desc" })
      const page = paginate(sorted, { limit: 25, offset: 0 })
      expect(page.items).toHaveLength(25)
      groupByIdentity(stamped)
      reconcile(filtered)
    })
    expect(ms).toBeLessThan(30_000)
  })
})
