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
      localStorage.setItem("iris.panel.bloq", "174")
      localStorage.setItem("iris.panel.surface", "atlas")
      localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: "schemas" }))
    }
  }, directory)
}

test("clicking Records must not blank the panel", async ({ page }) => {
  test.setTimeout(180_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))

  await configure(page)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })

  await page.locator("[data-slot='tabs-content'] button", { hasText: "Pathways Cases" }).first().click()
  const nav = page.locator(".iris-detailnav")
  await expect(nav.getByRole("tab", { name: "Records" })).toBeVisible({ timeout: 30_000 })

  // SAMPLE the panel every 60ms across the click. If the surface strip or the record title
  // ever vanishes, that is the blank the user is reporting.
  const samples: string[] = []
  const stop = Date.now() + 6000
  const poll = (async () => {
    while (Date.now() < stop) {
      samples.push(await page.locator("[data-slot='tabs-content']").innerText().catch(() => "<<GONE>>"))
      await page.waitForTimeout(60)
    }
  })()
  await nav.getByRole("tab", { name: "Records" }).click()
  await poll

  const blanks = samples.filter((t) => !t.includes("Pathways Cases") || t.trim().length < 40)
  console.log(`SAMPLES ${samples.length} | BLANK FRAMES ${blanks.length}`)
  if (blanks.length) console.log("FIRST BLANK:\n" + JSON.stringify(blanks[0].slice(0, 200)))
  console.log("LAST:\n" + samples[samples.length - 1].slice(0, 220))
  console.log("ERRORS: " + errs.join(" | "))
})
