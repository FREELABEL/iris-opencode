import { expect, test, type Page } from "@playwright/test"

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

const PANEL = "#session-side-panel-iris-tabpanel"

/*
 * The identity anchor is the surface strip INSIDE the panel, not the panel wrapper.
 *
 * The wrapper id arrived with the fix, so a test stamped on it fails against the old code
 * for the wrong reason — "no such element" rather than "you rebuilt it". `.iris-surfaces`
 * is rendered by SessionIrisTab itself and exists in both versions, so the failure lands on
 * the behaviour under test instead of on the scaffolding that proves it.
 */
const ANCHOR = ".iris-surfaces"

async function open(page: Page) {
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
    localStorage.setItem("iris.panel.bloq", "174")
    localStorage.setItem("iris.panel.surface", "atlas")
    localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: "list" }))
  }, directory)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "Toggle review" }).click({ timeout: 30_000 })
  await expect(page.locator("[data-slot='tabs-list']")).toBeVisible({ timeout: 30_000 })
}

/*
 * The black flash was a REMOUNT, so the test has to be able to tell a remount from a hide.
 *
 * Sampling pixels or text cannot: a rebuild that happens to finish inside one polling gap
 * looks exactly like a panel that never moved, and the existing hiccup.spec only *logs* its
 * blank frames, so it reports the symptom without ever failing on it. Identity is decidable.
 * Stamp the live DOM node, leave, come back, and ask whether it is the same node. A rebuilt
 * panel cannot carry the stamp, no matter how fast it was.
 */
test("leaving IRIS and returning keeps the same panel, it is not rebuilt", async ({ page }) => {
  test.setTimeout(180_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))

  await open(page)
  const irisTab = page.getByRole("tab", { name: "IRIS", exact: true })
  await irisTab.click()
  await expect(irisTab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })

  const panel = page.locator(PANEL)
  const anchor = page.locator(ANCHOR)
  await expect(anchor).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 60_000 })

  // Something real on the surface, so "same node" also means "same rendered work".
  // Read the content through the anchor's own container, which both versions render, so
  // this comparison is not secretly another assertion about the new wrapper id.
  const content = anchor.locator("xpath=ancestor::div[@data-slot='tabs-content'][1]")
  const before = (await content.innerText()).trim()
  expect(before.length).toBeGreaterThan(40)

  await anchor.evaluate((el) => el.setAttribute("data-e2e-stamp", "original-mount"))

  // Leave. Any other tab will do; Review is the one guaranteed to exist here.
  const other = page.getByRole("tab", { name: "Review", exact: true })
  await other.click()
  await expect(other).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })

  // Still in the DOM while away — that is what makes the return instant instead of a rebuild.
  await expect(anchor).toHaveCount(1)
  await expect(anchor).toBeHidden()
  await expect(anchor).toHaveAttribute("data-e2e-stamp", "original-mount")
  await expect(panel).toHaveCount(1)

  await irisTab.click()
  await expect(irisTab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })
  await expect(anchor).toBeVisible()

  // THE assertion. A remount would have thrown the stamped node away.
  await expect(anchor).toHaveAttribute("data-e2e-stamp", "original-mount")
  // And exactly one, so a second mount rendered alongside cannot pass either.
  await expect(anchor).toHaveCount(1)
  await expect(panel).toHaveCount(1)

  // No "Loading…" on return: nothing refetched, because nothing was disposed.
  await expect(page.getByText("Loading…")).toHaveCount(0)
  expect((await content.innerText()).trim()).toBe(before)

  expect(errs, `page errors: ${errs.join(" | ")}`).toEqual([])
})
