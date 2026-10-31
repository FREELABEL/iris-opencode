import { describe, expect, test } from "bun:test"
import { formatPrice, planButtonLabel, plansDialogCopy, requestCheckout, type FetchJson } from "./dialog-upgrade"

describe("formatPrice", () => {
  test("whole dollars with a period suffix", () => {
    expect(formatPrice(199, "month")).toBe("$199/mo")
    expect(formatPrice(2399, "month")).toBe("$2,399/mo")
    expect(formatPrice(1500, "year")).toBe("$1,500/yr")
  })
})

describe("requestCheckout — the plan button goes to Stripe, not a web page (#190190)", () => {
  const answering = (answer: unknown, seen: { path?: string; init?: RequestInit } = {}) =>
    (async (path: string, init?: RequestInit) => {
      seen.path = path
      seen.init = init
      return answer
    }) as FetchJson

  test("POSTs the plan to the sidecar and hands back Stripe's URL", async () => {
    const seen: { path?: string; init?: RequestInit } = {}
    const r = await requestCheckout(answering({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_x" }, seen), "iris-personal-monthly")
    expect(r).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_x" })
    expect(seen.path).toBe("/iris/checkout")
    expect(seen.init?.method).toBe("POST")
    expect(JSON.parse(String(seen.init?.body))).toEqual({ slug: "iris-personal-monthly" })
  })

  test("a refusal comes back as the server's sentence, so the dialog can show it", async () => {
    const r = await requestCheckout(
      answering({ ok: false, reason: "Your sign-in has expired. Sign in again, then choose the plan." }),
      "iris-solo-monthly",
    )
    expect(r).toEqual({ error: "Your sign-in has expired. Sign in again, then choose the plan." })
  })

  test("ok without a URL is still a failure — never a silent no-op", async () => {
    expect(await requestCheckout(answering({ ok: true }), "x")).toHaveProperty("error")
  })

  test("a thrown fetch (sidecar restarting) is a message, not an exception", async () => {
    const r = await requestCheckout((async () => {
      throw new Error("connection refused")
    }) as FetchJson, "x")
    expect("error" in r && r.error).toContain("connection refused")
  })
})

describe("planButtonLabel", () => {
  test("no trial wording — the weekly allowance is the trial", () => {
    expect(planButtonLabel({ slug: "a", title: "Solo" }, null)).toBe("Choose Solo")
  })
  test("only the chosen plan says it is opening", () => {
    expect(planButtonLabel({ slug: "a", title: "Solo" }, "a")).toBe("Opening checkout…")
    expect(planButtonLabel({ slug: "b", title: "Pro" }, "a")).toBe("Choose Pro")
  })
})

// #189544: paid accounts had no way to see the plans; when they do, they are not told to upgrade.
describe("plansDialogCopy", () => {
  test("someone who pays sees 'Your plan' and is never told to upgrade", () => {
    const copy = plansDialogCopy(true)
    expect(copy.title).toBe("Your plan")
    expect(`${copy.title} ${copy.description}`).not.toMatch(/upgrade/i)
  })

  test("only someone we know has not paid is asked to upgrade", () => {
    expect(plansDialogCopy(false).title).toBe("Upgrade IRIS")
    expect(plansDialogCopy(null).title).toBe("IRIS plans")
    expect(plansDialogCopy(undefined).title).toBe("IRIS plans")
  })
})
