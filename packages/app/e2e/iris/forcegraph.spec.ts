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
    // The graph is scoped to the selected board by default now. This test is about the
    // FULL atlas — the force layout across every connected board — so it says so rather
    // than inheriting whatever the default happens to be.
    localStorage.setItem("iris.panel.graphScope", "full")
    localStorage.setItem("iris.panel.subviews", JSON.stringify({ atlas: "graph" }))
  }, directory)
  await page.goto(`/${btoa(directory)}/session/${process.env.IRIS_E2E_SESSION}`)
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("button", { name: "IRIS" }).first().click({ timeout: 30_000 })
  await page.getByRole("tab", { name: "IRIS", exact: true }).click()

  const svg = page.locator(".iris-graph__svg")
  await expect(svg).toBeVisible({ timeout: 40_000 })
  await page.waitForTimeout(6000) // let the simulation settle AND fit

  /*
   * THE WHOLE GRAPH, not a page.
   *
   * It used to render 25 of 39 connected boards and drop every edge to the other 14 — a
   * truncated node list becomes a truncated picture that looks complete. The summary line is
   * the control: whatever it says is connected must be what is drawn.
   */
  const summary = await page.locator("[data-slot='tabs-content']").innerText()
  const connected = Number(summary.match(/across (\d+) boards/)?.[1] ?? 0)
  expect(connected).toBeGreaterThan(0)
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)

  const circles = await svg.locator("circle").count()
  const lines = await svg.locator("line").count()
  console.log(`NODES ${circles} | EDGES ${lines}`)
  expect(circles).toBe(connected)
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
  /*
   * It must USE the canvas on at least one axis.
   *
   * Not both: once the layout is fitted, the axis that is not binding legitimately has slack —
   * a tall narrow graph fitted by height leaves horizontal room, and demanding 50% on both
   * would fail a correct render. A corner-cluster is ~10% on BOTH, which this still catches.
   */
  const fill = Math.max(spreadX / box.width, spreadY / box.height)
  console.log(`fill ${(fill * 100).toFixed(0)}% of the binding axis`)
  expect(fill).toBeGreaterThan(0.5)

  /*
   * AND IT MUST FIT. A force layout spreads to whatever the forces dictate, not to the box:
   * before the fit, 945x1419 of content sat in an 800x388 canvas and a third of the boards
   * were past the bottom edge. Spreading is necessary and not sufficient.
   */
  const outside = pts.filter(
    (p) => p.x < box.x - 2 || p.x > box.x + box.width + 2 || p.y < box.y - 2 || p.y > box.y + box.height + 2,
  ).length
  /*
   * MOST visible, and the cluster centred. Not all.
   *
   * There is a real trade-off here and the test should state it rather than hide it: 39 nodes
   * at link-distance 120 span ~1400px, and a canvas 388px tall cannot show that AND keep an
   * 11px label legible. The fit stops shrinking at k=0.5 for legibility, so the remainder is
   * reached by panning.
   *
   * This viewport is deliberately short — 720px window, 388px canvas. The real panel at full
   * height is roughly double that, where the same clamp fits nearly everything. So the bound
   * here is loose ON PURPOSE, and the assertion that carries the weight is the centring below:
   * an off-centre cluster is the bug, a tall graph needing a scroll is not.
   */
  console.log(`nodes outside the canvas: ${outside} of ${pts.length}`)
  expect(outside).toBeLessThan(pts.length * 0.4)

  const cy = ys.reduce((a, b) => a + b, 0) / ys.length
  expect(Math.abs(cy - (box.y + box.height / 2))).toBeLessThan(box.height * 0.3)

  // And the cluster must be roughly centred, not pinned to an edge.
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length
  expect(Math.abs(cx - (box.x + box.width / 2))).toBeLessThan(box.width * 0.25)

  // Edges must be anchored to nodes, not parked at the origin.
  const atOrigin = await svg.locator("line").evaluateAll((els) =>
    els.filter((l) => l.getAttribute("x1") === "0" && l.getAttribute("y1") === "0").length,
  )
  console.log(`edges stuck at origin: ${atOrigin}`)
  expect(atOrigin).toBe(0)

  /*
   * FULL BLEED. The canvas has to use the pane, not sit in a box inside it. Measured against
   * the panel's own width, because "it got bigger" is not "it fills the space".
   */
  const panel = (await page.locator("[data-slot='tabs-content']").boundingBox())!
  console.log(`panel ${Math.round(panel.width)} | canvas ${Math.round(box.width)}x${Math.round(box.height)}`)
  expect(box.width).toBeGreaterThan(panel.width - 4)
  expect(box.height).toBeGreaterThan(240)

  // The DEFAULT state is what people see; capture it before opening anything.
  await page.screenshot({ path: "e2e/test-results/forcegraph.png" })

  // The list is FOLDED, not gone: closed by default, and still reachable.
  const rows = page.locator(".iris-rows")
  await expect(rows).toBeVisible()
  expect(await rows.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await rows.locator("summary").click()
  expect(await rows.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
  await expect(rows).toContainText("feeds_into")

  await page.screenshot({ path: "e2e/test-results/forcegraph-open.png" })
  expect(errs).toEqual([])
})
