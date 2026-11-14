/**
 * Regression test: HTTP 402 must surface the platform's own guidance (#178276)
 *
 * `iris data-sources read` printed a bare `subscription_required` for every
 * built-in source, with no indication of what subscription was needed or where
 * to upgrade. The blocking itself is correct — the user genuinely had no active
 * subscription — but fl-api's RequireActiveSubscription middleware already
 * returns everything needed to act:
 *
 *   {
 *     "error": "subscription_required",
 *     "message": "An active subscription is required to run agents and workflows.",
 *     "checkout_url": "https://.../pricing?token=...",
 *     "onboarding_url": "https://.../onboarding?token=...",
 *     "cli_command": "iris billing"
 *   }
 *
 * The CLI discarded all of it and rendered the machine token. These tests pin
 * that the human-readable guidance is what reaches the user.
 *
 * NOTE: originally written against a `subscriptionErrorLines()` helper. That was
 * superseded upstream by `formatPaymentRequired()`, which covers strictly more
 * (credit gates carry balance/cost/short-by, plus buy_credits_url and
 * upgrade_url). Ported to the surviving API.
 */
import { describe, test, expect } from "bun:test"
import { formatPaymentRequired } from "../../src/cli/cmd/iris-api"

const render = (body: unknown): string => {
  const { message, details } = formatPaymentRequired(body)
  return [message, ...details].join("\n")
}

describe("402 subscription error surfacing (#178276)", () => {
  const fullBody = {
    error: "subscription_required",
    message: "An active subscription is required to run agents and workflows.",
    checkout_url: "https://web.heyiris.io/pricing?token=abc",
    onboarding_url: "https://web.heyiris.io/onboarding?token=abc",
    cli_command: "iris billing",
  }

  test("surfaces the human-readable message", () => {
    expect(render(fullBody)).toContain("An active subscription is required")
  })

  test("never shows the bare machine token as the message", () => {
    // The exact regression: "subscription_required" was the whole output.
    expect(formatPaymentRequired(fullBody).message).not.toBe("subscription_required")
  })

  test("tells the user the command the API asked them to run", () => {
    expect(render(fullBody)).toContain("iris billing")
  })

  test("includes the checkout URL so the user can act immediately", () => {
    expect(render(fullBody)).toContain("https://web.heyiris.io/pricing?token=abc")
  })

  test("humanises a bare token instead of printing snake_case", () => {
    // Must never be a dead end that reads like an internal enum.
    const { message } = formatPaymentRequired({ error: "subscription_required" })
    expect(message).not.toBe("subscription_required")
    expect(message.toLowerCase()).toContain("subscription")
  })

  test("does not invent a URL when none was provided", () => {
    expect(render({ error: "subscription_required" })).not.toContain("https://")
  })

  test("does not invent a CLI command when the API omitted one", () => {
    // Deliberately NOT asserting a hardcoded fallback: `iris billing` is not a
    // real command (it is absent from the CLI and just prints the root banner),
    // so inventing it client-side would send the user somewhere that does not
    // exist. Only echo a command the server actually supplied.
    expect(render({ error: "subscription_required" })).not.toContain("Fix:")
  })

  test("credit gates surface the numbers that make the message actionable", () => {
    const out = render({
      error: "insufficient_credits",
      message: "Not enough credits.",
      data: { balance: 3, cost: 10, balance_needed: 7 },
    })
    expect(out).toContain("balance 3")
    expect(out).toContain("cost 10")
    expect(out).toContain("short by 7")
  })
})
