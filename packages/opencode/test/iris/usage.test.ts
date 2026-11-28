import { afterEach, describe, expect, mock, test } from "bun:test"
import { fetchPlan } from "../../src/iris/platform"
import { createTopup, fetchAutoTopup, fetchInvite, fetchTopupPacks, saveAutoTopup } from "../../src/iris/usage"
import { autoTopupFrom, inviteFrom, planUsageFrom, topupPacksFrom } from "../../src/iris/usage-shape"

/**
 * Epic #194525 — usage as a progression. The bodies below are the contract the backend agents are
 * building (fl-iris-api /api/v6/allowance/me; fl-api /api/v1/usage/*). If either side renames a
 * field this fails here, instead of a ring that silently renders today's UI forever.
 */
const ALLOWANCE = {
  window: "week",
  plan: "free",
  paid: false,
  plan_label: "Free",
  fraction: 0.92,
  tokens_used: 8_600_000,
  resets_at: "2026-11-30T00:00:00Z",
  uncapped: false,
  upgrade_url: null,
  cap_tokens: 9_400_000,
  grant_tokens: 0,
  next_tier: { slug: "iris-solo-monthly", label: "Solo", price_usd: 29, period: "month", cap_tokens_week: 47_000_000 },
  runout_at: "2026-11-28T14:00:00Z",
  progress: {
    level: { key: "explorer", label: "Explorer" },
    next_level: { key: "builder", label: "Builder", requires: "Publish a page" },
    checklist: [
      { key: "first_agent", label: "Run your first agent", done: true, reward_tokens: 1_000_000 },
      { key: "first_page", label: "Publish a page", done: false, reward_tokens: 2_000_000 },
      { key: "", label: "broken row" },
    ],
    streak_weeks: 3,
  },
  last_week: { runs: 38, tokens: 7_100_000, agent_runs: 12, pages_published: 4 },
}

describe("planUsageFrom", () => {
  test("maps every new field into the app's casing", () => {
    const u = planUsageFrom(ALLOWANCE)
    expect(u.capTokens).toBe(9_400_000)
    expect(u.grantTokens).toBe(0)
    expect(u.nextTier).toEqual({ slug: "iris-solo-monthly", label: "Solo", priceUsd: 29, period: "month", capTokensWeek: 47_000_000 })
    expect(u.runoutAt).toBe("2026-11-28T14:00:00Z")
    expect(u.progress?.level).toEqual({ key: "explorer", label: "Explorer" })
    expect(u.progress?.nextLevel).toEqual({ key: "builder", label: "Builder", requires: "Publish a page" })
    expect(u.progress?.checklist).toHaveLength(2)
    expect(u.progress?.checklist[0]).toEqual({ key: "first_agent", label: "Run your first agent", done: true, rewardTokens: 1_000_000 })
    expect(u.progress?.streakWeeks).toBe(3)
    expect(u.lastWeek).toEqual({ runs: 38, tokens: 7_100_000, agentRuns: 12, pagesPublished: 4 })
  })

  test("today's server sends none of them, and none appear — absent is not null", () => {
    const { cap_tokens, grant_tokens, next_tier, runout_at, progress, last_week, ...today } = ALLOWANCE
    expect(planUsageFrom(today)).toEqual({})
    expect(planUsageFrom(null)).toEqual({})
  })

  test("sent but broken reads as null, never a guessed number", () => {
    const u = planUsageFrom({ cap_tokens: "lots", next_tier: { label: "Solo" }, runout_at: "", progress: 5, last_week: null })
    expect(u).toEqual({ capTokens: null, nextTier: null, runoutAt: null, progress: null, lastWeek: null })
  })
})

