import { describe, expect, test } from "bun:test"
import { applyBrandBlock, brandContract, brandContractCss, safeCssValue } from "./brand-contract"

// The three token shapes actually stored on brands today (read from the public endpoint 2026-10-07).
const CATODRIVE = {
  colors: { primary: { DEFAULT: "#1e3a5f" }, secondary: { DEFAULT: "#334155" }, text: { DEFAULT: "#0f172a" }, surface: { DEFAULT: "#f8fafc" }, border: { DEFAULT: "#e2e8f0" } },
  typography: { bodyWeight: { family: "400" }, fontFamily: { family: "Inter, sans-serif" }, headingWeight: { family: "700" } },
}
const FREELABEL = {
  colors: { primary: { DEFAULT: "#FF192C" }, accent: { DEFAULT: "#ffffff" }, surface: { DEFAULT: "#181818" } },
  typography: { "font-family": { family: "'Montserrat', 'Inter', -apple-system, sans-serif" } },
  spacing: { "card-radius": "0.75rem" },
}

describe("brand contract (#188409, #188413)", () => {
  test("reads the nested DEFAULT colour shape and the fontFamily shape, skipping weight-only entries", () => {
    const { values } = brandContract(CATODRIVE)
    expect(values.accent).toBe("#1e3a5f")
    expect(values["accent-2"]).toBe("#334155")
    expect(values["font-display"]).toBe("Inter, sans-serif")
    expect(values["font-body"]).toBe("Inter, sans-serif")
    expect(values.ink).toBe("#0f172a")
  })

  test("reads the 'font-family' shape and card-radius", () => {
    const { values, missing } = brandContract(FREELABEL)
    expect(values.accent).toBe("#FF192C")
    expect(values["font-display"]).toContain("Montserrat")
    expect(values.radius).toBe("0.75rem")
    expect(missing).toContain("font-mono") // reported, never invented
  })

  test("a value that could break out of the declaration is refused, not escaped", () => {
    expect(safeCssValue("red; } body { display:none")).toBeUndefined()
    expect(safeCssValue("</style><script>alert(1)</script>")).toBeUndefined()
    expect(safeCssValue("#fff")).toBe("#fff")
    const { values } = brandContract({ colors: { primary: { DEFAULT: "#000; } * { color:red" } } })
    expect(values.accent).toBeUndefined()
  })

  test("non-colour strings never become colours", () => {
    expect(brandContract({ colors: { primary: { DEFAULT: "brand red" } } }).values.accent).toBeUndefined()
  })

  test("the block replaces exactly the marked region and reports it", () => {
    const css = "a{}\n/* brand-tokens:start */ :root{--brand-accent:#000} /* brand-tokens:end */\nb{color:var(--brand-accent)}"
    const block = brandContractCss({ accent: "#FF192C" }, "FREELABEL")
    const r = applyBrandBlock(css, block)
    expect(r.replaced).toBe(1)
    expect(r.text).toContain("--brand-accent: #FF192C;")
    expect(r.text).not.toContain("--brand-accent:#000")
    expect(r.text.startsWith("a{}")).toBe(true)
    expect(r.text.endsWith("b{color:var(--brand-accent)}")).toBe(true)
  })

  test("a page with no block is reported as not a template (0), unchanged", () => {
    const r = applyBrandBlock(".x{color:#123}", brandContractCss({ accent: "#fff" }))
    expect(r.replaced).toBe(0)
    expect(r.text).toBe(".x{color:#123}")
  })

  test("a $ in a value is inserted literally (no replacement-pattern surprises)", () => {
    const r = applyBrandBlock("/* brand-tokens:start */x/* brand-tokens:end */", "/* brand-tokens:start */$&$1/* brand-tokens:end */")
    expect(r.text).toBe("/* brand-tokens:start */$&$1/* brand-tokens:end */")
  })
})
