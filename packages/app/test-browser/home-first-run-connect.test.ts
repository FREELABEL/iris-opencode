import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"

// First run › Connect: a connection waiting on the browser must not trap the person. They can
// switch to another integration or cancel, and a slow answer for the one they left never opens
// a browser page after they moved on. Compiled the way vite does — see hive-scripts-render.test.ts.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-first-run",
  setup(build) {
    build.onLoad({ filter: /home-first-run[^/]*\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /home-first-run\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

const opened: string[] = []
const calls: string[] = []
let slackDelay = 0
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ url: "http://sidecar" }) }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    openExternal: (u: string) => opened.push(u),
    fetch: async (url: string, init?: RequestInit) => {
      const path = url.replace("http://sidecar", "")
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push(`${init?.method ?? "GET"} ${path}${body?.type ? ` ${body.type}` : ""}`)
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
      if (path === "/iris/onboarding/state") return json({ signedIn: true, mail: { connected: false }, connected: [] })
      if (path.startsWith("/iris/catalog"))
        return json({ catalog: ["slack", "stripe", "notion"].map((t) => ({ type: t, name: t[0].toUpperCase() + t.slice(1), mode: "oauth" })) })
      if (path === "/iris/integrations/connect") {
        if (body.type === "slack" && slackDelay) await new Promise((r) => setTimeout(r, slackDelay))
        return json({ measured: true, url: `https://auth.example/${body.type}` })
      }
      return json({})
    },
  }),
}))
const { HomeFirstRun } = await import("../src/pages/home/home-first-run")

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}
function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(HomeFirstRun, { onStart: () => {}, onDone: () => {} }), host)
  const chip = (name: string) => [...host.querySelectorAll(".fr-int")].find((b) => b.textContent?.includes(name)) as HTMLButtonElement
  return { host, dispose, chip }
}

test("waiting on one integration, you can switch to another, or cancel", async () => {
  opened.length = 0
  const { host, dispose, chip } = mount()
  await wait(() => !!chip("Slack"))
  chip("Slack").click()
  await wait(() => chip("Slack").dataset.state === "waiting" && opened.length === 1)
  expect(opened).toEqual(["https://auth.example/slack"])
  // the others stay choosable while Slack waits
  expect(chip("Stripe").disabled).toBe(false)
  expect([...host.querySelectorAll(".fr-tile")].every((t) => !(t as HTMLButtonElement).disabled)).toBe(true)

  chip("Stripe").click()
  await wait(() => chip("Stripe").dataset.state === "waiting" && opened.length === 2)
  expect(chip("Slack").dataset.state).toBe("idle-other")
  expect(opened[1]).toBe("https://auth.example/stripe")

  // Cancel, next to "Open it again"
  const cancel = [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel") as HTMLButtonElement
  cancel.click()
  await wait(() => !host.querySelector('.fr-int[data-state="waiting"]'))
  expect(host.textContent).not.toContain("Approve IRIS in your browser")
  expect(chip("Notion").dataset.state).toBe("idle")

  // clicking the waiting one again also cancels it
  chip("Notion").click()
  await wait(() => chip("Notion").dataset.state === "waiting")
  chip("Notion").click()
  await wait(() => chip("Notion").dataset.state === "idle")
  dispose()
  host.remove()
})

test("a slow answer for the one you left never opens its browser page", async () => {
  opened.length = 0
  slackDelay = 300
  const { host, dispose, chip } = mount()
  await wait(() => !!chip("Slack"))
  chip("Slack").click()
  chip("Stripe").click()
  await wait(() => opened.includes("https://auth.example/stripe"))
  await new Promise((r) => setTimeout(r, 450))
  expect(opened).toEqual(["https://auth.example/stripe"])
  expect(chip("Stripe").dataset.state).toBe("waiting")
  slackDelay = 0
  dispose()
  host.remove()
})
