import { describe, expect, test } from "bun:test"
import type { FetchJson } from "@/components/dialog-upgrade"
import { loadAutoTopup, loadInvite, loadPacks, requestTopup, saveAutoTopup } from "./usage-actions"
import { reminderDelay } from "./usage-reminder"

const answering = (answer: unknown, seen: { path?: string; init?: RequestInit } = {}) =>
  (async (path: string, init?: RequestInit) => {
    seen.path = path
    seen.init = init
    return answer
  }) as FetchJson
const throwing = (async () => {
  throw new Error("sidecar restarting")
}) as FetchJson

describe("the popover's calls — every failure is a sentence (#194529)", () => {
  test("top-up POSTs the pack and hands back Stripe's URL", async () => {
    const seen: { path?: string; init?: RequestInit } = {}
    expect(await requestTopup(answering({ ok: true, url: "https://checkout.stripe.com/x" }, seen), "70m")).toEqual({
      url: "https://checkout.stripe.com/x",
    })
    expect(seen.path).toBe("/iris/topup")
    expect(seen.init?.method).toBe("POST")
    expect(JSON.parse(String(seen.init?.body))).toEqual({ pack: "70m" })
  })

  test("refusals, empty answers and thrown fetches all come back as words", async () => {
    expect(await requestTopup(answering({ ok: false, reason: "Your sign-in has expired." }), "70m")).toEqual({
      error: "Your sign-in has expired.",
    })
    expect(await requestTopup(answering({ ok: true }), "70m")).toEqual({ error: "Top-up checkout didn't open. Try again." })
    expect(await requestTopup(throwing, "70m")).toEqual({ error: "Top-up checkout didn't open: sidecar restarting" })
    expect(await loadPacks(answering({ measured: false, reason: "Top-ups isn't available on this account yet." }))).toEqual({
      error: "Top-ups isn't available on this account yet.",
    })
    expect("error" in (await loadInvite(throwing))).toBe(true)
    expect("error" in (await loadAutoTopup(answering({ measured: true, autoTopup: null })))).toBe(true)
  })

  test("reads that work", async () => {
    const packs = [{ key: "70m", tokens: 7e7, priceUsd: 10, label: null }]
    expect(await loadPacks(answering({ measured: true, packs }))).toEqual({ packs })
    const invite = { url: "https://heyiris.io/i/x", code: "x", rewardTokens: 1e7, invited: 0, rewarded: 0 }
    expect(await loadInvite(answering({ measured: true, invite }))).toEqual({ invite })
    const seen: { path?: string; init?: RequestInit } = {}
    const value = { enabled: true, pack: "70m", monthlyCapUsd: null }
    expect(await saveAutoTopup(answering({ measured: true, autoTopup: value }, seen), { enabled: true, pack: "70m" })).toEqual({ value })
    expect(seen.init?.method).toBe("PUT")
  })
})

describe("Remind me (#194530)", () => {
  test("only a future reset within a timer's reach is scheduled", () => {
    const now = Date.UTC(2026, 10, 27, 15)
    expect(reminderDelay(new Date(now + 3_600_000).toISOString(), now)).toBe(3_600_000)
    expect(reminderDelay(new Date(now - 1).toISOString(), now)).toBeNull()
    expect(reminderDelay("not a date", now)).toBeNull()
    expect(reminderDelay(null, now)).toBeNull()
    expect(reminderDelay(new Date(now + 40 * 86_400_000).toISOString(), now)).toBeNull()
  })
})
