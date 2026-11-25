import { describe, test, expect } from "bun:test"
import { upgradeUrl, upgradeClient } from "../../src/cli/cmd/pricing-url"
import { formatPaymentRequired } from "../../src/cli/cmd/iris-api"

const params = (u: string) => Object.fromEntries(new URL(u).searchParams)

describe("upgradeUrl", () => {
  test("adds the attribution tags to a bare pricing URL", () => {
    const out = upgradeUrl("https://web.heyiris.io/pricing", { surface: "pricing_cmd", client: "iris_cli" })
    expect(new URL(out).host).toBe("web.heyiris.io")
    expect(new URL(out).pathname).toBe("/pricing")
    expect(params(out)).toEqual({
      utm_source: "iris_cli",
      utm_medium: "app",
      utm_campaign: "upgrade",
      utm_content: "pricing_cmd",
    })
  })

  test("passes device_id when the surface knows it", () => {
    const out = upgradeUrl("https://web.heyiris.io/pricing", { surface: "x", deviceId: "dev-1", client: "iris_cli" })
    expect(params(out).device_id).toBe("dev-1")
  })

  test("preserves existing query and never overrides a param already present", () => {
    const out = upgradeUrl("https://web.heyiris.io/pricing?source=cli&device_id=abc&utm_source=ad_x", {
      surface: "install_script",
      deviceId: "other",
      client: "iris_cli",
    })
    const p = params(out)
    expect(p.source).toBe("cli")
    expect(p.device_id).toBe("abc")
    expect(p.utm_source).toBe("ad_x")
    expect(p.utm_content).toBe("install_script")
    expect(out.split("?").length).toBe(2)
  })

  test("is idempotent — applying twice does not duplicate params", () => {
    const once = upgradeUrl("https://web.heyiris.io/pricing", { surface: "a", client: "iris_cli" })
    const twice = upgradeUrl(once, { surface: "b", client: "iris_desktop" })
    expect(twice).toBe(once)
    expect(new URL(twice).searchParams.getAll("utm_source")).toEqual(["iris_cli"])
  })

  test("keeps the hash after the query", () => {
    const out = upgradeUrl("https://web.heyiris.io/pricing#pro", { surface: "s", client: "iris_cli" })
    expect(new URL(out).hash).toBe("#pro")
    expect(out.endsWith("#pro")).toBe(true)
    expect(params(out).utm_content).toBe("s")
  })

  test("FREELABEL links keep their FREELABEL host", () => {
    const out = upgradeUrl("https://web.freelabel.net/pricing", { surface: "pricing_cmd", client: "iris_desktop" })
    expect(new URL(out).host).toBe("web.freelabel.net")
    expect(params(out).utm_source).toBe("iris_desktop")
  })

  test("server checkout_url with a token: token kept, tags appended", () => {
    const out = upgradeUrl("https://web.heyiris.io/pricing?token=abc", { surface: "subscription_error", client: "iris_cli" })
    expect(out.startsWith("https://web.heyiris.io/pricing?token=abc&")).toBe(true)
    expect(params(out).utm_content).toBe("subscription_error")
  })

  test("leaves signed URLs, Stripe-hosted pages and junk untouched", () => {
    const signed = "https://web.heyiris.io/pricing?expires=1&signature=deadbeef"
    expect(upgradeUrl(signed, { surface: "s" })).toBe(signed)
    const stripe = "https://checkout.stripe.com/c/pay/cs_test_123#abc"
    expect(upgradeUrl(stripe, { surface: "s" })).toBe(stripe)
    expect(upgradeUrl("not a url", { surface: "s" })).toBe("not a url")
    expect(upgradeUrl("/pricing", { surface: "s" })).toBe("/pricing")
    expect(upgradeUrl("mailto:a@b.c", { surface: "s" })).toBe("mailto:a@b.c")
  })

  test("client defaults from OPENCODE_CLIENT (desktop sidecar sets it to desktop)", () => {
    expect(upgradeClient({ OPENCODE_CLIENT: "desktop" })).toBe("iris_desktop")
    expect(upgradeClient({ OPENCODE_CLIENT: "cli" })).toBe("iris_cli")
    expect(upgradeClient({})).toBe("iris_cli")
  })
})

describe("formatPaymentRequired tags paid links only", () => {
  test("checkout/upgrade/buy-credits are tagged; onboarding is printed verbatim", () => {
    const { details } = formatPaymentRequired({
      error: "subscription_required",
      checkout_url: "https://web.heyiris.io/pricing?token=abc",
      onboarding_url: "https://web.heyiris.io/onboarding?token=abc",
      buy_credits_url: "https://web.heyiris.io/credits",
      upgrade_url: "https://web.heyiris.io/pricing",
    })
    const line = (prefix: string) => details.find((d) => d.startsWith(prefix))!.slice(prefix.length)
    expect(params(line("checkout: ")).utm_content).toBe("subscription_error")
    expect(params(line("checkout: ")).token).toBe("abc")
    expect(params(line("upgrade: ")).utm_content).toBe("subscription_error")
    expect(params(line("buy credits: ")).utm_content).toBe("credits_error")
    expect(line("onboarding: ")).toBe("https://web.heyiris.io/onboarding?token=abc")
  })
})
