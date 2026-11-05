import { describe, expect, test } from "bun:test"
import {
  addPin,
  EMPTY_PINS,
  movePin,
  openPin,
  parsePins,
  PIN_LABEL_MAX,
  pinsKey,
  removePin,
  renamePin,
  selectPin,
  serializePins,
  type MarketingPins,
} from "./iris-marketing-pins"

const a = { slug: "acme-ads", label: "Acme ads" }
const b = { slug: "acme-x", label: "X board", signIn: true }
const c = { slug: "acme-tiktok", label: "TikTok" }
const three = [a, b, c].reduce<MarketingPins>((s, p) => addPin(s, p), EMPTY_PINS)

describe("Marketing pins (#192624)", () => {
  test("no default pages: nothing stored, nothing unreadable and nobody signed in are all no pins", () => {
    expect(parsePins(null)).toEqual({ pins: [] })
    expect(parsePins("")).toEqual({ pins: [] })
    expect(parsePins("{not json")).toEqual({ pins: [] })
    expect(parsePins(JSON.stringify(["freelabel-ads-review"]))).toEqual({ pins: [] })
    expect(openPin(EMPTY_PINS)).toBeUndefined()
    expect(pinsKey(null)).toBeNull()
    expect(pinsKey(0)).toBeNull()
    expect(pinsKey(Number.NaN)).toBeNull()
  })

  test("stored per account: each account has its own key", () => {
    expect(pinsKey(193)).toBe("iris.panel.marketing.pins.193")
    expect(pinsKey(42)).not.toBe(pinsKey(193))
  })

  test("pin: appended, opened, label from the page; pinning twice opens the existing tab", () => {
    expect(three.pins.map((p) => p.slug)).toEqual(["acme-ads", "acme-x", "acme-tiktok"])
    expect(three.selected).toBe("acme-tiktok")
    expect(three.pins[1]).toEqual({ slug: "acme-x", label: "X board", signIn: true })
    const again = addPin(selectPin(three, "acme-ads"), { slug: "ACME-X", label: "other" })
    expect(again.pins).toEqual(three.pins)
    expect(again.selected).toBe("acme-x")
    // Not a slug: never a tab.
    expect(addPin(EMPTY_PINS, { slug: "../p/evil", label: "x" })).toEqual(EMPTY_PINS)
  })

  test("unpin: the open tab moves to its neighbour, then to nothing", () => {
    const s = removePin(selectPin(three, "acme-x"), "acme-x")
    expect(s.pins.map((p) => p.slug)).toEqual(["acme-ads", "acme-tiktok"])
    expect(s.selected).toBe("acme-tiktok")
    expect(removePin(s, "acme-tiktok").selected).toBe("acme-ads")
    // Unpinning a tab that is not open leaves the open one alone.
    expect(removePin(selectPin(three, "acme-ads"), "acme-tiktok").selected).toBe("acme-ads")
    const none = removePin(removePin(removePin(three, "acme-ads"), "acme-x"), "acme-tiktok")
    expect(none).toEqual({ pins: [] })
    expect(openPin(none)).toBeUndefined()
  })

  test("reorder: one place at a time, nothing moves past an end", () => {
    expect(movePin(three, "acme-tiktok", -1).pins.map((p) => p.slug)).toEqual(["acme-ads", "acme-tiktok", "acme-x"])
    expect(movePin(three, "acme-ads", 1).pins.map((p) => p.slug)).toEqual(["acme-x", "acme-ads", "acme-tiktok"])
    expect(movePin(three, "acme-ads", -1)).toBe(three)
    expect(movePin(three, "acme-tiktok", 1)).toBe(three)
  })

  test("rename: trimmed and capped; an empty name is the slug", () => {
    expect(renamePin(three, "acme-ads", "  Our   ads ").pins[0].label).toBe("Our ads")
    expect(renamePin(three, "acme-ads", "   ").pins[0].label).toBe("acme-ads")
    expect(renamePin(three, "acme-ads", "x".repeat(99)).pins[0].label.length).toBe(PIN_LABEL_MAX)
  })

  test("round-trips through storage; a tampered record keeps only well-formed, unique pins", () => {
    expect(parsePins(serializePins(three))).toEqual(three)
    const tampered = JSON.stringify({
      selected: "gone",
      pins: [a, { slug: "ACME-ADS", label: "dupe" }, { slug: "<script>" }, null, { label: "no slug" }, { slug: "ok-one", signIn: "yes" }],
    })
    expect(parsePins(tampered)).toEqual({ pins: [a, { slug: "ok-one", label: "ok-one" }] })
  })
})
