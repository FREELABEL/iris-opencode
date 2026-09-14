import { expect, test } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

test("the Add view offers what you do not have, and says how to connect it", async ({ page }) => {
  test.setTimeout(150_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
    localStorage.setItem("iris.panel.bloq", "174")
    localStorage.setItem("iris.panel.surface", "integrations")
    localStorage.setItem("iris.panel.subviews", JSON.stringify({ integrations: "add" }))
  }, directory)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })

  const body = page.locator("[data-slot='tabs-content']")
  const text = await body.innerText()
  console.log("ADD VIEW:\n" + text.split("\n").slice(0, 14).join(" | "))
  // Already-connected services must NOT be offered.
  expect(text).not.toContain("CourtListener")
  await page.screenshot({ path: "e2e/test-results/add-int.png" })

  // Opening one gives the real command and says what connecting involves.
  await body.locator("button", { hasText: "GitHub" }).first().click()
  await expect(body).toContainText("iris connect github", { timeout: 30_000 })
  const detail = await body.innerText()
  console.log("DETAIL: " + detail.split("\n").slice(0, 12).join(" | "))
  expect(detail).toContain("brokered")
  expect(errs).toEqual([])
})
