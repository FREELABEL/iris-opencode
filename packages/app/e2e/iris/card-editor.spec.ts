import { expect, test, type Page } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

/**
 * The card editor (#185485) — read-only against a real board.
 *
 * Writes are NOT exercised here on purpose: this runs against production data on a board
 * someone works in. The write paths were verified by hand on scratch items (title, status,
 * type, priority, list, due, body, task add / complete / delete, agent assign — each read back
 * from fl-api's side) and the wire mapping is locked in unit tests. What this proves is the
 * thing unit tests cannot: a row opens the editor, both columns render from live data, and
 * Save is inert until something changes.
 */
async function open(page: Page, bloq: string) {
  await page.addInitScript(
    ([dir, b]: any) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem("iris.panel.bloq", b)
      localStorage.setItem("iris.panel.surface", "atlas")
      localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: "lists" }))
    },
    [directory, bloq],
  )
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 })
}

test("a row opens the card editor, and it shows the card", async ({ page }) => {
  test.setTimeout(150_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))
  await open(page, "679")

  // EVERY row opens now — including one with no body. The old reader disabled those.
  const rows = page.locator("[data-slot='tabs-content'] button[title='Open this card']")
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  expect(await rows.locator(":scope[disabled]").count()).toBe(0)
  const rowText = (await rows.first().innerText()).replace(/\s+/g, " ").trim()
  const id = rowText.match(/#(\d+)/)?.[1]
  expect(id).toBeTruthy()
  await rows.first().click()

  const card = page.locator(".iris-card")
  await expect(card).toBeVisible({ timeout: 30_000 })
  // Breadcrumb carries the id; the title is an INPUT, not a heading.
  await expect(card.locator(".iris-card__crumb")).toContainText(`#${id}`)
  const title = card.locator(".iris-card__title")
  await expect(title).toBeVisible()
  expect((await title.inputValue()).length).toBeGreaterThan(0)

  // The command chips moved in with the card — batch.spec asserts on them too.
  const chips = await card.locator(".iris-cmdbar button").allInnerTexts()
  expect(chips).toEqual(["use", "show", "edit", "assign", "share"])

  // Details: the five writable fields, with the item's current status preserved in the picker
  // even when the board vocabulary does not name it (`active` is the common case).
  // innerText honours text-transform, and the labels are drawn in caps. Compare the words.
  const labels = (await card.locator(".iris-field__label").allInnerTexts()).map((l) => l.toLowerCase())
  expect(labels).toEqual(["status", "type", "priority", "list", "due"])
  const status = card.locator("select.iris-field__input").first()
  await expect(status).not.toHaveValue("", { timeout: 30_000 })
  const listPicker = card.locator("select.iris-field__input").nth(3)
  expect((await listPicker.locator("option").count())).toBeGreaterThan(1)

  // Save is inert until something changes — it says so rather than pretending.
  await expect(card.getByRole("button", { name: "No changes" })).toBeVisible()

  // Tasks: the tab is measured (a count, not a blank) and the add form is there.
  await card.getByRole("tab", { name: /^Tasks/ }).click()
  await expect(card.locator("input[aria-label='New task']")).toBeVisible()
  await expect(card.locator("select[aria-label='Assign to agent']")).toBeVisible()

  await page.screenshot({ path: "e2e/test-results/card-editor.png" })

  // Close returns to the row: the list is still there, nothing navigated.
  await page.keyboard.press("Escape")
  await expect(card).toHaveCount(0)
  await expect(rows.first()).toBeVisible()
  expect(errs).toEqual([])
})
