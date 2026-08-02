import { describe, test, expect } from "bun:test"
import {
  normaliseHandle,
  resolveIdentity,
  suggestMerges,
  applyIdentities,
  groupByIdentity,
  linkHandles,
  type IdentityMap,
  type IdentityRecord,
} from "../src/cli/lib/identity"
import type { Payment } from "../src/cli/lib/payments"

/**
 * Identity resolution (#178599).
 *
 * The disease, from live data: one human fragments differently at every layer.
 *   contacts  "Flo Smith" (+18178993603)  AND  "Flozzel Smith" (+18175269825)
 *   users     5478 ($43)  AND  5486 ($7)
 *   leads     Rashad has FIVE records across two emails
 *
 * Flo's $50 went to the Flozzel card while every lookup for "Flo" resolved to
 * the Flo card, so the platform answered "no payments found" with confidence.
 *
 * THE SAFETY RULE THESE TESTS ENFORCE: merging is never automatic. Two people
 * wrongly merged means money attributed to the wrong human, which is worse than
 * the fragmentation it fixes. The system SUGGESTS; a person CONFIRMS.
 */

const FLO: IdentityRecord = {
  id: "flo-smith",
  name: "Flo Smith",
  handles: ["+18178993603", "+18175269825"],
  leadIds: [28165],
  userIds: [5478, 5486],
}

const RASHAD: IdentityRecord = {
  id: "rashad-bernard",
  name: "Rashad Bernard",
  handles: ["+16023150414"],
  leadIds: [16750, 28301, 39, 16743, 14488],
  userIds: [609],
}

const MAP: IdentityMap = { identities: [FLO, RASHAD] }

// ─────────────────────────────────────────────────────────────────────────────
// Handle normalisation — the join key everything else depends on
// ─────────────────────────────────────────────────────────────────────────────

