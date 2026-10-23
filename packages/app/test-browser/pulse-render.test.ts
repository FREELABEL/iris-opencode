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
// The finished route's stops — not the "reading…" placeholders drawn while it runs.
const R = ".pls-route:not(.pls-route--running) .pls-stop"

function mount(which: "topic" | "contact", delay = 0, stream?: ReadableStream<Uint8Array>) {
  const calls: Array<{ path: string; method: string }> = []
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" })
    // The streamed route (#189319): served when the test supplies a stream, else 404 like an
    // older sidecar — which must fall back to the one-shot route.
    if (path.startsWith("/iris/pulse/topic/stream")) {
      if (!stream) return new Response("not found", { status: 404 })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    }
    if (delay) await new Promise((r) => setTimeout(r, delay))
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
  await wait(() => host.querySelectorAll(R).length > 0)

  const stops = [...host.querySelectorAll(R)]
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
  await wait(() => host.querySelectorAll(R).length > 0)

  expect(host.querySelector(".pls-lead b")?.textContent).toBe("Injury law client")
  expect(host.querySelector(".pls-score")?.textContent).toBe("43")
  expect(host.querySelector(".pls-blind")?.textContent).toBe("partial read — 4 of 5 channels blind")
  const deal = [...host.querySelectorAll(R)].find((s) => s.querySelector("h4")?.textContent === "Deal")!
  expect(deal.querySelector(".pls-main")?.textContent).toBe("$9,950")
  expect(deal.getAttribute("data-tone")).toBe("wait")
  // the detail opens on the first stop with something owed
  expect(host.querySelector(".pls-detail .hmc-dname")?.textContent).toContain("Deal")
  const meetings = [...host.querySelectorAll(R)].find((s) => s.querySelector("h4")?.textContent === "Meetings")!
  expect(meetings.querySelector(".pls-main")?.textContent).toBe("shut")
  expect(meetings.textContent).toContain("not “no meetings”")
  expect(host.querySelector(".pls-owed li")?.textContent).toContain("Signed contract + first payment")
  expect(calls.every((c) => c.method === "GET")).toBe(true)
  dispose()
  host.remove()
})

test("Pulse › older sidecar (no stream): one-shot route, every stop reading at once, a clock, no number before it exists", async () => {
  const { host, dispose } = mount("topic", 400)
  ;(host.querySelector(".pls-query button[type=submit]") as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".pls-route--running .pls-stop.pls-stop--reading").length === 9)
  const reading = [...host.querySelectorAll(".pls-route--running .pls-stop")]
  expect(reading.map((s) => s.querySelector("h4")?.textContent)).toEqual([
    "Commits", "Diary", "Files", "Claude Code sessions", "opencode sessions", "iMessage", "Apple Mail", "Gmail", "Atlas",
  ])
  expect(reading.every((s) => s.querySelector(".pls-body p")?.textContent === "reading…")).toBe(true)
  expect(host.querySelector(".pls-route--running .pls-main")).toBeNull()
  expect(host.querySelector(".pls-clock")?.textContent).toMatch(/^\d+\.\d s$/)
  // and the placeholder gives way to the real route
  await wait(() => host.querySelectorAll(R).length > 0)
  expect(host.querySelector(".pls-route--running")).toBeNull()
  dispose()
  host.remove()
})

test("Pulse › streamed: the stop being read pulses, landed stops show their count, the rest wait", async () => {
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) })
  const send = (event: string, data: unknown) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  const { host, dispose } = mount("topic", 0, stream)
  ;(host.querySelector(".pls-query button[type=submit]") as HTMLButtonElement).click()
  const row = (label: string) => [...host.querySelectorAll(".pls-route--running .pls-stop")].find((s) => s.querySelector("h4")?.textContent === label)!

  send("start", { source: "git", label: "Commits" })
  await wait(() => !!row("Commits")?.classList.contains("pls-stop--reading"))
  expect(row("Diary").classList.contains("pls-stop--waiting")).toBe(true)
  expect(row("Diary").querySelector(".pls-body p")?.textContent).toBe("next")
  expect(row("Commits").querySelector(".pls-main")).toBeNull()

  const git = fixture.topic.data.stops.find((s: any) => s.id === "git")
  send("stop", { stop: git })
  send("start", { source: "diary", label: "Diary" })
  await wait(() => !!row("Diary")?.classList.contains("pls-stop--reading"))
  expect(row("Commits").classList.contains("pls-stop--read")).toBe(true)
  expect(row("Commits").querySelector(".pls-main")?.textContent).toBe(String(git.count))
  expect(host.querySelector(".pls-checking")?.textContent).toContain("1 of 9 stops read")
  // a shut stop that lands says shut — never 0
  const shut = fixture.topic.data.stops.find((s: any) => s.shut)
  send("stop", { stop: shut })
  await wait(() => !!row(shut.label)?.classList.contains("pls-stop--read"))
  expect(row(shut.label).querySelector(".pls-body p")?.textContent).toBe("shut")
  expect(row(shut.label).querySelector(".pls-main")?.textContent).toBe("shut")

  send("done", fixture.topic)
  ctl.close()
  await wait(() => host.querySelectorAll(R).length > 0)
  expect(host.querySelector(".pls-route--running")).toBeNull()
  expect(host.querySelectorAll(R).length).toBe(9)
  dispose()
  host.remove()
})

test("Pulse › Run again re-reads the same route; a failed route offers Try again", async () => {
  const { host, dispose, calls } = mount("contact")
  await wait(() => host.querySelectorAll(R).length > 0)
  const reads = () => calls.filter((c) => c.path.startsWith("/iris/pulse/contacts/4242")).length
  expect(reads()).toBe(1)
  const btn = host.querySelector(".pls-lead .pls-again-btn") as HTMLButtonElement
  expect(btn.getAttribute("aria-label")).toBe("Run again")
  expect(host.querySelector(".pls-lead .pls-ago")?.textContent).toBe("just now")
  // the line is chips, not a sentence of metadata
  expect(host.querySelector(".pls-lead .hsc-muted")).toBeNull()
  btn.click()
  await wait(() => reads() === 2)
  await wait(() => host.querySelectorAll(R).length > 0)
  expect(calls.every((c) => c.method === "GET")).toBe(true)
  dispose()
  host.remove()

  // a route that fails says why, and offers to try again
  let fail = true
  const host2 = document.createElement("div")
  document.body.append(host2)
  const doFetch = async (path: string) => {
    if (path.startsWith("/iris/pulse/topic/stream")) return new Response("nf", { status: 404 })
    if (fail) return new Response(JSON.stringify({ measured: false, reason: "the route did not finish: boom", data: null }), { headers: { "Content-Type": "application/json" } })
    return new Response(JSON.stringify(fixture.topic), { headers: { "Content-Type": "application/json" } })
  }
  const d2 = render(() => createComponent(IrisPulseTopic as any, { doFetch, now: () => NOW }), host2)
  ;(host2.querySelector(".pls-query button[type=submit]") as HTMLButtonElement).click()
  await wait(() => !!host2.querySelector(".pls-err"))
  expect(host2.querySelector(".pls-err")?.textContent).toContain("boom")
  fail = false
  ;(host2.querySelector(".pls-err .pls-retry") as HTMLButtonElement).click()
  await wait(() => host2.querySelectorAll(R).length > 0)
  expect(host2.querySelector(".pls-sum .pls-again-btn")?.getAttribute("aria-label")).toBe("Run again")
  d2()
  host2.remove()
})
