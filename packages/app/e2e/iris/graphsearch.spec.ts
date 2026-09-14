import { expect, test, type Page } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

async function open(page: Page, sub: string) {
  await page.addInitScript(
    ([dir, sv]: any) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem("iris.panel.bloq", "174")
      localStorage.setItem("iris.panel.surface", "atlas")
      localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: sv }))
    },
    [directory, sub],
  )
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 40_000 })
}

test("Atlas has Lists, Schemas and Graph; the graph leads with what is isolated", async ({ page }) => {
  test.setTimeout(150_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))
  await open(page, "graph")
  const nav = page.locator(".iris-subnav")
  for (const t of ["Lists", "Schemas", "Graph"]) await expect(nav.getByRole("tab", { name: t })).toBeVisible()

  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("connect to nothing", { timeout: 40_000 })
  const text = await body.innerText()
  console.log("GRAPH:\n" + text.split("\n").slice(5, 14).join("\n"))
  expect(text).toContain("Vanguard")
  // Direction is drawn — feeds_into read backwards is a different claim.
  expect(text).toMatch(/[→←]/)
  await page.screenshot({ path: "e2e/test-results/graph.png" })
  expect(errs).toEqual([])
})

test("search filters the board, and an empty result says so", async ({ page }) => {
  test.setTimeout(150_000)
  await open(page, "lists")
  const input = page.locator(".iris-search__input")
  await expect(input).toBeVisible({ timeout: 30_000 })

  await input.fill("servis")
  await expect(page.locator("[data-slot='tabs-content']")).toContainText("Agent Deliverables", { timeout: 40_000 })
  console.log("MATCHED: " + (await page.locator("[data-slot='tabs-content']").innerText()).split("\n").slice(4, 8).join(" | "))
  await page.screenshot({ path: "e2e/test-results/search.png" })

  await input.fill("zzz-nothing-matches-this")
  // NOT "this board is empty" — a different fact.
  await expect(page.locator("[data-slot='tabs-content']")).toContainText("matches", { timeout: 40_000 })
  const t = await page.locator("[data-slot='tabs-content']").innerText()
  expect(t).not.toContain("Nothing in Atlas")
})
