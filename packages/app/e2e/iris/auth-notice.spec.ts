import { expect, test } from "@playwright/test"

/**
 * The credential warning, rendered.
 *
 * Driven against whichever sidecar PLAYWRIGHT_SERVER_PORT points at, and run TWICE — once
 * against a server whose environment has no IRIS_API_KEY, once against one that has it. A
 * single run could not tell "the warning works" from "the warning is always on".
 */
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
const expected = process.env.IRIS_EXPECT_NOTICE === "1"

test("the credential warning appears exactly when the provider is blind", async ({ page }) => {
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
  }, directory)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")

  // Wait for the fleet pill to settle first — it shares the same fetch cycle, so once it has
  // resolved the auth resource has had its chance too. Without this the "absent" assertion
  // would pass simply by being early.
  const fleet = page.locator("[data-slot='iris-fleet-pill']")
  await expect(fleet).toBeVisible({ timeout: 30_000 })
  await expect(fleet).not.toHaveText(/·/, { timeout: 30_000 })

  const notice = page.locator("[data-slot='iris-auth-pill']")
  await page.screenshot({ path: `e2e/test-results/auth-notice-${expected ? "blind" : "ready"}.png` })

  if (expected) {
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(notice).toContainText("Key unreachable")
    const hint = await notice.getAttribute("title")
    expect(hint, "the hint must say signing in again will not help").toMatch(/will not help/i)
  } else {
    await expect(notice).toHaveCount(0)
  }
})
