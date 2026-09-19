import { describe, expect, test } from "bun:test"
import { buyLink, money } from "../../src/cli/cmd/platform-commerce"

describe("iris commerce helpers", () => {
  test("money formats cents with separators and two decimals", () => {
    expect(money(29700)).toBe("$297.00")
    expect(money(500000)).toBe("$5,000.00")
    expect(money(5940)).toBe("$59.40")
    expect(money(null)).toBe("$0.00")
  })

  test("buyLink names the seller, the dataset and the item — never a price", () => {
    const url = buyLink(691, "mino-packages", "stageshift-playbook")
    expect(url).toBe("https://raichu.heyiris.io/api/v1/commerce/buy/691/mino-packages/stageshift-playbook")
    expect(url).not.toContain("price")
  })

  test("buyLink encodes the return address", () => {
    expect(buyLink(1, "d", "x", "https://heyiris.io/p/shop#packages")).toBe(
      "https://raichu.heyiris.io/api/v1/commerce/buy/1/d/x?return=https%3A%2F%2Fheyiris.io%2Fp%2Fshop%23packages",
    )
  })
})
