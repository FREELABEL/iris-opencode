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
      // PIN THE BOARD. Without this the panel falls back to whichever board is first in the
      // account, and this test then asserts "a site opens" against whatever that board happens
      // to hold — which today is nothing. The failure looked like a broken Sites pane; the
      // pane is fine, the test was pointed at an arbitrary board.
      localStorage.setItem("iris.panel.bloq", "174")
      localStorage.setItem("iris.panel.surface", "pages")
      localStorage.removeItem("iris.panel.subviews")
    }
  }, directory)
}

test("Pages and Sites are two different things, and both are reachable", async ({ page }) => {
  test.setTimeout(180_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))

  await configure(page)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  // The SURFACE is "Genesis" — it holds pages AND sites, and a site is not a page. "Pages"
  // survives one level down, as the sub-view, which is what the rest of this test clicks.
  await expect(page.getByRole("button", { name: "Genesis", exact: true })).toBeVisible({ timeout: 30_000 })

  const subnav = page.locator(".iris-subnav")
  await expect(subnav.getByRole("tab", { name: "Sites" })).toBeVisible({ timeout: 30_000 })
  await subnav.getByRole("tab", { name: "Sites" }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })

  const body = await page.locator("[data-slot='tabs-content']").innerText()
  expect(body).not.toMatch(/Could not reach IRIS|Could not load/)
  // The stale-pane guard: a sites payload must never be read with the pages key.
  expect(body).not.toMatch(/Nothing in Pages . Sites/)
  console.log("SITES BODY:\n" + body.slice(0, 400))
  await page.screenshot({ path: "e2e/test-results/sites-list.png" })

  // Open a site and check its page list is there.
  /*
   * The FIRST site, not one named "freelabel" — no such site exists on this board (it has
   * "Pathways Suite" and "Pathways"), so the test was asserting a fixture rather than the
   * behaviour. What is under test is "a site opens and shows its pages", which any site proves.
   */
  await page.locator("[data-slot='iris-site-row']").first().click()
  // Scoped to the DETAIL nav: "Pages" is a level-2 tab as well as a level-3 one, and an
  // unscoped getByRole("tab", {name: "Pages"}) matches both.
  const detailNav = page.locator(".iris-detailnav")
  await expect(detailNav.getByRole("tab", { name: "Pages" })).toBeVisible({ timeout: 30_000 })
  await detailNav.getByRole("tab", { name: "Pages" }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: "e2e/test-results/sites-detail.png" })
  const detail = await page.locator("[data-slot='tabs-content']").innerText()
  console.log("SITE DETAIL:\n" + detail.slice(0, 400))

  expect(errs).toEqual([])
})
