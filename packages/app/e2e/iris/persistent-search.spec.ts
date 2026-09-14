import { expect, test, type Page } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

async function open(page: Page, surface: string, sub: Record<string, string> = {}) {
  await page.addInitScript(
    ([dir, s, sv]: any) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem("iris.panel.bloq", "174")
      localStorage.setItem("iris.panel.surface", s)
      localStorage.setItem("iris.panel.subviews", sv)
    },
    [directory, surface, JSON.stringify(sub)],
  )
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  /*
   * Opened via "Toggle review", NOT the IRIS header button.
   *
   * That distinction is the whole point: the IRIS button both opens the panel AND puts IRIS in
   * the tab list, so using it would pass whether or not the tab is persistent. Opening by
   * another route is the only way to ask "is it there when nobody put it there".
   */
  await page.getByRole("button", { name: "Toggle review" }).click({ timeout: 30_000 })
  await expect(page.locator("[data-slot='tabs-list']")).toBeVisible({ timeout: 30_000 })
}

test("the IRIS tab is present without being opened, and has no close button", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, "playbooks")
  const tab = page.getByRole("tab", { name: "IRIS", exact: true })
  await expect(tab).toBeVisible({ timeout: 30_000 })
  expect(await tab.locator("button, [aria-label*='lose']").count()).toBe(0)
  await tab.click()
  await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })
  await page.screenshot({ path: "e2e/test-results/persistent-tab.png" })
})

test("playbooks search uses the same control, and says a search found nothing", async ({ page }) => {
  test.setTimeout(150_000)
  await open(page, "playbooks", { playbooks: "marketplace" })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  const body = page.locator("[data-slot='tabs-content']")
  const input = page.locator(".iris-search__input")
  await expect(input).toBeVisible({ timeout: 40_000 })
  expect(await input.getAttribute("placeholder")).toContain("playbooks")

  // Matches a DESCRIPTION, which the name alone could never surface.
  await input.fill("bug report")
  await expect(body).toContainText("bounty-os-verification", { timeout: 40_000 })

  await input.fill("zzznope")
  /*
   * Wait for the LIST to clear, not for text to appear.
   *
   * A first attempt asserted a /matches/ locator became visible and it matched instantly — on
   * bridge-doctor's description, which contains "key mismatches", from the render before the
   * search landed. The assertion passed against stale content and then read the wrong element.
   * Waiting for a row that must disappear is the unambiguous signal.
   */
  await expect(body).not.toContainText("bounty-os-verification", { timeout: 40_000 })
  const t = await body.innerText()
  const line = t.split("\n").find((l) => l.includes("zzznope")) ?? ""
  console.log("EMPTY STATE: " + JSON.stringify(line))
  // "This surface is empty" and "your search matched nothing" are different facts.
  expect(line).toContain("Playbooks")
  expect(line).toContain("matches")
  await page.screenshot({ path: "e2e/test-results/playbook-search.png" })
})
