import { describe, expect, test } from "bun:test"
import { compactMoney, pipeline, pipelineTotal, stageTone, valueOf } from "./iris-leads-list-model"

describe("stageTone", () => {
  test("each stage reads in its own semantic tone", () => {
    expect(["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"].map(stageTone)).toEqual([
      "neutral",
      "info",
      "accent",
      "warning",
      "success",
      "critical",
    ])
  })
  test("unknown or missing is neutral", () => {
    expect(stageTone("On Hold")).toBe("neutral")
    expect(stageTone(undefined)).toBe("neutral")
  })
})

describe("money", () => {
  test("compact", () => {
    expect(compactMoney(40000)).toBe("$40k")
    expect(compactMoney(1250000)).toBe("$1.3M")
    expect(compactMoney(950)).toBe("$950")
    expect(compactMoney(0)).toBe("")
  })
  test("valueOf drops zero and junk", () => {
    expect(valueOf("40000")).toBe(40000)
    expect(valueOf(0)).toBeUndefined()
    expect(valueOf("")).toBeUndefined()
    expect(valueOf("abc")).toBeUndefined()
  })
})

describe("pipeline", () => {
  const rows = [
    { status: "Won", price_bid: 36000 },
    { status: "New", price_bid: 12000 },
    { status: "new", price_bid: "8000" },
    { status: "Proposal", price_bid: null },
  ]
  test("counts and values per stage, in pipeline order", () => {
    expect(pipeline(rows, { complete: true })).toEqual([
      { status: "New", tone: "neutral", count: 2, value: 20000 },
      { status: "Proposal", tone: "warning", count: 1 },
      { status: "Won", tone: "success", count: 1, value: 36000 },
    ])
  })
  test("server counts win; values only when every lead is loaded", () => {
    const p = pipeline(rows, { counts: [{ status: "New", count: 40 }], complete: false })
    expect(p.find((s) => s.status === "New")).toEqual({ status: "New", tone: "neutral", count: 40 })
    expect(p.every((s) => s.value === undefined)).toBe(true)
  })
  test("open value leaves out won and lost", () => {
    expect(pipelineTotal(pipeline(rows, { complete: true }))).toEqual({ count: 4, open: 20000 })
  })
})
