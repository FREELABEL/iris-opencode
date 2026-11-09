import { expect, test } from "bun:test"
import {
  parsePrice,
  dollars,
  formatPrice,
  checksSummary,
  runLine,
  browseRows,
  pickListing,
  pickNode,
  earningsLines,
  spendLines,
  type Listing,
} from "../../src/cli/cmd/platform-hive-market"

// #192752 — the Hive marketplace. Amounts are IRIS credits: 1 credit = $0.01.

test("reads a price in dollars or cents as whole credits", () => {
  expect(parsePrice("0.45")).toEqual({ credits: 45 })
  expect(parsePrice("$0.45")).toEqual({ credits: 45 })
  expect(parsePrice("45c")).toEqual({ credits: 45 })
  expect(parsePrice(" 1.5 ")).toEqual({ credits: 150 })
  expect(parsePrice("$2/hr")).toEqual({ credits: 200 })
  expect(parsePrice(".455")).toEqual({ credits: 46 })
  expect(parsePrice("1000")).toEqual({ credits: 100_000 })
})

test("refuses negatives, nonsense, zero and anything over $1,000/hr", () => {
  expect(parsePrice("-0.45")).toMatchObject({ error: expect.stringContaining("negative") })
  expect(parsePrice("-5c")).toMatchObject({ error: expect.stringContaining("negative") })
  expect(parsePrice("NaN")).toMatchObject({ error: expect.stringContaining("not a price") })
  expect(parsePrice("abc")).toMatchObject({ error: expect.stringContaining("not a price") })
  expect(parsePrice("")).toMatchObject({ error: expect.any(String) })
  expect(parsePrice(undefined)).toMatchObject({ error: expect.any(String) })
  expect(parsePrice("0")).toMatchObject({ error: expect.stringContaining("lowest") })
  expect(parsePrice("0.001")).toMatchObject({ error: expect.stringContaining("lowest") })
  expect(parsePrice("1000.01")).toMatchObject({ error: expect.stringContaining("highest") })
  expect(parsePrice("100001c")).toMatchObject({ error: expect.stringContaining("highest") })
})

test("formats credits as dollars", () => {
  expect(formatPrice(45)).toBe("$0.45/hr")
  expect(formatPrice(100)).toBe("$1.00/hr")
  expect(dollars(123450)).toBe("$1,234.50")
  expect(dollars(0)).toBe("$0.00")
  expect(dollars(null)).toBe("$0.00")
  expect(dollars(-5)).toBe("-$0.05")
})

const NOW = Date.parse("2026-11-09T12:00:00Z")

test("a check summary says the newer of the last pass and the last fail", () => {
  expect(checksSummary({ last_pass_at: "2026-11-09T11:56:00Z", last_fail_at: null, passed: 4, failed: 0 }, NOW)).toBe("checked 4m ago")
  expect(checksSummary({ last_pass_at: "2026-11-09T11:56:00Z", last_fail_at: "2026-11-09T11:58:00Z", passed: 4, failed: 1 }, NOW)).toBe("failed a check")
  expect(checksSummary({ last_pass_at: "2026-11-09T11:59:00Z", last_fail_at: "2026-11-09T10:00:00Z", passed: 4, failed: 1 }, NOW)).toBe("checked 1m ago")
  expect(checksSummary({ last_pass_at: null, last_fail_at: null, passed: 0, failed: 0 }, NOW)).toBe("not checked yet")
  expect(checksSummary(null, NOW)).toBe("not checked yet")
})

function listing(o: Partial<Listing>): Listing {
  return {
    id: "01aa0000-0000",
    owner_user_id: 193,
    owner_name: "Alex",
    node_id: "n1",
    node_name: "studio-mac",
    title: null,
    description: null,
    models: ["llama3.2:3b"],
    price_credits_per_hour: 45,
    status: "online",
    hardware: { cores: 10, ram_gb: 32, gpu: null },
    checks: { last_pass_at: null, last_fail_at: null, passed: 0, failed: 0 },
    jobs_done: 0,
    ...o,
  }
}

