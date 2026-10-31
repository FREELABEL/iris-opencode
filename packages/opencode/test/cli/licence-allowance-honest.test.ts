import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as prompts from "../../src/cli/cmd/clack"
import { UI } from "../../src/cli/ui"
import { IssueCmd, ShowCmd, allowanceWarning, poolRunsOutLine } from "../../src/cli/cmd/licence"

/** #191993: --allowance is not a ceiling, and every surface an operator reads has to say so. */

let written: string[] = []
const saved = { fetch: globalThis.fetch, stdout: process.stdout.write, stderr: process.stderr.write, key: process.env.IRIS_API_KEY }
const json = (body: unknown) => new Response(JSON.stringify(body))
const reply = (fn: (url: string) => unknown) => {
  globalThis.fetch = (async (url: any) => json(fn(String(url)))) as unknown as typeof fetch
}
const issued = (seat_cap_cents: number | null) => ({ data: { key: "IRIS-TEST", tier: "pro", seats: 2, allowance_cents: 100, seat_cap_cents } })
const showData = (seat_cap_cents: number | null, allowance_cents_per_month = 100) => ({
  data: {
    key: "IRIS-TEST",
    usage: { period: "2026-10", seats_total: 2, seats_claimed: 1, seats_unclaimed: 1, seats_active_this_month: 1, allowance_cents_per_month, allowance_used_cents_this_month: 100, seat_cap_cents, seats: [] },
  },
})

beforeEach(() => {
  written = []
  process.exitCode = 0
  process.env.IRIS_API_KEY = "test-token"
  const capture = ((chunk: any, cb?: any) => {
    written.push(String(chunk))
    if (typeof cb === "function") cb()
    return true
  }) as typeof process.stdout.write
  process.stdout.write = capture
  process.stderr.write = capture
  // Text output goes out by three routes that bypass process.stdout.write.
  const line = (...a: unknown[]) => void written.push(a.join(" ") + "\n")
  spyOn(console, "log").mockImplementation(line)
  spyOn(UI, "println").mockImplementation(line)
  spyOn(prompts.log, "warn").mockImplementation(line)
})

afterEach(() => {
  mock.restore()
  globalThis.fetch = saved.fetch
  process.stdout.write = saved.stdout
  process.stderr.write = saved.stderr
  process.exitCode = 0
  if (saved.key === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = saved.key
})

test("an allowance with no seat cap warns that it is not a limit", () => {
  const w = allowanceWarning(100, null)!
  expect(w).toContain("$1.00 allowance is not a spending limit")
  expect(w).toContain("--seat-cap")
  expect(allowanceWarning(100, undefined)).toBe(w)
})

test("no warning with a seat cap, or with no allowance to misread", () => {
  expect(allowanceWarning(100, 500)).toBeUndefined()
  expect(allowanceWarning(0, null)).toBeUndefined()
  expect(allowanceWarning(undefined, null)).toBeUndefined()
})

test("says what happens when the pool runs out, with and without a seat cap", () => {
  expect(poolRunsOutLine(100, null)).toContain("Nothing on this licence stops them sooner")
  expect(poolRunsOutLine(100, 500)).toContain("$5.00 monthly seat cap")
  expect(poolRunsOutLine(0, 500)).toBeUndefined()
})

test("issue --json carries the warning field when uncapped", async () => {
  reply(() => issued(null))
  await (IssueCmd as any).handler({ tier: "pro", seats: 2, allowance: 100, json: true })
  expect(JSON.parse(written.join("")).warning).toContain("not a spending limit")
})

test("issue --json has no warning field when capped", async () => {
  reply(() => issued(500))
  await (IssueCmd as any).handler({ tier: "pro", seats: 2, allowance: 100, seatCap: 500, json: true })
  expect(JSON.parse(written.join("")).warning).toBeUndefined()
})

test("issue text shows the warning and what happens when the pool runs out", async () => {
  reply(() => issued(null))
  await (IssueCmd as any).handler({ tier: "pro", seats: 2, allowance: 100 })
  const out = written.join("")
  expect(out).toContain("not a spending limit")
  expect(out).toContain("Nothing on this licence stops them sooner")
})

test("issue text with a seat cap names the cap and does not warn", async () => {
  reply(() => issued(500))
  await (IssueCmd as any).handler({ tier: "pro", seats: 2, allowance: 100, seatCap: 500 })
  const out = written.join("")
  expect(out).not.toContain("not a spending limit")
  expect(out).toContain("$5.00 monthly seat cap")
})

test("show says what happens when the pool runs out", async () => {
  reply((url) => (url.endsWith("/seats") ? { data: {} } : showData(null)))
  await (ShowCmd as any).handler({ key: "IRIS-TEST" })
  expect(written.join("")).toContain("when the pool runs out: seats keep working and spending")
})

test("show --json carries it, and leaves a licence with no allowance alone", async () => {
  reply(() => showData(500))
  await (ShowCmd as any).handler({ key: "IRIS-TEST", json: true })
  expect(JSON.parse(written.join("")).pool_runs_out).toContain("$5.00 monthly seat cap")

  written = []
  reply(() => showData(null, 0))
  await (ShowCmd as any).handler({ key: "IRIS-TEST", json: true })
  expect(JSON.parse(written.join("")).pool_runs_out).toBeUndefined()
})

test("--allowance help says it is not a limit and points at --seat-cap", () => {
  const opts: Record<string, any> = {}
  const y: any = { option: (n: string, o: any) => ((opts[n] = o), y) }
  ;(IssueCmd as any).builder(y)
  expect(opts.allowance.describe).toContain("NOT a spending limit")
  expect(opts.allowance.describe).toContain("--seat-cap")
})
