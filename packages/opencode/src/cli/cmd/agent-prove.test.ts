import { describe, test, expect } from "bun:test"
import { evaluateProof } from "./agent-prove"

const PROV = { retrieved_item_ids: ["181392", "164650"], tool_calls: [] as any[] }
const EMPTY = { retrieved_item_ids: [] as string[], tool_calls: [] as any[] }

describe("evaluateProof", () => {
  test("passes when the answer contains the required text", () => {
    const r = evaluateProof("Our goal is $2M per month.", PROV, { mustContain: ["per month"] })
    expect(r.pass).toBe(true)
    expect(r.failures).toEqual([])
  })

  test("fails, and says what was missing", () => {
    const r = evaluateProof("Our goal is $2M a year.", PROV, { mustContain: ["per month"] })
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toContain("per month")
  })

  // The point of the demo: the agent must REJECT the premise, not echo it back.
  test("mustNotContain catches an agent agreeing with a false premise", () => {
    const r = evaluateProof("Yes, $2M a year is correct.", PROV, { mustNotContain: ["a year"] })
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toContain("a year")
  })

  // The whole guarantee. Saying the right words while having read nothing is the failure
  // this exists to catch — a lucky answer must not pass as a grounded one.
  test("mustCite requires the id to be RETRIEVED, not merely mentioned", () => {
    const said = evaluateProof("As stated in item #181392.", EMPTY, { mustCite: "181392" })
    expect(said.pass).toBe(false)
    expect(said.failures[0]).toMatch(/retriev/i)

    const read = evaluateProof("As stated in item #181392.", PROV, { mustCite: "181392" })
    expect(read.pass).toBe(true)
  })

  test("mustCite fails when a DIFFERENT record was read", () => {
    const r = evaluateProof("see #999999", PROV, { mustCite: "999999" })
    expect(r.pass).toBe(false)
  })

  test("matching is case-insensitive on text", () => {
    expect(evaluateProof("PER MONTH", PROV, { mustContain: ["per month"] }).pass).toBe(true)
  })

  test("every failing expectation is reported, not just the first", () => {
    const r = evaluateProof("a year", EMPTY, { mustContain: ["per month"], mustNotContain: ["a year"], mustCite: "181392" })
    expect(r.failures.length).toBe(3)
  })

  test("no expectations is NOT a pass — an assertion that asserts nothing is a false green", () => {
    const r = evaluateProof("anything", PROV, {})
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toMatch(/no expectations/i)
  })

  test("an empty response cannot pass a contains check", () => {
    expect(evaluateProof("", PROV, { mustContain: ["x"] }).pass).toBe(false)
  })
})