describe("fl-api usage bodies", () => {
  test("packs: unpriced or empty packs are dropped", () => {
    expect(
      topupPacksFrom({
        packs: [
          { key: "70m", tokens: 70_000_000, price_usd: 10, label: "70M tokens" },
          { key: "free", tokens: 1 },
          { key: "zero", tokens: 0, price_usd: 1 },
        ],
      }),
    ).toEqual([{ key: "70m", tokens: 70_000_000, priceUsd: 10, label: "70M tokens" }])
    expect(topupPacksFrom({ data: { packs: [{ key: "a", tokens: 5, price_usd: 1 }] } })).toHaveLength(1)
    expect(topupPacksFrom(null)).toEqual([])
  })

  test("invite and auto top-up, bare or wrapped in data", () => {
    const inv = { url: "https://heyiris.io/i/abc", code: "abc", reward_tokens: 10_000_000, invited: 2, rewarded: 1 }
    expect(inviteFrom(inv)).toEqual({ url: inv.url, code: "abc", rewardTokens: 10_000_000, invited: 2, rewarded: 1 })
    expect(inviteFrom({ data: inv })?.url).toBe(inv.url)
    expect(inviteFrom({ code: "abc" })).toBeNull()
    expect(autoTopupFrom({ enabled: true, pack: "70m", monthly_cap_usd: 50 })).toEqual({ enabled: true, pack: "70m", monthlyCapUsd: 50 })
    expect(autoTopupFrom({ data: { enabled: false } })).toEqual({ enabled: false, pack: null, monthlyCapUsd: null })
    expect(autoTopupFrom({})).toBeNull()
  })
})

describe("the calls — every failure is a sentence", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const answer = (status: number, body: unknown) =>
    (globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status })) as any)

  test("/iris/plan carries the new fields through fetchPlan", async () => {
    answer(200, ALLOWANCE)
    const r = await fetchPlan({ token: "t" })
    expect(r.measured).toBe(true)
    expect(r.data.capTokens).toBe(9_400_000)
    expect(r.data.nextTier?.label).toBe("Solo")
    expect(r.data.fraction).toBe(0.92)
  })

  test("top-up: POSTs the pack and returns Stripe's URL", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true, url: "https://checkout.stripe.com/x" }), { status: 200 })
    }) as any
    expect(await createTopup("70m")).toEqual({ ok: true, url: "https://checkout.stripe.com/x" })
    expect(calls[0].url).toEndWith("/api/v1/usage/topups/checkout")
    expect(calls[0].init.method).toBe("POST")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ pack: "70m" })
  })

  test("top-up refusals and network errors come back as sentences", async () => {
    answer(401, {})
    expect(await createTopup("70m")).toEqual({ ok: false, reason: "Your sign-in has expired. Sign in again, then try again." })
    answer(422, { message: "Unknown pack" })
    expect(await createTopup("70m")).toEqual({ ok: false, reason: "Top-up was refused (422): Unknown pack" })
    answer(200, { ok: true })
    expect(await createTopup("70m")).toEqual({ ok: false, reason: "Top-up checkout didn't open. Try again." })
    globalThis.fetch = mock(async () => {
      throw new Error("offline")
    }) as any
    expect(await createTopup("70m")).toEqual({ ok: false, reason: "Couldn't reach top-up checkout: offline" })
    expect(await createTopup(" ")).toEqual({ ok: false, reason: "Pick a top-up first." })
  })

  test("a server without the routes yet: unmeasured, with a sentence", async () => {
    answer(404, {})
    const packs = await fetchTopupPacks()
    expect(packs).toEqual({ measured: false, reason: "Top-ups isn't available on this account yet.", data: [] })
    expect((await fetchInvite()).measured).toBe(false)
    expect((await fetchAutoTopup()).reason).toBe("Auto top-up isn't available on this account yet.")
  })

  test("auto top-up PUT sends fl-api's casing; an empty answer keeps what was sent", async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = mock(async (_: string, init: RequestInit) => {
      calls.push(init)
      return new Response(null, { status: 204 })
    }) as any
    const r = await saveAutoTopup({ enabled: true, pack: "70m", monthlyCapUsd: 40 })
    expect(calls[0].method).toBe("PUT")
    expect(JSON.parse(String(calls[0].body))).toEqual({ enabled: true, pack: "70m", monthly_cap_usd: 40 })
    expect(r).toEqual({ measured: true, data: { enabled: true, pack: "70m", monthlyCapUsd: 40 } })
  })
})
