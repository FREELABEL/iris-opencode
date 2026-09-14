import { expect, test, type Page } from "@playwright/test"

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

async function openGraph(page: Page, bloq: string, scope?: string) {
  await page.addInitScript(
    ([dir, b, sc]: any) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem("iris.panel.bloq", b)
      localStorage.setItem("iris.panel.surface", "atlas")
      localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: "graph" }))
      if (sc) localStorage.setItem("iris.panel.graphScope", sc)
      else localStorage.removeItem("iris.panel.graphScope")
    },
    [directory, bloq, scope],
  )
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 40_000 })
}

const scopeTab = (page: Page, name: string) =>
  page.locator(".iris-scope").getByRole("tab", { name, exact: true })

test("the graph opens scoped to the selected board, not the whole account", async ({ page }) => {
  test.setTimeout(150_000)
  await openGraph(page, "174")

  await expect(scopeTab(page, "Project")).toHaveAttribute("aria-selected", "true")

  /*
   * The account-wide sentence must NOT appear under a scoped drawing.
   *
   * This is the assertion that would have caught the original bug from the other side: the
   * summary said "47 relations across 40 boards · 120 boards (75%) connect to nothing" no
   * matter which board was picked, because it was read straight off the server's account-wide
   * summary. A count that describes a set the picture never showed is the same defect as a
   * footer counting the unfiltered page.
   */
  const body = page.locator("[data-slot='tabs-content']").filter({ hasText: "Atlas" })
  await expect(body).not.toContainText("connect to nothing")
})

test("switching scope to Full atlas changes both the drawing and the sentence under it", async ({ page }) => {
  test.setTimeout(150_000)
  await openGraph(page, "174")
  const body = page.locator("[data-slot='tabs-content']").filter({ hasText: "Atlas" })

  await scopeTab(page, "Full atlas").click()
  await expect(scopeTab(page, "Full atlas")).toHaveAttribute("aria-selected", "true")
  // Only the full atlas may make a claim about the whole account.
  await expect(body).toContainText("connect to nothing", { timeout: 40_000 })
})

test("an isolated board says so, and offers the way out, instead of drawing nothing", async ({ page }) => {
  test.setTimeout(150_000)
  // Board 174 has no relations — three boards in four on this account do not.
  await openGraph(page, "174")

  await expect(page.getByText("has no relation to any other board")).toBeVisible({ timeout: 40_000 })
  // A blank canvas reads as a failed load. The finding has to be stated, and recoverable.
  const escape = page.getByRole("button", { name: "Show the full atlas" })
  await expect(escape).toBeVisible()
  await escape.click()
  await expect(scopeTab(page, "Full atlas")).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".iris-graph__svg")).toBeVisible({ timeout: 40_000 })
})
