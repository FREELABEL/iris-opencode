import { describe, expect, test } from "bun:test"
import cases from "./brand-logo.cases.json"
import { buildDashboardJson, dashboardTokensFrom } from "./platform-dashboard"

// #110009 — the client dashboard template wears the client's kit. It used to read `.colors` off the
// endpoint's {brand, name, design_tokens} envelope, find nothing, and paint every client green.
const CATODRIVE_PAYLOAD = {
  brand: "catodrive",
  name: "CatoDrive",
  design_tokens: { ...cases.brands.catodrive, colors: { primary: { DEFAULT: "#1e3a5f" }, background: { DEFAULT: "#ffffff" } } },
}

describe("client dashboard template reads the brand kit (#110009)", () => {
  test("CatoDrive is navy with its own logo, not the default green", () => {
    const page = buildDashboardJson("catodrive", "CatoDrive", dashboardTokensFrom(CATODRIVE_PAYLOAD))
    expect(page.theme.branding.primaryColor).toBe("#1e3a5f")
    expect(page.theme.backgroundColor).toBe("#ffffff")
    expect(page.theme.branding.logoUrl).toBe("https://cdn.example/cato.png")
  })

  test("IRIS on the light dashboard gets its on_light mark; its black ground is not used on a light page", () => {
    const page = buildDashboardJson("iris", "IRIS", dashboardTokensFrom({ design_tokens: cases.brands.iris }))
    expect(page.theme.branding.logoUrl).toBe("https://freelabel.net/images/iris-logo-dark-transparent.png")
    expect(page.theme.branding.faviconUrl).toBe("https://freelabel.net/favicon.svg")
    expect(page.theme.backgroundColor).toBe("#f8fafc")
    expect(page.theme.branding.primaryColor).toBe("#34d399")
  })

  test("no kit: the old defaults, no logo", () => {
    const page = buildDashboardJson("acme", "Acme", dashboardTokensFrom({}))
    expect(page.theme.branding.primaryColor).toBe("#34d399")
    expect(page.theme.branding).not.toHaveProperty("logoUrl")
  })
})
