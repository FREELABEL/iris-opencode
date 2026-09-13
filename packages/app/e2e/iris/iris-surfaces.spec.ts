import { expect, test, type Page } from "@playwright/test"

/**
 * The pixel check. Deliberately NOT mocked.
 *
 * Every other layer of this work is already verified on its own — the platform module against
 * the live API, seven routes against a running server, the view decisions as pure functions
 * with controls. None of that says a person can SEE anything, and this codebase has paid for
 * that gap twice in one day: a green typecheck shipped a hint line that rendered
 * "read &lt;n>" on screen, and another that crashed the TUI at launch on a TDZ error.
 *
 * So this runs the real app against the real sidecar and asserts on rendered text. It needs a
 * signed-in machine and is not a CI test.
 *
 *   packages/opencode: bun run --conditions=browser ./src/index.ts serve --port 4096
 *   packages/app:      bunx playwright test e2e/iris --project=chromium
 */

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()

async function configure(page: Page) {
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: dir, expanded: true }] },
        lastProject: { local: dir },
      }),
    )
  }, directory)
}

test.describe("iris surfaces render", () => {
  test.setTimeout(120_000)

  test("the Hive pills show a measured fleet, not a dash", async ({ page }) => {
    const errors: string[] = []
    const badResponses: string[] = []
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("response", (r) => r.status() >= 400 && badResponses.push(`${r.status()} ${r.url()}`))

    await configure(page)
    await page.goto("/")
    // NOT networkidle: the app holds an event stream open for the life of the session, so
    // "the network went quiet" never happens and the wait burns the whole timeout. Measured —
    // it cost one 120s run before the screenshot showed the app had rendered fine all along.
    await page.waitForLoadState("domcontentloaded")

    // The pills fetch on mount; the locator wait below is the real synchronisation.
    // Matched on a data-slot, not on text: the pill's own text is "●3/4" (the glyph and the
    // count are one element, spaced by a margin), so a /^\d+\/\d+$/ text match finds nothing
    // while the thing is plainly on screen.
    const pill = page.locator("[data-slot='iris-fleet-pill']")
    await expect(pill).toBeVisible({ timeout: 30_000 })
    // Wait for the pill to SETTLE, not merely to exist. Asserting on first paint read "·"
    // (in flight) and, before that state existed at all, read "—" and called the sidecar
    // unreachable on a run where it was fine.
    await expect(pill).not.toHaveText(/·/, { timeout: 30_000 })
    const text = (await pill.innerText()).trim()

    await page.screenshot({ path: "e2e/test-results/iris-pills.png" })

    // A dash means the fetch failed. It is a CORRECT render of a failure, and it is not what
    // this test is here to confirm — so it fails loudly rather than passing on the fallback.
    expect(text, "fleet pill showed a dash, meaning the sidecar could not be reached").toMatch(/\d+\/\d+/)

    // Scoped to OUR surface. A blanket "no console errors" assertion fails on unrelated 500s
    // from the dev server and turns a real signal into noise someone learns to ignore.
    if (badResponses.length) console.log("non-2xx responses seen: " + JSON.stringify(badResponses))
    expect(badResponses.filter((r) => r.includes("/iris/"))).toEqual([])
    expect(errors.filter((e) => /iris/i.test(e))).toEqual([])
  })

  // KNOWN FAILING, deliberately not deleted. The IRIS chip appears in the panel's tab strip and
  // its CONTENT never activates: instrumenting the panel showed `all: "iris"` but
  // `tabs().active() === "review"` at render, so createSessionTabs' activeTab() falls through to
  // the review branch. Something resets active to "review" after the button sets it to "iris" —
  // localStorage reads "iris" half a second after the click, and the panel still renders review.
  // Left failing because a skipped test and a fixed bug look identical in a green run.
  test.fail("the IRIS tab renders Atlas lists from the live account", async ({ page }) => {
    const sessionID = process.env.IRIS_E2E_SESSION
    test.skip(!sessionID, "set IRIS_E2E_SESSION to a session id on the running sidecar")

    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))

    await configure(page)
    await page.goto(`/${btoa(directory)}/session/${sessionID}`)
    await page.waitForLoadState("domcontentloaded")

    // The IRIS button lives in the session header; it opens the panel AND selects the tab,
    // because the tab only renders once "iris" is in the tab list.
    const button = page.getByRole("button", { name: "IRIS" })
    await expect(button).toBeVisible({ timeout: 30_000 })
    await button.click()

    const panel = page.locator("[data-slot='tabs-content'], [role='tabpanel']").filter({ hasText: /Atlas|Agents|Leads|Pages/ })
    await expect(panel.first()).toBeVisible({ timeout: 20_000 })

    // Wait past the loading state, then assert we are NOT looking at a failure render.
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
    await page.screenshot({ path: "e2e/test-results/iris-tab.png", fullPage: false })

    const body = await page.locator("body").innerText()
    expect(body, "the panel rendered a failure, not data").not.toMatch(/Could not reach IRIS|Could not load/)
    expect(errors).toEqual([])
  })
})
