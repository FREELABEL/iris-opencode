import { describe, expect, test } from "bun:test"
import { unknownBloqReason } from "./platform"

const listOf = (ids: number[]) => ({ measured: true, data: { bloqs: ids.map((id) => ({ id, name: `b${id}` })) } })

describe("unknownBloqReason", () => {
  test("rejects an id the account does not have", () => {
    // Why this guard exists: iris-api answers 200 with an EMPTY page list for a bloq that
    // cannot exist, so for /iris/pages the honest answer and the reassuring one were the same
    // JSON until something checked the id first.
    expect(unknownBloqReason(99999999, listOf([674, 571]))).toBe("unknown bloq 99999999")
  })

  test("allows an id the account does have", () => {
    expect(unknownBloqReason(571, listOf([674, 571]))).toBeNull()
  })

  test("FAILS OPEN when the bloq list could not be measured", () => {
    // The important one. Offline or 401, we cannot list bloqs — and a guard that cannot verify
    // must decline to judge rather than invent a verdict. Returning a reason here would make
    // every surface report "unknown bloq" during an outage, which is a confident wrong answer
    // dressed as a careful one.
    expect(unknownBloqReason(571, { measured: false, reason: "fl-api 401", data: { bloqs: [] } })).toBeNull()
  })

  test("an account with genuinely no bloqs still rejects", () => {
    // Measured and empty is a real answer: you have no bloqs, so this id is not one of yours.
    expect(unknownBloqReason(1, listOf([]))).toBe("unknown bloq 1")
  })
})
