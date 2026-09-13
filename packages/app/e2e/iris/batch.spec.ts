import { expect, test, type Page } from "@playwright/test"

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

async function open(page: Page, surface: string, subviews: Record<string, string>, bloq = "174") {
  await page.addInitScript(
    ([dir, s, sv, b]: any) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem("iris.panel.bloq", b)
      localStorage.setItem("iris.panel.surface", s)
      localStorage.setItem("iris.panel.subviews", sv)
    },
    [directory, surface, JSON.stringify(subviews), bloq],
  )
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
}

test("integrations show a provider mark and put the failing one first", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, "integrations", { integrations: "user" })
  const marks = page.locator(".iris-int__mark")
  await expect(marks.first()).toBeVisible({ timeout: 30_000 })
  const first = await page.locator("[data-slot='tabs-content'] button").filter({ has: marks }).first().innerText()
  console.log("FIRST ROW: " + JSON.stringify(first.slice(0, 90)))
  expect(first).toContain("CourtListener")
  expect(await page.locator(".iris-int__mark--error").count()).toBeGreaterThan(0)
  expect(await page.locator(".iris-int__mark--live").count()).toBeGreaterThan(0)
  await page.screenshot({ path: "e2e/test-results/batch-integrations.png" })
})

test("an open Atlas item offers the commands that act on it", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, "atlas", { atlas: "lists" }, "679")
  // Open the first item that has a body.
  await page.locator("[data-slot='tabs-content'] button:not([disabled])").filter({ hasText: /#\d+/ }).first().click()
  const bar = page.locator(".iris-cmdbar")
  await expect(bar).toBeVisible({ timeout: 30_000 })
  const labels = await bar.locator("button").allInnerTexts()
  console.log("COMMAND CHIPS: " + JSON.stringify(labels))
  expect(labels).toContain("use")
  expect(labels).toContain("assign")
  await page.screenshot({ path: "e2e/test-results/batch-atlas-item.png" })
})

test("a playbook shows its steps and its local document", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, "playbooks", {}, "679")
  await page.locator("[data-slot='tabs-content'] button", { hasText: "agentic-loop" }).first().click()
  const nav = page.locator(".iris-detailnav")
  await expect(nav.getByRole("tab", { name: "Steps" })).toBeVisible({ timeout: 30_000 })
  await nav.getByRole("tab", { name: "Steps" }).click()
  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("Arguments", { timeout: 30_000 })
  await nav.getByRole("tab", { name: "Document" }).click()
  await expect(body).toContainText("PLAYBOOK.md", { timeout: 60_000 })
  const text = await body.innerText()
  console.log("DOC PANE: " + JSON.stringify(text.slice(0, 200)))
  await page.screenshot({ path: "e2e/test-results/batch-playbook.png" })
})
