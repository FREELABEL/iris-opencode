import { expect, test, type Page } from "@playwright/test"

const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

async function open(page: Page, subviews: Record<string, string>, bloq: string) {
  await page.addInitScript(
    ([dir, sv, b]: any) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem("iris.panel.bloq", b)
      localStorage.setItem("iris.panel.surface", "playbooks")
      localStorage.setItem("iris.panel.subviews", sv)
    },
    [directory, JSON.stringify(subviews), bloq],
  )
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
}

test("Project shows only this board's playbooks, not all 128", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, { playbooks: "project" }, "174")
  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("pathways-case-export", { timeout: 30_000 })
  const text = await body.innerText()
  // The flat list used to open on agent-browser. If it is here, the view did not narrow.
  expect(text).not.toContain("agent-browser")
  expect(text).toContain("Owned by another account")
  console.log("PROJECT:\n" + text.slice(0, 420))
  await page.screenshot({ path: "e2e/test-results/pb-project.png" })
})

test("a playbook that is not installed locally still shows its document", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, { playbooks: "marketplace" }, "174")
  await page.locator("[data-slot='tabs-content'] button", { hasText: "bounty-os-verification" }).first().click()
  const nav = page.locator(".iris-detailnav")
  await nav.getByRole("tab", { name: "Document" }).click()
  const body = page.locator("[data-slot='tabs-content']")
  await expect(body).toContainText("published ·", { timeout: 60_000 })
  const text = await body.innerText()
  console.log("DOC:\n" + text.slice(0, 300))
  // The real document, not a "not installed" dead end.
  expect(text).not.toContain("not installed on this machine")
  expect(text.length).toBeGreaterThan(800)
  await page.screenshot({ path: "e2e/test-results/pb-doc.png" })
})
