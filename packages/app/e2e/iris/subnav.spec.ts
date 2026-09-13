import { expect, test, type Page } from "@playwright/test"

/**
 * The pixel check for level-2 navigation.
 *
 * Same posture as iris-surfaces.spec.ts: real app, real sidecar, assertions on rendered text.
 * Not a CI test — it needs a signed-in machine and a live session.
 *
 *   packages/opencode: bun run --conditions=browser ./src/index.ts serve --port 4310
 *   packages/app:      IRIS_E2E_SESSION=<id> bunx playwright test e2e/iris/subnav --project=chromium
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
    // Start from a known place rather than from whatever this browser profile remembers — but
    // ONLY on the first load. addInitScript runs again on every navigation, reloads included,
    // so clearing unconditionally wipes the persisted state one line before asserting that it
    // persisted. That is a harness that cannot tell "persistence is broken" from "I broke it",
    // and it reported the first while doing the second. sessionStorage survives the reload.
    if (!sessionStorage.getItem("e2e.iris.seeded")) {
      sessionStorage.setItem("e2e.iris.seeded", "1")
      localStorage.setItem("iris.panel.surface", "atlas")
      localStorage.removeItem("iris.panel.subviews")
    }
  }, directory)
}

/**
 * Open the panel, routing around #184890 — Review wins the tab whenever the session has changes,
 * and every session this suite touches has them.
 *
 * The header button opens the panel and puts IRIS in the tab list; it does NOT select it. The
 * thing that selects it is the tab itself, which is `[data-slot=tabs-trigger][role=tab]` and
 * carries aria-selected. An earlier version of this helper clicked `getByText("IRIS").last()`,
 * which matches the wrapper div rather than the button — the click landed on a non-interactive
 * element, nothing happened, and the failure read as "the panel does not render".
 */
async function openIris(page: Page) {
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  const tab = page.getByRole("tab", { name: "IRIS", exact: true })
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 10_000 })
  await expect(page.getByRole("button", { name: "Atlas", exact: true })).toBeVisible({ timeout: 30_000 })
}

// The installed browser build does not match this Playwright, and downloading one needs disk
// this machine does not have. The system Chrome is the same engine and is already here.
test.use({ channel: "chrome" })

test.describe("iris sub-navigation", () => {
  test.setTimeout(180_000)

  test("two levels render, and level 2 changes the pane without blanking it", async ({ page }) => {
    const sessionID = process.env.IRIS_E2E_SESSION
    test.skip(!sessionID, "set IRIS_E2E_SESSION to a session id on the running sidecar")

    const errors: string[] = []
    const bad: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    page.on("response", (r) => r.status() >= 400 && r.url().includes("/iris/") && bad.push(`${r.status()} ${r.url()}`))

    await configure(page)
    await page.goto(`/${btoa(directory)}/session/${sessionID}`)
    await page.waitForLoadState("domcontentloaded")
    await openIris(page)

    // Schemas is GONE from level 1 — it moved under Atlas. If it is still a top-level tab the
    // move did not happen, and the two would be showing the same rows in two places.
    const strip = page.locator(".iris-surfaces")
    await expect(strip).toBeVisible()
    await expect(strip.getByRole("button", { name: "Schemas", exact: true })).toHaveCount(0)

    // LEVEL 2 exists, and is a different element from level 1 — not a second segmented control.
    const subnav = page.locator(".iris-subnav")
    await expect(subnav).toBeVisible({ timeout: 30_000 })
    await expect(subnav.getByRole("tab", { name: "Lists" })).toHaveAttribute("aria-selected", "true")
    await expect(subnav.getByRole("tab", { name: "Schemas" })).toHaveAttribute("aria-selected", "false")
    await page.screenshot({ path: "e2e/test-results/subnav-atlas-lists.png" })

    // Atlas -> Schemas. A DIFFERENT ENDPOINT and a different renderer, resolved together: the
    // failure this guards is /iris/schemas/N drawn by the Atlas renderer, which reads `lists`
    // from a payload whose array is `schemas` — a full response rendered as an empty board.
    await subnav.getByRole("tab", { name: "Schemas" }).click()
    // The strip must still be painted IMMEDIATELY. "Everything goes black and then it shows
    // again" was this panel emptying for the length of a refetch.
    await expect(strip).toBeVisible({ timeout: 1_000 })
    await expect(subnav.getByRole("tab", { name: "Schemas" })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
    let body = await page.locator("body").innerText()
    expect(body, "Atlas › Schemas rendered a failure").not.toMatch(/Could not reach IRIS|Could not load/)
    await page.screenshot({ path: "e2e/test-results/subnav-atlas-schemas.png" })

    // HIVE -> INBOX. The original ask: the inbox, in this tab, beside the machines.
    await strip.getByRole("button", { name: "Hive", exact: true }).click()
    await expect(subnav.getByRole("tab", { name: "Machines" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
    await page.screenshot({ path: "e2e/test-results/subnav-hive-machines.png" })

    await subnav.getByRole("tab", { name: "Inbox" }).click()
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
    body = await page.locator("body").innerText()
    expect(body, "Hive › Inbox rendered a failure").not.toMatch(/Could not reach IRIS|Could not load/)
    // The empty state must never say "on this board" about the account-wide Hive.
    expect(body).not.toMatch(/Nothing in Hive.*on this board/)
    await page.screenshot({ path: "e2e/test-results/subnav-hive-inbox.png" })

    // AGENTS -> SCHEDULED. Narrowed server-side; the footer count must describe the rows on
    // screen, not the unfiltered set.
    await strip.getByRole("button", { name: "Agents", exact: true }).click()
    await expect(subnav.getByRole("tab", { name: "On demand" })).toBeVisible({ timeout: 30_000 })
    await subnav.getByRole("tab", { name: "Scheduled" }).click()
    await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
    await page.screenshot({ path: "e2e/test-results/subnav-agents-scheduled.png" })

    // THE MEMORY IS PER SURFACE. Leave Agents on Scheduled, go to Hive, come back: Elon keeps
    // one scalar for both levels and resets it, which is the thing people complain about.
    await strip.getByRole("button", { name: "Hive", exact: true }).click()
    await expect(subnav.getByRole("tab", { name: "Machines" })).toBeVisible({ timeout: 30_000 })
    await strip.getByRole("button", { name: "Agents", exact: true }).click()
    await expect(subnav.getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true", {
      timeout: 30_000,
    })

    // And it SURVIVES A RELOAD, which is the half that is actually persisted.
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    await openIris(page)
    await strip.getByRole("button", { name: "Agents", exact: true }).click()
    await expect(subnav.getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true", {
      timeout: 30_000,
    })
    await page.screenshot({ path: "e2e/test-results/subnav-remembered.png" })

    if (bad.length) console.log("non-2xx /iris/ responses: " + JSON.stringify(bad))
    expect(bad).toEqual([])
    expect(errors.filter((e) => /iris/i.test(e))).toEqual([])
  })
})
