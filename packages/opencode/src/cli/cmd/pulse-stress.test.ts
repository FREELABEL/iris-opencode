import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  foldKeyword,
  keywordVariants,
  topicQuality,
  rowMentions,
  markCapped,
  sweepBloq,
  ATLAS_PAGE,
  type SweepOptions,
  type SourceSweep,
} from "./pulse-check-sweep"
import {
  storedLeadScore,
  channelFetchLimit,
  CHANNEL_FETCH_LIMIT,
  threadInWindow,
  validPulseDays,
  adminLeadName,
  ungatedForLoaded,
  pulseSortKey,
  pulseSortKeyAsc,
  measuredAverage,
} from "./platform-leads-honesty"

// Pulse stress test, 2026-10-13 — every case here was found by running the CLI against live data.

const opts = (o: Partial<SweepOptions>): SweepOptions => ({ keyword: "heartbeat", repo: ".", windowDays: 7, limit: 20, sources: [], ...o })
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })

describe("#189199 `iris pulse <topic>` is the topic sweep", () => {
  test("the pulse product declares a topic positional beside its subcommands", () => {
    const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
    expect(src).toContain('command: "pulse [keyword..]"')
    // and the handler routes a topic to the sweep before anything else runs
    const handler = src.slice(src.indexOf('command: "pulse [keyword..]"'))
    expect(handler.indexOf("runPulseCheck({ ...args, keyword: topic }, true)")).toBeLessThan(handler.indexOf("requireAuth()"))
  })
  test("productCommand uses the declared command string, defaulting to the name", () => {
    const src = readFileSync(join(import.meta.dir, "product-command.ts"), "utf8")
    expect(src).toContain("command: spec.command ?? spec.name")
  })
})

describe("#189202 accents are folded, not turned into separators", () => {
  test("café naïve → cafe naive", () => {
    expect(foldKeyword("Café Naïve")).toBe("cafe naive")
    expect(keywordVariants("🚀 café naïve")).toContain("cafe naive")
    expect(keywordVariants("🚀 café naïve")).not.toContain("caf na ve")
  })
})

describe("#189200 a topic has to be able to mean something", () => {
  test("one character is refused", () => {
    expect(topicQuality("a").refuse).toContain("1 character")
    expect(topicQuality("[a-").refuse).toContain("1 character") // collapses to "a"
    expect(topicQuality(".*").refuse).toContain("no searchable characters")
  })
  test("stopwords and two letters run, with a warning", () => {
    expect(topicQuality("the").warn).toContain("common word")
    expect(topicQuality("ai").warn).toContain("two letters")
    expect(topicQuality("heartbeat")).toEqual({})
    expect(topicQuality("the heartbeat")).toEqual({}) // a common word inside a real topic is fine
  })
})

describe("#189201 an Atlas row counts only when it says the topic", () => {
  test("loose search rows are not hits", () => {
    expect(rowMentions({ title: "Revenue plan — weeks of 2026-10-12" }, `it's "quoted"`)).toBe(false)
    expect(rowMentions({ title: "BUG: it’s quoted wrong", description: "" }, `it's "quoted"`)).toBe(true)
    expect(rowMentions({ title: "x", content: "the Life-Atlas board" }, "life atlas")).toBe(true)
    expect(rowMentions({ title: "Café menu" }, "cafe")).toBe(true)
  })
  test("sweepBloq drops the rows that do not mention it, and a page of junk is not 'capped'", async () => {
    const now = new Date().toISOString()
    const junk = Array.from({ length: ATLAS_PAGE }, (_, i) => ({ id: i, title: `unrelated ${i}`, updated_at: now }))
    const fetch = async (path: string) => {
      if (path.includes("/bloqs?")) return json({ data: [{ id: 3, name: "Other" }] })
      if (path.includes("content-items")) return json({ data: { items: [...junk.slice(0, 99), { id: 999, title: "Heartbeat skipped", updated_at: now }] } })
      return json({ data: [] })
    }
    const s = await sweepBloq(opts({ apiFetch: fetch as any, userId: 193 }))
    expect(s.hits).toBe(1)
    expect(s.capped).toBeUndefined()
  })
})

describe("#189203 a capped count is a floor, kept out of momentum", () => {
  test("markCapped", () => {
    const s: SourceSweep = { source: "git", searched: true, hits: 200, hitsPrior: 200, items: [] }
    markCapped(s, true, 200)
    expect(s.capped).toBe(true)
    expect(s.hitsPrior).toBeUndefined()
    expect(s.unavailableReason).toContain("at least 200")
    const t: SourceSweep = { source: "git", searched: true, hits: 3, hitsPrior: 1, items: [] }
    expect(markCapped(t, false, 200).hitsPrior).toBe(1)
  })
  test("a full page that all matched is capped", async () => {
    const now = new Date().toISOString()
    const rows = Array.from({ length: ATLAS_PAGE }, (_, i) => ({ id: i, title: `heartbeat ${i}`, updated_at: now }))
    const fetch = async (path: string) => {
      if (path.includes("/bloqs?")) return json({ data: [{ id: 3, name: "Other" }] })
      if (path.includes("content-items")) return json({ data: { items: rows } })
      return json({ data: [] })
    }
    const s = await sweepBloq(opts({ apiFetch: fetch as any, userId: 193 }))
    expect(s.capped).toBe(true)
    expect(s.hitsPrior).toBeUndefined()
  })
})