describe("normaliseHandle", () => {
  test("strips formatting so one number has one representation", () => {
    const forms = ["+1 (817) 526-9825", "817-526-9825", "8175269825", "+18175269825"]
    const out = new Set(forms.map(normaliseHandle))
    expect(out.size).toBe(1)
  })

  test("keeps emails intact and lowercased", () => {
    expect(normaliseHandle("Rashad@FreeLabel.net")).toBe("rashad@freelabel.net")
  })

  test("does not collapse two genuinely different numbers", () => {
    expect(normaliseHandle("8175269825")).not.toBe(normaliseHandle("8178993603"))
  })

  test("never throws on junk", () => {
    for (const bad of [undefined, null, "", 42, {}] as unknown[]) {
      expect(() => normaliseHandle(bad as string)).not.toThrow()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveIdentity", () => {
  test("THE BUG: both of Flo's numbers resolve to one identity", () => {
    const a = resolveIdentity(MAP, { handle: "+18178993603" })
    const b = resolveIdentity(MAP, { handle: "+18175269825" })
    expect(a?.id).toBe("flo-smith")
    expect(b?.id).toBe("flo-smith")
    expect(a?.id).toBe(b?.id)
  })

  test("resolves by lead id — all five of Rashad's land on one identity", () => {
    for (const lead of [16750, 28301, 39, 16743, 14488]) {
      expect(resolveIdentity(MAP, { leadId: lead })?.id).toBe("rashad-bernard")
    }
  })

  test("resolves by user id — both of Flo's user accounts", () => {
    expect(resolveIdentity(MAP, { userId: 5478 })?.id).toBe("flo-smith")
    expect(resolveIdentity(MAP, { userId: 5486 })?.id).toBe("flo-smith")
  })

  test("resolves by name, case-insensitively", () => {
    expect(resolveIdentity(MAP, { name: "flo smith" })?.id).toBe("flo-smith")
  })

  test("resolves an ALIAS name — 'Flozzel Smith' is Flo", () => {
    const withAlias: IdentityMap = {
      identities: [{ ...FLO, aliases: ["Flozzel Smith"] }, RASHAD],
    }
    expect(resolveIdentity(withAlias, { name: "Flozzel Smith" })?.id).toBe("flo-smith")
  })

  test("returns null for an unknown handle rather than guessing", () => {
    expect(resolveIdentity(MAP, { handle: "+15550001111" })).toBeNull()
  })

  test("an empty map resolves nothing and does not throw", () => {
    expect(resolveIdentity({ identities: [] }, { handle: "+18175269825" })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion — detect, never auto-merge
// ─────────────────────────────────────────────────────────────────────────────

describe("suggestMerges", () => {
  test("suggests the real pair: Flo Smith and Flozzel Smith", () => {
    const s = suggestMerges([
      { name: "Flo Smith", handle: "+18178993603" },
      { name: "Flozzel Smith", handle: "+18175269825" },
    ])
    expect(s).toHaveLength(1)
    expect(s[0].reason).toMatch(/surname/i)
    expect(s[0].members.map((m) => m.name).sort()).toEqual(["Flo Smith", "Flozzel Smith"])
  })

  test("suggests cards sharing an email even when names differ", () => {
    const s = suggestMerges([
      { name: "rashadbernard", handle: "rashadbernard4@gmail.com" },
      { name: "R. Bernard", handle: "rashadbernard4@gmail.com" },
    ])
    expect(s.length).toBeGreaterThan(0)
    expect(s[0].reason).toMatch(/handle|email/i)
  })

  test("does NOT suggest two unrelated people who share a surname", () => {
    // Same surname is not enough on its own — the given names must be
    // compatible. Merging these would misattribute money.
    const s = suggestMerges([
      { name: "John Smith", handle: "+15550001111" },
      { name: "Karen Smith", handle: "+15550002222" },
    ])
    expect(s).toHaveLength(0)
  })

  test("does NOT suggest unrelated names", () => {
    expect(
      suggestMerges([
        { name: "Rashad Bernard", handle: "+16023150414" },
        { name: "Flo Smith", handle: "+18178993603" },
      ]),
    ).toHaveLength(0)
  })

  test("does not suggest a single card as a merge with itself", () => {
    expect(suggestMerges([{ name: "Flo Smith", handle: "+18178993603" }])).toHaveLength(0)
  })

  test("ranks a shared-handle match above a name-similarity match", () => {
    const s = suggestMerges([
      { name: "Flo Smith", handle: "flo@x.com" },
      { name: "Flozzel Smith", handle: "+18175269825" },
      { name: "F. Smith", handle: "flo@x.com" },
    ])
    expect(s[0].confidence).toBe("high")
  })

  test("never throws on malformed cards", () => {
    expect(() =>
      suggestMerges([{ name: "", handle: "" }, { name: undefined as unknown as string, handle: "x" }]),
    ).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Linking — the explicit, operator-confirmed merge
// ─────────────────────────────────────────────────────────────────────────────

describe("linkHandles", () => {
  test("creates a new identity when neither handle is known", () => {
    const next = linkHandles({ identities: [] }, ["+18178993603", "+18175269825"], "Flo Smith")
    expect(next.identities).toHaveLength(1)
    expect(next.identities[0].handles).toHaveLength(2)
  })

  test("adds a handle to the existing identity rather than creating a second", () => {
    const start: IdentityMap = { identities: [{ id: "flo-smith", name: "Flo Smith", handles: ["+18178993603"] }] }
    const next = linkHandles(start, ["+18178993603", "+18175269825"], "Flo Smith")
    expect(next.identities).toHaveLength(1)
    expect(next.identities[0].handles.map(normaliseHandle)).toContain(normaliseHandle("+18175269825"))
  })

  test("is idempotent — linking twice does not duplicate handles", () => {
    let m: IdentityMap = { identities: [] }
    m = linkHandles(m, ["+18178993603", "+18175269825"], "Flo Smith")
    m = linkHandles(m, ["+18178993603", "+18175269825"], "Flo Smith")
    expect(m.identities).toHaveLength(1)
    expect(m.identities[0].handles).toHaveLength(2)
  })

  test("MERGES two existing identities when a link spans them", () => {
    const start: IdentityMap = {
      identities: [
        { id: "flo-smith", name: "Flo Smith", handles: ["+18178993603"], userIds: [5478] },
        { id: "flozzel-smith", name: "Flozzel Smith", handles: ["+18175269825"], userIds: [5486] },
      ],
    }
    const next = linkHandles(start, ["+18178993603", "+18175269825"])
    expect(next.identities).toHaveLength(1)
    // Nothing is lost in the merge — both user accounts survive.
    expect(next.identities[0].userIds?.sort()).toEqual([5478, 5486])
    expect(next.identities[0].handles).toHaveLength(2)
  })

  test("never mutates the input map", () => {
    const start: IdentityMap = { identities: [{ id: "a", name: "A", handles: ["+15550001111"] }] }
    const before = JSON.stringify(start)
    linkHandles(start, ["+15550001111", "+15550002222"])
    expect(JSON.stringify(start)).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Applying to payments — the visible payoff
// ─────────────────────────────────────────────────────────────────────────────

const floPayment: Payment = {
  id: "1", date: "2026-07-29T14:01:50", direction: "sent",
  handle: "+18175269825", contact: "Flozzel Smith", rail: "apple_cash",
}
const floOther: Payment = {
  id: "2", date: "2026-06-01T10:00:00", direction: "sent",
  handle: "+18178993603", contact: "Flo Smith", rail: "apple_cash",
}
const rashadPayment: Payment = {
  id: "3", date: "2026-07-30T20:57:46", direction: "sent",
  handle: "+16023150414", contact: "Rashad Bernard", rail: "apple_cash",
}

describe("applyIdentities", () => {
  test("stamps a canonical identity onto payments from BOTH of Flo's numbers", () => {
    const out = applyIdentities([floPayment, floOther, rashadPayment], MAP)
    expect(out[0].identityId).toBe("flo-smith")
    expect(out[1].identityId).toBe("flo-smith")
    expect(out[2].identityId).toBe("rashad-bernard")
  })

  test("preserves the contact card actually paid — the drift stays visible", () => {
    // Unifying must not erase which card received the money; that is the
    // evidence a reconciliation needs.
    const out = applyIdentities([floPayment], MAP)
    expect(out[0].contact).toBe("Flozzel Smith")
    expect(out[0].identityName).toBe("Flo Smith")
  })

  test("leaves unknown handles unstamped rather than inventing an identity", () => {
    const stranger: Payment = { ...floPayment, id: "9", handle: "+15550009999", contact: undefined }
    expect(applyIdentities([stranger], MAP)[0].identityId).toBeUndefined()
  })

  test("never mutates the input", () => {
    const before = JSON.stringify([floPayment])
    applyIdentities([floPayment], MAP)
    expect(JSON.stringify([floPayment])).toBe(before)
  })
})

describe("groupByIdentity", () => {
  test("THE PAYOFF: Flo's two numbers collapse into one row", () => {
    const groups = groupByIdentity(applyIdentities([floPayment, floOther, rashadPayment], MAP))
    expect(groups).toHaveLength(2)
    const flo = groups.find((g) => g.identityId === "flo-smith")!
    expect(flo.count).toBe(2)
    expect(flo.name).toBe("Flo Smith")
    // Both cards are listed, so nothing is hidden by the merge.
    expect(flo.handles.sort()).toEqual(["+18175269825", "+18178993603"])
  })

  test("unresolved payments group under their handle, not silently dropped", () => {
    const stranger: Payment = { ...floPayment, id: "9", handle: "+15550009999", contact: undefined }
    const groups = groupByIdentity(applyIdentities([stranger], MAP))
    expect(groups).toHaveLength(1)
    expect(groups[0].identityId).toBeUndefined()
    expect(groups[0].count).toBe(1)
  })

  test("orders by payment count, busiest first", () => {
    const groups = groupByIdentity(applyIdentities([floPayment, floOther, rashadPayment], MAP))
    expect(groups[0].count).toBeGreaterThanOrEqual(groups[1].count)
  })

  test("handles an empty set", () => {
    expect(groupByIdentity([])).toEqual([])
  })
})
