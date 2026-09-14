import { expect, test } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

test("the surface is called Genesis and a page is editable", async ({ page }) => {
  test.setTimeout(150_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
    localStorage.setItem("iris.panel.bloq", "679")
    localStorage.setItem("iris.panel.surface", "pages")
    localStorage.setItem("iris.panel.subviews", JSON.stringify({ pages: "pages" }))
  }, directory)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()

  // RENAMED: the level-1 tab reads Genesis, and Pages is now the level-2 view under it.
  await expect(page.locator(".iris-surfaces").getByRole("button", { name: "Genesis", exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator(".iris-subnav").getByRole("tab", { name: "Pages" })).toBeVisible()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })

  // Matched on the PAGE title, not "Richard's Signal" — the board picker button carries that
  // string too, and clicking it opens the board dialog instead of the row.
  await page.locator("[data-slot='tabs-content'] button", { hasText: "Inventory & Gap Audit" }).first().click()
  const nav = page.locator(".iris-detailnav")
  await nav.getByRole("tab", { name: "Edit" }).click()

  const editor = page.locator(".iris-editor")
  await expect(editor).toBeVisible({ timeout: 60_000 })
  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("draft", { timeout: 30_000 })
  const loaded = await editor.inputValue()
  console.log("EDITOR chars " + loaded.length)
  console.log("HEADER: " + (await body.innerText()).split("\n").slice(0, 8).join(" | "))
  expect(loaded.length).toBeGreaterThan(1000)
  expect(JSON.parse(loaded)).toHaveProperty("components")

  // Save is inert until something changes — the button says so rather than pretending.
  await expect(page.getByRole("button", { name: "No changes" })).toBeVisible()
  await page.screenshot({ path: "e2e/test-results/genesis-edit.png" })
  expect(errs).toEqual([])
})
