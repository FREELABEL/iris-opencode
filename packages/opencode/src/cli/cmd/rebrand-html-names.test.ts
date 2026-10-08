import { describe, expect, test } from "bun:test"
import { rebrandJsonContent } from "./rebrand"

// #188547 — a hand-written HTML page has no structured brand name, so the transform never
// replaced it and the leak gate had nothing to look for, while reporting "clean".
// rebrandJsonContent transforms the object IN PLACE, so every test builds a fresh page.
const clientPage = () => ({
  render_mode: "html",
  html:
    "<h1>DreX CFO — senior finance, without the salary line</h1>" +
    "<p>Founded by Haroon. Call +44 20 7946 0018 or write to hello@drexcfo.co.uk</p>",
  css: "/* brand-tokens:start */:root{--brand-accent:#123}/* brand-tokens:end */",
})
const TARGET = { name: "Acme Advisory", colors: { primary: "#ff0000" } }

describe("rebrand on HTML pages (#188547)", () => {
  test("emails and international phone numbers are scrubbed from the html", () => {
    const { json } = rebrandJsonContent(clientPage(), TARGET)
    expect(json.html).not.toContain("hello@drexcfo.co.uk")
    expect(json.html).not.toContain("7946") // UK number: missed by the US-shaped regex before
  })

  test("with no names given, it reports that names were NOT checked", () => {
    expect(rebrandJsonContent(clientPage(), TARGET).namesChecked).toBe(false)
  })

  test("the first supplied name is REPLACED with the target's name everywhere", () => {
    const { json, namesChecked } = rebrandJsonContent(clientPage(), TARGET, { sourceNames: ["DreX CFO"] })
    expect(namesChecked).toBe(true)
    expect(json.html).toContain("Acme Advisory")
    expect(json.html).not.toContain("DreX CFO")
  })

  test("a further supplied name that survives in the copy is reported as a leak", () => {
    const { leaks } = rebrandJsonContent(clientPage(), TARGET, { sourceNames: ["DreX CFO", "Haroon"] })
    expect(leaks.some((l) => l.needle === "Haroon" && l.path === "html")).toBe(true)
  })

  test("blank or too-short names are ignored, not turned into needles that match everything", () => {
    const { leaks, namesChecked } = rebrandJsonContent(
      { render_mode: "html", html: "<p>a b c</p>", css: "" },
      TARGET,
      { sourceNames: ["", " ", "a"] },
    )
    expect(leaks).toEqual([])
    expect(namesChecked).toBe(false)
  })

  test("a price or a date is not mistaken for an international phone number", () => {
    const { json } = rebrandJsonContent({ render_mode: "html", html: "<p>From +$1,500 on 2026-10-08</p>", css: "" }, TARGET)
    expect(json.html).toBe("<p>From +$1,500 on 2026-10-08</p>")
  })
})
