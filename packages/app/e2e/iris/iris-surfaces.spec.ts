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

  // EXPECTED TO FAIL while #184890 stands. The feature itself works — verified by hand in the
  // running app, with Atlas lists, the four-surface switcher and a bloq selector all rendered.
  // What this harness cannot do is reliably get the tab SELECTED: Review wins whenever the
  // session has changes to show, and every session this suite creates has them. Kept failing
  // rather than skipped so the defect stays visible in a run.
  test.fail("the IRIS tab renders live account data, and switching surfaces does not blank it", async ({ page }) => {
    const sessionID = process.env.IRIS_E2E_SESSION
    test.skip(!sessionID, "set IRIS_E2E_SESSION to a session id on the running sidecar")

    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))

    await configure(page)
    await page.goto(`/${btoa(directory)}/session/${sessionID}`)
    await page.waitForLoadState("domcontentloaded")

    await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })

    // Then click the CHIP. The header button opens the panel and puts "iris" in the tab list,
    // but Review still wins the selection when the session has changes to show — measured: a
    // session with "Files Changed 5" opened on Review with the IRIS chip sitting unselected
    // beside it, while a session with no tracked changes opened straight onto IRIS. That is a
    // separate defect (#184890); this click routes around it so the assertions below are about
    // the panel's CONTENT rather than about which tab won.
    const chip = page.getByText("IRIS", { exact: true }).last()
    if (await chip.count()) await chip.click().catch(() => {})

    // The switcher is the proof the tab mounted — four surfaces behind one tab.
    for (const label of ["Atlas", "Agents", "Leads", "Pages"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible({ timeout: 30_000 })
    }

    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
    const body = await page.locator("body").innerText()
    expect(body, "the panel rendered a failure, not data").not.toMatch(/Could not reach IRIS|Could not load/)
    await page.screenshot({ path: "e2e/test-results/iris-tab-atlas.png" })

    // NO BLANK ON SWITCH. Reported as "everything goes black and then it shows again": the
    // panel emptied for the length of a refetch. Assert the switcher is STILL painted
    // immediately after clicking another surface, with no wait to hide a flash.
    await page.getByRole("button", { name: "Leads", exact: true }).click()
    await expect(page.getByRole("button", { name: "Atlas", exact: true })).toBeVisible({ timeout: 1_000 })
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 1_000 })
    await page.screenshot({ path: "e2e/test-results/iris-tab-leads.png" })

    expect(errors).toEqual([])
  })
})
