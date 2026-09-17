import { describe, expect, test } from "bun:test"
import { bloqUrlFrom, bloqWebUrl } from "../src/cli/cmd/bloq-web-url"

// #185736 — a board's address is the Atlas console.
describe("bloq web url", () => {
  test("builds the Atlas console address, not the retired Elon route", () => {
    const url = bloqWebUrl(633, "https://heyiris.io/")
    expect(url).toBe("https://heyiris.io/atlas?project=633")
    expect(url).not.toContain("/iris/bloq/")
  })

  test("prefers the address fl-api returned", () => {
    const b = { id: 633, public_url: "https://atlas.example.com/atlas?project=633" }
    expect(bloqUrlFrom(b, 633, "https://heyiris.io")).toBe("https://atlas.example.com/atlas?project=633")
  })

  test("ignores a pre-#185736 API address instead of passing the old link through", () => {
    const b = { id: 633, public_url: "https://web.freelabel.net/bloq/633" }
    expect(bloqUrlFrom(b, 633, "https://heyiris.io")).toBe("https://heyiris.io/atlas?project=633")
  })

  test("falls back when the response has no address or no body", () => {
    expect(bloqUrlFrom({ id: 7 }, 7, "https://heyiris.io")).toBe("https://heyiris.io/atlas?project=7")
    expect(bloqUrlFrom(null, 7, "https://heyiris.io")).toBe("https://heyiris.io/atlas?project=7")
  })

  test("an explicit site override beats production's API host", () => {
    const b = { id: 633, public_url: "https://heyiris.io/atlas?project=633" }
    expect(bloqUrlFrom(b, 633, "http://localhost:8000", true)).toBe("http://localhost:8000/atlas?project=633")
  })

  test("never carries source= provenance — on that page it is the console tab", () => {
    expect(bloqWebUrl(633, "https://heyiris.io")).not.toContain("source=")
  })
})
