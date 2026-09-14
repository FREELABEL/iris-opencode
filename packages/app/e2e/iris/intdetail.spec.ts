import { expect, test } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

test("a failing integration says the provider is fine and the credential is not", async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
    localStorage.setItem("iris.panel.bloq", "174")
    localStorage.setItem("iris.panel.surface", "integrations")
    localStorage.setItem("iris.panel.subviews", JSON.stringify({ integrations: "user" }))
  }, directory)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await page.locator("[data-slot='tabs-content'] button", { hasText: "CourtListener" }).first().click()

  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("Provider operational", { timeout: 30_000 })
  const bars = await page.locator(".iris-bars__bar").count()
  const text = await body.innerText()
  console.log("BARS " + bars)
  console.log(text.slice(0, 700))
  expect(bars).toBeGreaterThan(0)
  // The sentence people get wrong, said out loud.
  expect(text).toContain("it is your credential that is failing")
  await page.screenshot({ path: "e2e/test-results/int-detail.png" })
})
