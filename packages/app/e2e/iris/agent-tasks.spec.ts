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
      // Bloq 38 is the board with agents that actually hold work.
      localStorage.setItem("iris.panel.bloq", "38")
      localStorage.setItem("iris.panel.surface", "agents")
      localStorage.removeItem("iris.panel.subviews")
    }
  }, directory)
}

test("an agent's Tasks tab shows what it was actually given", async ({ page }) => {
  test.setTimeout(180_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))

  await configure(page)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })

  // Open the agent that holds the assignment.
  await page.locator("[data-slot='tabs-content'] button", { hasText: "Josie" }).first().click()
  const detailNav = page.locator(".iris-detailnav")
  await expect(detailNav.getByRole("tab", { name: "Tasks" })).toBeVisible({ timeout: 30_000 })
  await detailNav.getByRole("tab", { name: "Tasks" }).click()

  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("verify agent task round trip", { timeout: 60_000 })
  const text = await body.innerText()
  console.log("TASKS PANE:\n" + text.slice(0, 600))
  await page.screenshot({ path: "e2e/test-results/agent-tasks.png" })

  // The whole point: it says WHERE the work lives, not just that a task exists.
  expect(text).toContain("Prod Bug Fixes")
  expect(text).toMatch(/1 assigned/)
  expect(text).not.toMatch(/Could not load/)
  expect(errs).toEqual([])
})
