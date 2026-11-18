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

// #190012 — the address of ONE card, not just its board.
import { atlasItemUrl, itemUrlFrom, RETIRED_BOARD_URL } from "../src/cli/cmd/bloq-web-url"

describe("atlas item url", () => {
  test("opens the card on its board — the shape verified in a browser", () => {
    expect(atlasItemUrl(364, 1805, 190011, "https://heyiris.io/")).toBe(
      "https://heyiris.io/atlas?project=364&source=memory&row=1805&card=190011",
    )
  })

  test("refuses to guess when the board or list is unknown — half an address opens another project", () => {
    expect(atlasItemUrl(null, 1805, 190011, "https://heyiris.io")).toBeNull()
    expect(atlasItemUrl(364, undefined, 190011, "https://heyiris.io")).toBeNull()
    expect(atlasItemUrl(364, 1805, null, "https://heyiris.io")).toBeNull()
  })

  test("prefers the server's atlas_url, builds from bloq_id + list when it is absent", () => {
    const server = "https://heyiris.io/atlas?project=364&source=memory&row=1805&card=190011"
    expect(itemUrlFrom({ id: 190011, atlas_url: server }, "https://heyiris.io")).toBe(server)
    expect(itemUrlFrom({ id: 190011, bloq_id: 364, bloq_list_id: 1805 }, "https://heyiris.io")).toBe(server)
    expect(itemUrlFrom({ id: 190011 }, "https://heyiris.io", false, { bloqId: 364, listId: 1805 })).toBe(server)
  })

  test("never passes a retired Elon address through", () => {
    const item = { id: 1, atlas_url: "https://web.heyiris.io/iris/bloq/364", bloq_id: 364, bloq_list_id: 2 }
    const url = itemUrlFrom(item, "https://heyiris.io")!
    expect(url).toBe("https://heyiris.io/atlas?project=364&source=memory&row=2&card=1")
    expect(RETIRED_BOARD_URL.test(url)).toBe(false)
  })

  test("the retired pattern catches both Elon shapes", () => {
    expect(RETIRED_BOARD_URL.test("https://web.heyiris.io/iris/bloq/364")).toBe(true)
    expect(RETIRED_BOARD_URL.test("https://web.freelabel.net/bloq/633")).toBe(true)
    expect(RETIRED_BOARD_URL.test("https://heyiris.io/atlas?project=364")).toBe(false)
  })
})
