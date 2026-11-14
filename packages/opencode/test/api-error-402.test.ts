import { describe, test, expect } from "bun:test"
import { formatPaymentRequired, handleApiError } from "../src/cli/cmd/iris-api"

/**
 * 402 handling (#178276).
 *
 * fl-api answers an entitlement gate with a full remediation payload. The CLI
 * used to drop all of it and print the bare slug "subscription_required".
 * These pin what the user actually reads, against the FOUR real 402 payloads
 * the platform emits — they differ, and one of them has no `message` at all.
 *
 * Tests the pure formatter rather than stubbing the terminal: bun's
 * mock.module is process-global, so mocking the clack module here broke four
 * unrelated suites.
 */

const render = (body: unknown) => {
  const { message, details } = formatPaymentRequired(body)
  return [message, ...details].join("\n")
}

describe("formatPaymentRequired", () => {
  test("RequireActiveSubscription: the sentence, the command, and where to pay", () => {
    // Verbatim shape from fl-api RequireActiveSubscription.php.
    // The fixture said `iris billing` — a command that did not exist. The test was right about
    // what it checked (the CLI renders cli_command faithfully) and wrong about what it showed:
    // a passthrough test whose fixture is a dead end teaches the dead end. fl-api now sends
    // `iris pricing`, and `billing` is an alias of it, so both of these are real commands.
    const out = render({
      success: false,
      error: "subscription_required",
      message: "An active subscription is required to run agents and workflows.",
      checkout_url: "https://freelabel.net/magic/abc/pricing",
      onboarding_url: "https://freelabel.net/magic/abc/onboarding",
      cli_command: "iris pricing",
    })

    expect(out).toContain("An active subscription is required")
    expect(out).toContain("iris pricing")
    expect(out).toContain("https://freelabel.net/magic/abc/pricing")
    expect(out).toContain("https://freelabel.net/magic/abc/onboarding")
  })

  test("never shows the bare slug when a human message exists — the actual bug", () => {
    const { message } = formatPaymentRequired({
      error: "subscription_required",
      message: "An active subscription is required to run agents and workflows.",
      cli_command: "iris pricing",
    })

    // The old behaviour was `${action} failed: subscription_required`.
    expect(message).not.toContain("subscription_required")
    expect(message).toBe("An active subscription is required to run agents and workflows.")
  })

  test("CheckCredits: surfaces the balance numbers that make it actionable", () => {
    // Verbatim shape from fl-api CheckCredits.php:80-91
    const out = render({
      success: false,
      error: "insufficient_credits",
      message: "You need more credits to continue. Please add credits to your account.",
      data: { balance: 3, cost: 10, balance_needed: 7, action_type: "agent_run" },
      buy_credits_url: "/dashboard/credits",
    })

    expect(out).toContain("You need more credits")
    expect(out).toContain("balance 3")
    expect(out).toContain("cost 10")
    expect(out).toContain("short by 7")
    expect(out).toContain("/dashboard/credits")
  })

  test("OkfAccess: humanises the slug when the payload has no message at all", () => {
    // Verbatim shape from fl-api OkfAccess.php:48 — slug + cost, no message.
    const out = render({ error: "insufficient_credits", cost: 5 })

    expect(out).toContain("Insufficient credits")
    expect(out).not.toContain("insufficient_credits") // no snake_case at the user
    expect(out).toContain("cost 5")
  })

  test("falls back cleanly on a non-JSON / empty body", () => {
    expect(formatPaymentRequired(null).message).toBe("Payment required")
    expect(formatPaymentRequired(undefined).message).toBe("Payment required")
    expect(formatPaymentRequired({}).message).toBe("Payment required")
    expect(formatPaymentRequired(null).details).toEqual([])
  })

  test("omits the balance line entirely when there are no numbers to show", () => {
    const out = render({
      error: "subscription_required",
      message: "Subscribe to continue.",
      cli_command: "iris pricing",
    })

    expect(out).not.toContain("balance")
    expect(out).not.toContain("cost")
  })

  test("omits a zero shortfall rather than printing 'short by 0'", () => {
    const out = render({ message: "x", data: { balance: 10, cost: 10, balance_needed: 0 } })
    expect(out).not.toContain("short by")
  })

  test("a zero balance still prints — 0 is a real number, not absent", () => {
    const out = render({ message: "x", data: { balance: 0, cost: 5, balance_needed: 5 } })
    expect(out).toContain("balance 0")
    expect(out).toContain("short by 5")
  })
})

describe("handleApiError — 402 wiring", () => {
  test("returns false and sets a non-zero exit code", async () => {
    const before = process.exitCode
    try {
      const ok = await handleApiError(
        new Response(JSON.stringify({ error: "subscription_required", message: "Subscribe." }), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        }),
        "Read data source",
      )
      expect(ok).toBe(false)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = before
    }
  })

  test("2xx still returns true", async () => {
    expect(await handleApiError(new Response("{}", { status: 200 }), "Read")).toBe(true)
  })
})
