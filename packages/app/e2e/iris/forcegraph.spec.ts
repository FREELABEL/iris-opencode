import { expect, test } from "@playwright/test"
const directory = process.env.IRIS_E2E_DIR ?? process.cwd()
test.use({ channel: "chrome" })

test("the graph is a real force layout — nodes settle, edges connect them", async ({ page }) => {
  test.setTimeout(150_000)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(String(e)))
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
    localStorage.setItem("iris.panel.bloq", "174")
    localStorage.setItem("iris.panel.surface", "atlas")
    localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: "graph" }))
  }, directory)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()

  const svg = page.locator(".iris-graph__svg")
  await expect(svg).toBeVisible({ timeout: 40_000 })
  await page.waitForTimeout(3500) // let the simulation settle

  const circles = await svg.locator("circle").count()
  const lines = await svg.locator("line").count()
  console.log(`NODES ${circles} | EDGES ${lines}`)
  expect(circles).toBeGreaterThan(10)
  expect(lines).toBeGreaterThan(5)

  /*
   * THE LAYOUT MUST USE THE CANVAS, not merely differ.
   *
   * The first version of this test asserted that node positions were DISTINCT, and it passed
   * against a render with every node piled into the top-left corner — distinct by a few pixels
   * each, and useless. "The values are not identical" is not "the layout worked".
   *
   * So: measure the spread of the drawn nodes against the box they are drawn in.
   */
  const box = (await svg.boundingBox())!
  const pts = await svg.locator("g > g").evaluateAll((els) =>
    els
      .map((e) => e.getBoundingClientRect())
      .map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })),
  )
  expect(pts.length).toBeGreaterThan(10)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  console.log(
    `canvas ${Math.round(box.width)}x${Math.round(box.height)} | spread ${Math.round(spreadX)}x${Math.round(spreadY)}`,
  )
  // Half the canvas in each axis. A corner-cluster is ~10%.
  expect(spreadX).toBeGreaterThan(box.width * 0.5)
  expect(spreadY).toBeGreaterThan(box.height * 0.5)

  // And the cluster must be roughly centred, not pinned to an edge.
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length
  expect(Math.abs(cx - (box.x + box.width / 2))).toBeLessThan(box.width * 0.25)

  // Edges must be anchored to nodes, not parked at the origin.
  const atOrigin = await svg.locator("line").evaluateAll((els) =>
    els.filter((l) => l.getAttribute("x1") === "0" && l.getAttribute("y1") === "0").length,
  )
  console.log(`edges stuck at origin: ${atOrigin}`)
  expect(atOrigin).toBe(0)

  await page.screenshot({ path: "e2e/test-results/forcegraph.png" })
  expect(errs).toEqual([])
})
