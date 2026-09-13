import { expect, test, type Page } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

test("integration rows show real brand logos, with attribution", async ({ page }) => {
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
  await expect(page.locator(".iris-int__logo").first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2500)

  // The images must actually DECODE, not merely be in the DOM. A broken <img> is still an <img>.
  const loaded = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>(".iris-int__logo")).map((i) => i.naturalWidth),
  )
  console.log("LOGO COUNT " + loaded.length + " | decoded " + loaded.filter((w) => w > 0).length)
  expect(loaded.length).toBeGreaterThan(5)
  expect(loaded.filter((w) => w > 0).length).toBeGreaterThan(5)

  // Attribution is a condition of the free tier — it must be on screen, as a real link.
  const attr = page.locator(".iris-attr a")
  await expect(attr).toBeVisible()
  expect(await attr.getAttribute("href")).toContain("logo.dev")
  await page.screenshot({ path: "e2e/test-results/logos.png" })
})
