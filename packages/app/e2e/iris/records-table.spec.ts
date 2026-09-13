import { expect, test, type Page } from "@playwright/test"

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()

test.use({ channel: "chrome" })

async function configure(page: Page) {
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
    if (!sessionStorage.getItem("e2e.iris.seeded")) {
      sessionStorage.setItem("e2e.iris.seeded", "1")
      localStorage.setItem("iris.panel.surface", "atlas")
      localStorage.removeItem("iris.panel.subviews")
    }
  }, directory)
}

test("a schema opens on a real table of its records", async ({ page }) => {
  test.setTimeout(180_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push("PAGEERROR " + String(e)))
  page.on("console", (m) => m.type() === "error" && errs.push("CONSOLE " + m.text()))

  await configure(page)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByRole("button", { name: "Atlas", exact: true })).toBeVisible({ timeout: 30_000 })

  await page.locator(".iris-subnav").getByRole("tab", { name: "Schemas" }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })

  const listText = await page.locator("[data-slot='tabs-content']").innerText()
  expect(listText, "schema fields still rendering as [object Object]").not.toContain("[object Object]")
  await page.screenshot({ path: "e2e/test-results/table-schemas-list.png" })

  await page.locator("[data-slot='tabs-content'] button", { hasText: "Accounting Evidence" }).first().click()
  await expect(page.getByRole("tab", { name: "Records" })).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: "e2e/test-results/table-schema-info.png" })

  await page.getByRole("tab", { name: "Records" }).click()
  const table = page.locator(".iris-table")
  await expect(table).toBeVisible({ timeout: 60_000 })
  const headers = await table.locator("thead th").allInnerTexts()
  const bodyRows = await table.locator("tbody tr").count()
  console.log("HEADERS: " + JSON.stringify(headers))
  console.log("BODY ROWS: " + bodyRows)
  const footer = await page.locator("[data-slot='tabs-content']").innerText()
  console.log("FOOTER: " + (footer.match(/[\d,]+ of [^\n]*/)?.[0] ?? "(none)"))
  await page.screenshot({ path: "e2e/test-results/table-records.png" })

  expect(bodyRows).toBeGreaterThan(0)
  expect(headers.join(" ")).toMatch(/phi/i)
  console.log("ERRORS: " + errs.join(" | "))
  expect(errs.filter((e) => /iris|record/i.test(e))).toEqual([])
})
