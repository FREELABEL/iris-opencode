import { describe, expect, test } from "bun:test"
import { checkoutUrl, formatPrice } from "./dialog-upgrade"

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
