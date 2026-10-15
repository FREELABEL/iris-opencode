import { describe, expect, test } from "bun:test"
import { checkoutUrl, formatPrice, plansDialogCopy } from "./dialog-upgrade"

describe("formatPrice", () => {
  test("whole dollars with a period suffix", () => {
    expect(formatPrice(199, "month")).toBe("$199/mo")
    expect(formatPrice(2399, "month")).toBe("$2,399/mo")
    expect(formatPrice(1500, "year")).toBe("$1,500/yr")
  })
})

describe("checkoutUrl", () => {
  test("keeps the server's URL and marks the source", () => {
    const u = new URL(checkoutUrl("https://web.heyiris.io/pricing?source=desktop-limit", "iris-solo-monthly"))
    expect(u.origin + u.pathname).toBe("https://web.heyiris.io/pricing")
    expect(u.searchParams.get("source")).toBe("desktop-upgrade")
    expect(u.searchParams.get("package")).toBe("iris-solo-monthly")
    expect(new URL(checkoutUrl("https://web.heyiris.io/pricing")).searchParams.has("package")).toBe(false)
  })
})

// #189544: paid accounts had no way to see the plans; when they do, they are not told to upgrade.
describe("plansDialogCopy", () => {
  test("someone who pays sees 'Your plan', named, and is never told to upgrade", () => {
    const copy = plansDialogCopy(true, "IRIS Solo")
    expect(copy.title).toBe("Your plan")
    expect(copy.description).toContain("You're on IRIS Solo.")
    expect(`${copy.title} ${copy.description}`).not.toMatch(/upgrade/i)
  })

  test("only someone we know has not paid is asked to upgrade", () => {
    expect(plansDialogCopy(false).title).toBe("Upgrade IRIS")
    expect(plansDialogCopy(null).title).toBe("IRIS plans")
    expect(plansDialogCopy(undefined).title).toBe("IRIS plans")
  })
})
