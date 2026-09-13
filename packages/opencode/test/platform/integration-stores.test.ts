/**
 * Regression tests: `list-connected` must not show connections execution cannot use (#184152)
 *
 * `irisFetch(path, options, base = FL_API)` — the default base is fl-api despite the name.
 * `list-connected` omitted the base and so listed fl-api's rows, while `execute-direct`
 * runs on iris-api and resolves credentials from ITS table.
 *
 * Measured 2026-09-08, network healthy (freelabel.net 207, raichu 200): the listing showed
 * two Gmail rows, both status=active, one of them a client's — while BOTH execution rails,
 * `iris gmail inbox` and `integrations exec gmail read_emails|fetch_emails`, answered
 * "No active 'gmail' connection found. Run: iris connect gmail".
 *
 * That is #181228 inverted. There a real connection was HIDDEN; here a phantom one is
 * SHOWN, and this direction is worse: the advised fix is `connect`, and an abandoned OAuth
 * retry is the dominant cause of dead connections in the audit. The false positive
 * manufactures the failure it describes.
 */
import { describe, test, expect } from "bun:test"
import { readIntegrationStores, rowsFromEnvelope, type StoreRef } from "../../src/cli/cmd/integration-stores"

const STORES: StoreRef[] = [
  { label: "iris-api", base: "https://freelabel.net", inExecStore: true },
  { label: "fl-api", base: "https://raichu.heyiris.io", inExecStore: false },
]

const ok = (body: any) => ({ ok: true, status: 200, body })
const gmail = (id: number) => ({ id, type: "gmail", status: "active" })

describe("two integration stores (#184152)", () => {
  test("rows are labelled with the store that holds them", async () => {
    const r = await readIntegrationStores(STORES, async (base) =>
      ok({ connections: base.includes("freelabel") ? [gmail(1)] : [gmail(3)] }),
    )
    expect(r.rows?.map((x) => [x.id, x.store])).toEqual([
      [1, "iris-api"],
      [3, "fl-api"],
    ])
  })

  test("rows are flagged by whether exec's store holds them — the point of the read", async () => {
    const r = await readIntegrationStores(STORES, async (base) =>
      ok({ connections: base.includes("freelabel") ? [gmail(1)] : [gmail(3)] }),
    )
    expect(r.rows?.find((x) => x.id === 1)?.inExecStore).toBe(true)
    expect(r.rows?.find((x) => x.id === 3)?.inExecStore).toBe(false)
  })

  test("THE REGRESSION — fl-api-only rows are counted as unreachable by exec", async () => {
    // The exact observed shape: gmail active in fl-api, absent from iris-api, exec 404s.
    const r = await readIntegrationStores(STORES, async (base) =>
      ok({ connections: base.includes("freelabel") ? [] : [gmail(3), gmail(14)] }),
    )
    expect(r.rows).toHaveLength(2)
    expect(r.unreachableByExecCount).toBe(2)
    expect(r.failure).toBeNull()
  })

  test("an account wholly inside exec's store reports zero unreachable", async () => {
    const r = await readIntegrationStores(STORES, async (base) =>
      ok({ connections: base.includes("freelabel") ? [gmail(1)] : [] }),
    )
    expect(r.unreachableByExecCount).toBe(0)
  })

  test("reading only fl-api would have hidden the problem entirely", async () => {
    // The old behaviour, reconstructed: one store, no label, no executability.
    const flOnly: StoreRef[] = [STORES[1]]
    const r = await readIntegrationStores(flOnly, async () => ok({ connections: [gmail(3)] }))
    // It still finds the row — which is exactly why the bug was invisible. The difference
    // is that now the row carries the fact that exec cannot use it.
    expect(r.rows).toHaveLength(1)
    expect(r.rows?.[0].inExecStore).toBe(false)
  })

  test("ONE store down: rows still returned, and the gap is named", async () => {
    const r = await readIntegrationStores(STORES, async (base) => {
      if (base.includes("freelabel")) return { ok: false, status: 503 }
      return ok({ connections: [gmail(3)] })
    })
    expect(r.failure).toBeNull()
    expect(r.rows).toHaveLength(1)
    expect(r.unreachable).toEqual(["iris-api (HTTP 503)"])
  })

  test("ALL stores down is a FAILED LOOKUP, never an empty account", async () => {
    // The false negative that sends people into a reconnect loop. `rows` must be null,
    // not [], so no caller can render it as "No integrations connected."
    const r = await readIntegrationStores(STORES, async () => ({ ok: false, status: 500 }))
    expect(r.rows).toBeNull()
    expect(r.failure).toContain("could not reach any integration store")
    expect(r.failure).toContain("iris-api (HTTP 500)")
    expect(r.failure).toContain("fl-api (HTTP 500)")
  })

  test("a thrown network error is captured, not swallowed", async () => {
    const r = await readIntegrationStores(STORES, async () => {
      throw new Error("getaddrinfo ENOTFOUND")
    })
    expect(r.rows).toBeNull()
    expect(r.failure).toContain("ENOTFOUND")
  })

  test("one store throwing still yields the other's rows", async () => {
    const r = await readIntegrationStores(STORES, async (base) => {
      if (base.includes("freelabel")) throw new Error("socket hang up")
      return ok({ connections: [gmail(3)] })
    })
    expect(r.rows).toHaveLength(1)
    expect(r.unreachable[0]).toContain("socket hang up")
  })

  test("an empty but REACHABLE account is [] — distinct from a failed lookup", async () => {
    const r = await readIntegrationStores(STORES, async () => ok({ connections: [] }))
    expect(r.rows).toEqual([])
    expect(r.failure).toBeNull()
  })
})

