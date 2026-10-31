/**
 * Regression tests for the two mint scan bugs filed 2026-10-20.
 *
 * #190264 — the local mail rail reads Mail's Envelope Index, which has no bodies.
 *           Every candidate quarantined as "no body returned" and the run printed
 *           "0 new · $0.00", which is indistinguishable from a clean inbox.
 * #190265 — `--json` printed ANSI-coloured human output before the JSON, so the
 *           command could not be piped anywhere.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { isBodylessScan } from "../../src/cli/cmd/platform-mint"

const SRC = readFileSync(join(import.meta.dir, "../../src/cli/cmd/platform-mint.ts"), "utf-8")

describe("isBodylessScan (#190264)", () => {
  const cand = (body: string, subject = "Receipt") => ({ subject, body, sender: "x@y.z", date: "2026-10-01" })

  test("a rail that returns envelopes and no bodies is bodyless", () => {
    expect(isBodylessScan([cand(""), cand("   "), cand("\n")])).toBe(true)
  })

  test("one real body is enough to keep scanning", () => {
    expect(isBodylessScan([cand(""), cand("Thanks for your payment of $21.64")])).toBe(false)
  })

  test("no candidates is not a bodyless scan — that is an empty result", () => {
    expect(isBodylessScan([])).toBe(false)
  })
})

describe("mint scan fails loudly on a bodyless rail (#190264)", () => {
  test("the guard runs before the summary can print $0.00", () => {
    const guard = SRC.indexOf("isBodylessScan(candidates)")
    const summary = SRC.indexOf("new  ·  ${dim(")
    expect(guard).toBeGreaterThan(-1)
    expect(summary).toBeGreaterThan(guard)
  })

  test("records a FAILED run and sets a non-zero exit code", () => {
    const start = SRC.indexOf("if (rail === \"mail\" && isBodylessScan(candidates))")
    const block = SRC.slice(start, start + 2200)
    expect(block).toContain("ok: false")
    expect(block).toContain("process.exitCode = 1")
    expect(block).toContain("#190264")
  })

  test("the message says it is not an empty inbox, and names the cause", () => {
    const start = SRC.indexOf("if (rail === \"mail\" && isBodylessScan(candidates))")
    const block = SRC.slice(start, start + 2200)
    expect(block).toContain("NOT an empty inbox")
    expect(block).toContain("Envelope Index")
  })
})

describe("mint scan --json emits only JSON (#190265)", () => {
  test("json mode is captured once and guards human output", () => {
    expect(SRC).toContain("const json = Boolean(args.json)")
    expect(SRC).toContain("const say = ")
  })

  test("intro and spinner are suppressed in json mode", () => {
    expect(SRC).toContain("if (!json) {\n      UI.empty()")
    expect(SRC).toContain("const spinner = json")
  })

  test("the JSON payload is the success shape other callers expect", () => {
    expect(SRC).toContain("await writeJson({ success: true, fresh, quarantined })")
  })

  test("the scan's human display block is behind the json guard", () => {
    const display = SRC.indexOf("printDivider()\n      for (const f of fresh)")
    const guard = SRC.lastIndexOf("if (!json) {", display)
    expect(display).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(-1)
    expect(display - guard).toBeLessThan(20)
  })
})