test("the run line a buyer copies names the owner and the model", () => {
  expect(runLine(listing({}))).toBe('iris run -m iris/hive/@193/llama3.2:3b "…"')
  expect(runLine(listing({ models: ["a", "qwen3:14b"] }), "qwen3:14b")).toBe('iris run -m iris/hive/@193/qwen3:14b "…"')
  expect(runLine(listing({ models: [] }))).toBeNull()
  expect(runLine(listing({ models: {} as any }))).toBeNull()
})

test("browse puts online machines first, cheapest first, and filters by model", () => {
  const rows = [
    listing({ id: "a", price_credits_per_hour: 90 }),
    listing({ id: "b", price_credits_per_hour: 10, status: "offline" }),
    listing({ id: "c", price_credits_per_hour: 30, models: ["qwen3:14b"] }),
  ]
  expect(browseRows(rows).map((l) => l.id)).toEqual(["c", "a", "b"])
  expect(browseRows(rows, "qwen3:14b").map((l) => l.id)).toEqual(["c"])
  expect(browseRows(rows, "llama3.2").map((l) => l.id)).toEqual(["a", "b"])
  expect(browseRows(rows, "mistral")).toEqual([])
})

test("picks a listing by id, unique id prefix, or machine name — and refuses an ambiguous one", () => {
  const mine = [listing({ id: "01aa1111-x", node_name: "studio-mac" }), listing({ id: "01aaffff-y", node_name: "gpu-box", title: "Big GPU" })]
  expect(pickListing(mine, "01aa1111-x")).toMatchObject({ node_name: "studio-mac" })
  expect(pickListing(mine, "01aaf")).toMatchObject({ node_name: "gpu-box" })
  expect(pickListing(mine, "Studio-Mac")).toMatchObject({ id: "01aa1111-x" })
  expect(pickListing(mine, "big gpu")).toMatchObject({ id: "01aaffff-y" })
  expect(pickListing(mine, "01aa")).toMatchObject({ error: expect.stringContaining("matches 2") })
  expect(pickListing(mine, "nope")).toMatchObject({ error: expect.stringContaining("none of your listings") })
  expect(pickListing(mine, "")).toMatchObject({ error: expect.any(String) })
})

test("picks a machine from the fleet by name or id", () => {
  const nodes = [
    { id: "9f00-a", name: "studio-mac" },
    { id: "9f11-b", name: "gpu-box" },
  ]
  expect(pickNode(nodes, "gpu-box")).toMatchObject({ id: "9f11-b" })
  expect(pickNode(nodes, "9f00")).toMatchObject({ name: "studio-mac" })
  expect(pickNode(nodes, "9f")).toMatchObject({ error: expect.stringContaining("matches 2") })
  expect(pickNode(nodes, "laptop")).toMatchObject({ error: expect.stringContaining("none of your machines") })
})

test("earnings: totals in dollars, then recent charges", () => {
  const lines = earningsLines({
    held: 120,
    released: 4500,
    refunded: 30,
    fee_percent: 15,
    charges: [
      { id: "1", buyer_name: "Robyn", model: "llama3.2:3b", seconds: 125, amount: 3, fee: 0, net: 3, status: "released", created_at: "2026-11-08T10:00:00Z", settled_at: "2026-11-08T10:05:00Z" },
    ],
  })
  expect(lines[0]).toBe("Held $1.20   ·   Paid $45.00   ·   Refunded $0.30   ·   IRIS fee 15%")
  expect(lines[2]).toContain("2026-11-08")
  expect(lines[2]).toContain("Robyn")
  expect(lines[2]).toContain("3 min")
  expect(lines[2]).toContain("paid")
  expect(earningsLines({ held: 0, released: 0, refunded: 0, fee_percent: 15, charges: {} as any })[1]).toContain("No charges yet")
  expect(earningsLines(null)[0]).toContain("Held $0.00")
})

test("spend: total, then what was paid to whom", () => {
  const lines = spendLines({ total: 245, charges: [{ id: "1", owner_name: "Alex", model: "qwen3:14b", seconds: 60, amount: 45, status: "held", created_at: "2026-11-09T09:00:00Z" }] })
  expect(lines[0]).toBe("Spent $2.45 on other members' machines")
  expect(lines[2]).toContain("Alex")
  expect(lines[2]).toContain("1 min")
  expect(lines[2]).toContain("$0.45")
  expect(spendLines({ total: 0, charges: [] })[1]).toContain("Nothing yet")
})
