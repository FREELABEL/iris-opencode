import { plugin } from "bun"
import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import fixture from "../preview/pulse-fixture.json"

// Pulse (#189286) over a fixture captured from the real sidecar on 2026-10-13 (names replaced).
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-pulse",
  setup(build) {
    build.onLoad({ filter: /iris-pulse\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-(hive-scripts|hive-machines|pulse)\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})
const { IrisPulseContact, IrisPulseTopic } = await import("../src/components/session/iris-pulse")

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the panel")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const NOW = Date.parse("2026-10-13T06:30:00Z")

function mount(which: "topic" | "contact") {
  const calls: Array<{ path: string; method: string }> = []
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path.startsWith("/iris/pulse/topic")) return json(fixture.topic)
    if (path.startsWith("/iris/pulse/contacts/")) return json(fixture.contact)
    if (path.startsWith("/iris/pulse/contacts")) return json({ measured: true, data: [fixture.contact.data.lead] })
    return json({ measured: false, reason: "unexpected " + path, data: null })
  }
  localStorage.setItem("iris.pulse.contact", "4242")
  localStorage.setItem("iris.pulse.topic", "heartbeat")
  const host = document.createElement("div")
  document.body.append(host)
  const C = which === "topic" ? IrisPulseTopic : IrisPulseContact
  const dispose = render(() => createComponent(C as any, { doFetch, now: () => NOW }), host)
  return { host, dispose, calls }
}

test("Pulse › Topic: nothing runs until asked; then the route, with shut stops shut — never 0", async () => {
  const { host, dispose, calls } = mount("topic")
  await new Promise((r) => setTimeout(r, 30))
  expect(calls.length).toBe(0)
  ;(host.querySelector(".pls-query button[type=submit]") as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".pls-stop").length > 0)

  const stops = [...host.querySelectorAll(".pls-stop")]
  expect(stops.length).toBe(9)
  const shut = stops.filter((s) => s.hasAttribute("data-shut"))
  expect(shut.map((s) => s.querySelector("h4")?.textContent)).toEqual(["iMessage", "Apple Mail", "Gmail"])
  for (const s of shut) {
    expect(s.querySelector(".pls-main")?.textContent).toBe("shut")
    expect(s.querySelector(".pls-pin")?.textContent).toBe("×")
  }
  // visited stops are numbered in order; shut ones do not take a number
  expect(stops.map((s) => s.querySelector(".pls-pin")?.textContent)).toEqual(["1", "2", "3", "4", "5", "×", "×", "×", "6"])
  // a capped count reads as a floor
  expect(stops[8].querySelector(".pls-main")?.textContent).toBe("64+")
  expect(host.querySelector(".pls-sum")?.textContent).toContain("hits at 5 of 6 reachable stops")
  // opening never writes
  expect(calls.every((c) => c.method === "GET")).toBe(true)
  dispose()
  host.remove()
})

test("Pulse › Contact: the score, what is owed, and every unread channel shut", async () => {
  const { host, dispose, calls } = mount("contact")
  await wait(() => host.querySelectorAll(".pls-stop").length > 0)

  expect(host.querySelector(".pls-lead b")?.textContent).toBe("Injury law client")
  expect(host.querySelector(".pls-score")?.textContent).toBe("43")
  expect(host.querySelector(".pls-blind")?.textContent).toBe("partial read — 4 of 5 channels blind")
  const deal = [...host.querySelectorAll(".pls-stop")].find((s) => s.querySelector("h4")?.textContent === "Deal")!
  expect(deal.querySelector(".pls-main")?.textContent).toBe("$9,950")
  expect(deal.getAttribute("data-tone")).toBe("wait")
  // the detail opens on the first stop with something owed
  expect(host.querySelector(".pls-detail .hmc-dname")?.textContent).toContain("Deal")
  const meetings = [...host.querySelectorAll(".pls-stop")].find((s) => s.querySelector("h4")?.textContent === "Meetings")!
  expect(meetings.querySelector(".pls-main")?.textContent).toBe("shut")
  expect(meetings.textContent).toContain("not “no meetings”")
  expect(host.querySelector(".pls-owed li")?.textContent).toContain("Signed contract + first payment")
  expect(calls.every((c) => c.method === "GET")).toBe(true)
  dispose()
  host.remove()
})