describe("#189204 a read shows the stored score", () => {
  test("from the lead, labelled stored", () => {
    expect(storedLeadScore({ id: 15336, lead_score: 43, is_hot_lead: 0, score_updated_at: "2026-10-12 23:59:23" })).toEqual({
      lead_id: 15336,
      score: 43,
      is_hot_lead: false,
      score_updated_at: "2026-10-12 23:59:23",
      source: "stored",
    })
    expect(storedLeadScore({ id: 1 }).score).toBeNull() // never scored is not 0
  })
  test("leads pulse only calls the recomputing endpoint with --save", () => {
    const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
    expect(src).toContain("shouldFileComms(args as { save?: unknown }) ? irisFetch(`/api/v1/leads/${leadId}/score`) : Promise.resolve(null)")
  })
})

describe("#189205 --days is a window and --limit is a display", () => {
  test("fetch for a count, show the limit", () => {
    expect(channelFetchLimit(0)).toBe(CHANNEL_FETCH_LIMIT)
    expect(channelFetchLimit(50)).toBe(CHANNEL_FETCH_LIMIT)
    expect(channelFetchLimit(900)).toBe(900)
  })
  test("threads outside the window are out; undated threads stay", () => {
    const now = Date.parse("2026-10-13T00:00:00Z")
    expect(threadInWindow({ date: "2026-05-26 20:58:23" }, 30, now)).toBe(false)
    expect(threadInWindow({ date: "2026-05-26 20:58:23" }, 3650, now)).toBe(true)
    expect(threadInWindow({ date: "2026-10-12 09:00:00" }, 1, now)).toBe(true)
    expect(threadInWindow({ date: "" }, 1, now)).toBe(true)
  })
  test("--days below 1 is refused", () => {
    expect(validPulseDays(0)).toBeNull()
    expect(validPulseDays(-5)).toBeNull()
    expect(validPulseDays("x")).toBeNull()
    expect(validPulseDays(30)).toBe(30)
  })
})

describe("#189207 the agency scorecard", () => {
  test("names come from `name`", () => {
    expect(adminLeadName({ id: 10445, name: "Believe (Ty)", full_name: null })).toBe("Believe (Ty)")
    expect(adminLeadName({ id: 7, company: "Acme" })).toBe("Acme")
    expect(adminLeadName({ id: 7 })).toBe("#7")
  })
  test("ungated is filtered to the loaded leads", () => {
    const deals = [
      { lead_id: 1, has_gate: false },
      { lead_id: 2, has_gate: true },
      { lead_id: 3, has_gate: false },
    ]
    expect(ungatedForLoaded(deals, new Set([1, 2])).map((d) => d.lead_id)).toEqual([1])
    expect(ungatedForLoaded(deals, new Set())).toEqual([])
    expect(ungatedForLoaded(deals, null).map((d) => d.lead_id)).toEqual([1, 3])
  })
  test("an unmeasured row is never the worst deal or part of the average", () => {
    const rows = [
      { pulse: 0, band: "error" },
      { pulse: 10, band: "failing" },
      { pulse: 50, band: "warning" },
    ]
    expect([...rows].sort((a, b) => pulseSortKeyAsc(a) - pulseSortKeyAsc(b))[0].pulse).toBe(10)
    expect([...rows].sort((a, b) => pulseSortKey(b) - pulseSortKey(a)).at(-1)?.band).toBe("error")
    expect(measuredAverage(rows)).toBe(30)
  })
})

describe("#189206 #189208 #189209 --json is one document, and a failure exits 1", () => {
  const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
  test("admin mutes stdout and writes the scorecard", () => {
    expect(src).toContain("const adminGate = args.json ? muteStdout() : null")
    expect(src).toContain("scorecard: adminOut.scorecard")
  })
  test("leads pulse: success:false sets exit 1", () => {
    expect(src).toContain("if ((payload as any)?.success === false) process.exitCode = 1")
  })
  test("alerts list honours --json", () => {
    expect(src).toContain("await writeJson({ success: true, rules })")
  })
})

describe("#189199 the bare and the `check` spellings take the same options", () => {
  test("pulseCheckOptions() and the check builder declare the same option names", () => {
    const src = readFileSync(join(import.meta.dir, "platform-pulse-check.ts"), "utf8")
    const names = (block: string) => [...block.matchAll(/\.option\("([a-z-]+)"/g)].map((m) => m[1]).filter((n) => n !== "json").sort()
    const fn = src.slice(src.indexOf("export function pulseCheckOptions"), src.indexOf("export const PulseCheckCommand"))
    const check = src.slice(src.indexOf("export const PulseCheckCommand"), src.indexOf("async handler(args)", src.indexOf("export const PulseCheckCommand")))
    expect(names(fn).length).toBeGreaterThan(4)
    expect(names(check)).toEqual(names(fn))
  })
})
