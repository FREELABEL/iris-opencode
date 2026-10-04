import { plugin } from "bun"
import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createRenderEffect, createResource, ErrorBoundary, Suspense } from "solid-js"
import { createComponent, render } from "solid-js/web"

// Bun compiles .tsx with an eager JSX runtime: children are built BEFORE the boundary exists, so
// no ErrorBoundary can catch them and this test would fail against correct code. Compile the
// component the way vite does (babel-preset-solid, the same toolchain vite-plugin-solid uses).
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /iris-panel-boundary\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
  },
})
const { IrisPanelBoundary } = await import("../src/components/iris-panel-boundary")

const tick = () => new Promise((r) => setTimeout(r, 10))

// Reported on Windows 1.18.87: a side panel's fetch to the sidecar rejected ("Failed to fetch") and
// the error page replaced the whole window. The failure must stop at the panel.
test("a panel whose sidecar fetch rejects shows its own error, not the app's", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  let calls = 0
  let appCrashed = false

  const Panel = () => {
    const [data] = createResource(async () => {
      calls++
      if (calls === 1) throw new TypeError("Failed to fetch")
      return "rooms loaded"
    })
    const el = document.createElement("span")
    el.setAttribute("data-slot", "panel-body")
    // What compiled JSX does for {data()}: the read happens in an effect owned by THIS component.
    createRenderEffect(() => (el.textContent = data() ?? ""))
    return el
  }

  const dispose = render(
    () =>
      createComponent(ErrorBoundary, {
        fallback: () => {
          appCrashed = true
          return "Something went wrong"
        },
        get children() {
          return [
            "rest of the app",
            createComponent(IrisPanelBoundary, {
              label: "The IRIS panel",
              get children() {
                return createComponent(Panel, {})
              },
            }),
          ]
        },
      }),
    host,
  )

  await tick()
  expect(appCrashed).toBe(false)
  expect(host.textContent).toContain("rest of the app")
  expect(host.textContent).toContain("couldn't reach the local IRIS server")
  expect(host.textContent).toContain("Failed to fetch")

  // Retry remounts the panel, which fetches again and recovers.
  ;(host.querySelector('[data-slot="iris-panel-retry"]') as HTMLButtonElement).click()
  await tick()
  expect(host.textContent).toContain("rooms loaded")
  expect(host.querySelector('[data-slot="iris-panel-error"]')).toBeNull()

  dispose()
  host.remove()
})

// Clicking a product tab blanked the whole side panel to black until the new pane's fetch
// returned: the pane's loading read suspended the fallback-less <Suspense> in session.tsx that
// wraps the entire panel. A load must stop at the IRIS panel, with the tab strip still drawn.
test("a pane that is still loading does not blank the side panel around it", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  let finish!: (v: string) => void

  const Panel = () => {
    const [data] = createResource(() => new Promise<string>((r) => (finish = r)))
    const el = document.createElement("span")
    createRenderEffect(() => (el.textContent = data() ?? ""))
    return el
  }

  const dispose = render(
    () =>
      // session.tsx: <Suspense> with no fallback around SessionSidePanel.
      createComponent(Suspense, {
        get children() {
          return [
            "tab strip",
            createComponent(IrisPanelBoundary, {
              get children() {
                return createComponent(Panel, {})
              },
            }),
          ]
        },
      }),
    host,
  )

  await tick()
  expect(host.textContent).toContain("tab strip")
  expect(host.querySelector('[data-slot="iris-panel-loading"]')).not.toBeNull()

  finish("rooms loaded")
  await tick()
  expect(host.textContent).toContain("tab strip")
  expect(host.textContent).toContain("rooms loaded")
  expect(host.querySelector('[data-slot="iris-panel-loading"]')).toBeNull()

  dispose()
  host.remove()
})