describe("the flag does not overclaim", () => {
  test("inExecStore is about the STORE, never a promise the row works", async () => {
    // A row in iris-api's table can still lack a Composio account id and 400 at exec time.
    // This module says which store holds a row and nothing more — asserting "executable"
    // would be the same overclaim it exists to remove (#178282, #184151).
    const r = await readIntegrationStores(STORES, async (base) =>
      ok({ connections: base.includes("freelabel") ? [{ ...gmail(1), credentials: [] }] : [] }),
    )
    const row = r.rows?.[0]
    expect(row?.inExecStore).toBe(true)
    // No field claims the connection is usable, because nothing here checked.
    expect(row).not.toHaveProperty("executable")
    expect(row).not.toHaveProperty("verified")
    expect(r.unreachableByExecCount).toBe(0)
  })
})

describe("envelope shapes", () => {
  test("connections, data, and a bare array all parse", () => {
    expect(rowsFromEnvelope({ connections: [1, 2] })).toEqual([1, 2])
    expect(rowsFromEnvelope({ data: [3] })).toEqual([3])
    expect(rowsFromEnvelope([4, 5])).toEqual([4, 5])
  })

  test("a shape with no rows yields [] rather than throwing", () => {
    expect(rowsFromEnvelope({ message: "nope" })).toEqual([])
    expect(rowsFromEnvelope(null)).toEqual([])
    expect(rowsFromEnvelope(undefined)).toEqual([])
  })
})

// ============================================================================
// Cross-store status disagreement (#184152, measured 2026-09-08)
// ============================================================================

import { findStatusDisagreements, describeDisagreement } from "../../src/cli/cmd/integration-stores"

const row = (store: string, type: string, status: string, id: number) => ({
  id, type, status, store, inExecStore: store === "iris-api",
})

describe("cross-store status disagreement (#184152)", () => {
  test("THE MEASURED CASE — gmail active in fl-api, expired in iris-api", async () => {
    // Exactly what was read on 2026-09-08. execute-direct filters status='active' on
    // iris-api, matches nothing, and says "No active gmail connection found" — while the
    // listing read fl-api and showed Gmail connected.
    const rows = [
      row("iris-api", "gmail", "expired", 11),
      row("iris-api", "gmail", "expired", 116),
      row("fl-api", "gmail", "active", 3),
      row("fl-api", "gmail", "active", 14),
    ]
    const d = findStatusDisagreements(rows)
    expect(d).toHaveLength(1)
    expect(d[0].type).toBe("gmail")
    expect(d[0].byStore["iris-api"]).toEqual(["expired"])
    expect(d[0].byStore["fl-api"]).toEqual(["active"])
    expect(describeDisagreement(d[0])).toContain("iris-api=expired")
    expect(describeDisagreement(d[0])).toContain("fl-api=active")
  })

  test("agreement across stores is NOT reported", async () => {
    const rows = [row("iris-api", "gmail", "active", 11), row("fl-api", "gmail", "active", 3)]
    expect(findStatusDisagreements(rows)).toEqual([])
  })

  test("a type in only ONE store cannot disagree — that is the phantom case, not this one", () => {
    const rows = [row("fl-api", "dropbox", "active", 5), row("fl-api", "dropbox", "expired", 6)]
    // Differing statuses WITHIN one store is a different problem (stale duplicates, #182325)
    // and must not be reported as the two-database contradiction.
    expect(findStatusDisagreements(rows)).toEqual([])
  })

  test("several types disagreeing are all reported, sorted", () => {
    const rows = [
      row("iris-api", "gmail", "expired", 1),
      row("fl-api", "gmail", "active", 2),
      row("iris-api", "dropbox", "active", 3),
      row("fl-api", "dropbox", "revoked", 4),
    ]
    expect(findStatusDisagreements(rows).map((d) => d.type)).toEqual(["dropbox", "gmail"])
  })

  test("rows with no type are ignored rather than grouped under empty string", () => {
    const rows = [{ id: 1, status: "active", store: "fl-api", inExecStore: false } as any]
    expect(findStatusDisagreements(rows)).toEqual([])
  })

  test("status is compared case-insensitively", () => {
    const rows = [row("iris-api", "gmail", "ACTIVE", 1), row("fl-api", "gmail", "active", 2)]
    expect(findStatusDisagreements(rows)).toEqual([])
  })
})
