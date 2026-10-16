import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import snap from "../src/components/session/__fixtures__/hive-scripts.json"

// Hive › Scripts (#188817), rendered over a REAL snapshot of account #193 on 2026-10-09: 27
// scripts with their doctor verdicts, 6 node records, and the real run of console-demo on
// iris-hive-001. Compiled the way vite does (babel-preset-solid) — see iris-panel-boundary.test.ts.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-hive-scripts",
  setup(build) {
    build.onLoad({ filter: /iris-hive-scripts\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-hive-scripts\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})
mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props: any) => {
    const el = document.createElement("div")
    el.setAttribute("data-component", "icon")
    el.setAttribute("data-name", props.name)
    return el
  },
}))
const { IrisHiveScripts } = await import("../src/components/session/iris-hive-scripts")

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the panel")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const NOW = Date.parse("2026-10-09T21:20:00Z")

const MARKET = [
  { slug: "deal-scenarios", name: "Deal Scenarios", author: "FREELABEL", version: 2, requires: [] },
  { slug: "csv-tidy", name: "CSV Tidy", author: "FREELABEL", version: 2, requires: [] },
]
function mount(opts: { empty?: boolean; bloqId?: number; tagged?: string[] } = {}) {
  const calls: { path: string; method: string; body?: any }[] = []
  let polled = 0
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path === "/iris/hive/scripts")
      return json({
        measured: true,
        scripts: opts.empty ? [] : snap.scripts.map((s: any) => ({ ...s, tags: (opts.tagged ?? []).includes(s.slug) ? ["ops", "project:7"] : ["ops"] })),
        account: opts.empty ? 2945 : 193,
      })
    if (path === "/iris/hive/market") return json({ measured: true, scripts: MARKET })
    if (path.endsWith("/install")) return json({ ok: true, sha256: "z", assetsLeft: 1 })
    if (path.endsWith("/tags")) return json({ ok: true, sha256: "x" })
    if (path.startsWith("/iris/hive/market/"))
      return json({
        measured: true,
        script: { ...MARKET.find((m) => path.endsWith(m.slug))!, runtime: "bash", content: "#!/bin/bash\n# iris: timeout=30\necho public\n", timeout: 30, assets: 1, checks: [{ title: "Network denied", status: "pass" }, { title: "Builds commands at runtime", status: "flag" }] },
      })
    if (path.startsWith("/iris/hive?")) return json({ measured: true, nodes: opts.empty ? [] : snap.nodes })
    if (path === "/iris/hive/scripts/console-demo") return json({ measured: true, script: { ...snap.source, sha256: "x" } })
    if (path.startsWith("/iris/hive/scripts/") && init?.method !== "POST")
      return json({ measured: true, script: { slug: path.split("/").pop(), runtime: "bash", content: "#!/bin/bash\necho hi\n", sha256: "y" } })
    if (path.endsWith("/run")) return json({ ok: true, taskId: snap.task.id, nodeName: "iris-hive-001" })
    if (path.startsWith("/iris/hive/tasks/")) {
      polled++
      // first poll: mid-run (the real timestamps, minus completion); then the real finished task
      const task = polled === 1 ? { ...snap.task, status: "running", terminal: false, completedAt: null, stdout: "", exitCode: null } : snap.task
      return json({ measured: true, task })
    }
    return json({ ok: false, reason: "unexpected " + path })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHiveScripts, { doFetch, now: () => NOW, bloqId: opts.bloqId, bloqName: opts.bloqId ? "Deals board" : undefined }), host)
  return { host, calls, dispose }
}

test("Scripts tab: list, computers and the one fix, from the real snapshot", async () => {
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0 && host.querySelectorAll(".hsc-cc").length > 0)

  const rows = [...host.querySelectorAll(".hsc-ilist li")]
  // 17 real scripts; the Hive's own 10 test scripts are behind a count
  expect(rows.length).toBe(17)
  expect(rows.some((r) => r.textContent === "e2e-fda")).toBe(false)
  expect(host.querySelector(".hsc-more")?.textContent).toBe("+10 tests")
  // blocked scripts carry a lock; ready ones do not
  const blocked = rows.filter((r) => r.classList.contains("bl"))
  expect(blocked.length).toBeGreaterThan(0)
  expect(blocked.every((r) => r.querySelector('[data-name="lock"]'))).toBe(true)
  expect(rows.find((r) => r.textContent?.startsWith("node-health"))?.classList.contains("bl")).toBe(false)

  // two online computers; the MacBook is ONE card with ×3 and a critical disk
  const cards = [...host.querySelectorAll(".hsc-cc")]
  expect(cards.length).toBe(2)
  const mac = cards.find((c) => c.textContent?.includes("Alexs-MacBook-Pro-11711"))!
  expect(mac.querySelector(".hsc-x")?.textContent).toBe("×3")
  expect(mac.querySelector(".hsc-dk")?.textContent).toBe("2.1 GB")
  expect(mac.querySelectorAll(".hsc-skill").length).toBeLessThanOrEqual(3)
  expect(host.querySelector(".hsc-offrow")?.textContent).toBe("2 offline")
  expect(host.querySelector(".hsc-fixrow")?.textContent).toContain("6 scripts wait on one fix")
  expect(host.querySelector(".hsc-fixrow")?.getAttribute("title")).toContain("restart its Hive daemon")

  // tests can be shown — 27 is more than a page, so the list pages
  ;(host.querySelector(".hsc-more") as HTMLButtonElement).click()
  await wait(() => host.querySelector(".hsc-pager") !== null)
  expect(host.querySelectorAll(".hsc-ilist li").length).toBe(25)
  expect(host.querySelector(".hsc-pager .hsc-num")?.textContent).toBe("1–25 of 27")
  ;(host.querySelector('.hsc-pager [aria-label="Next page"]') as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length === 2)
  expect(host.querySelector(".hsc-pager .hsc-num")?.textContent).toBe("26–27 of 27")
  dispose()
  host.remove()
})

test("⌘K runs console-demo on iris-hive-001: stages, output, and the card that ran it", async () => {
  const { host, calls, dispose } = mount()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0 && host.querySelectorAll(".hsc-cc").length > 0)

  const input = host.querySelector(".hsc-cmdk input") as HTMLInputElement
  input.value = "run console-demo seconds=20 on iris-hive-001"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector(".hsc-cmdk")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))

  await wait(() => calls.some((c) => c.path.endsWith("/run")))
  const runCall = calls.find((c) => c.path.endsWith("/run"))!
  expect(runCall.path).toBe("/iris/hive/scripts/console-demo/run")
  // sent to the node it named, the timeout from the header — and NO arguments: the daemon drops them
  expect(runCall.body.node).toBe(snap.nodes.find((n: any) => n.name === "iris-hive-001" && n.online)!.id)
  expect(runCall.body.timeout).toBe(120)
  expect("args" in runCall.body).toBe(false)

  await wait(() => host.querySelector(".hsc-track") !== null)
  // the edit/run toggle moved to Run
  expect(host.querySelector(".hsc")?.getAttribute("data-mode")).toBe("run")
  // the arguments typed are SAID to be dropped, not silently dropped
  await wait(() => host.querySelector(".hsc-term")?.textContent?.includes("not delivered") ?? false)

  // polled to completion: five stages done, the real output, exit 0
  await wait(() => host.querySelector(".hsc-term")?.textContent?.includes("console demo done") ?? false, 5000)
  const states = [...host.querySelectorAll(".hsc-track li")].map((li) => li.getAttribute("data-state"))
  expect(states).toEqual(["done", "done", "done", "done", "done"])
  expect(host.querySelector(".hsc-rstat")?.textContent).toBe("Done · exit 0")
  expect(host.querySelector(".hsc-term")?.textContent).toContain("console demo starting on ca93b63ecc77")
  // no running-line highlight is invented
  expect(host.querySelector(".hsc-code--view li.now")).toBeNull()

  const ran = [...host.querySelectorAll(".hsc-cc")].find((c) => c.textContent?.includes("iris-hive-001"))!
  expect(ran.querySelector(".hsc-cctag")?.textContent).toBe("Ran here")
  expect(ran.querySelector(".hsc-dlog")?.textContent).toBe("console demo done")
  expect(host.querySelector(".hsc-where h5")?.textContent).toBe("Sent to")

  // Edit: the header's arg is an input box with its declared default; the timeout is a chip
  ;(host.querySelector('.hsc-seg button[title="Edit"]') as HTMLButtonElement).click()
  await wait(() => host.querySelector(".hsc-arg input") !== null)
  expect((host.querySelector(".hsc-arg input") as HTMLInputElement).value).toBe("20")
  expect(host.querySelector(".hsc-arg span")?.textContent).toBe("seconds")
  expect(host.querySelector(".hsc-argrow .hsc-chip")?.textContent).toBe("120s")
  expect((host.querySelector(".hsc-code--edit textarea") as HTMLTextAreaElement).value).toBe(snap.source.content)
  dispose()
  host.remove()
})

test("the script list folds to a rail, resizes from its edge, and remembers both", async () => {
  localStorage.removeItem("iris.hive.scripts.list")
  let { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0)
  const pane = () => host.querySelector(".hsc") as HTMLElement
  const grip = () => host.querySelector(".hsc-grip") as HTMLElement
  expect(pane().style.getPropertyValue("--hsc-lw")).toBe("196px")

  // fold: the rows go, the rail keeps the fold and + buttons
  ;(host.querySelector(".hsc-fold") as HTMLButtonElement).click()
  await wait(() => pane().classList.contains("hsc--closed"))
  expect(host.querySelector(".hsc-ilist")).toBeNull()
  expect(pane().style.getPropertyValue("--hsc-lw")).toBe("40px")
  expect(host.querySelector(".hsc-fold")?.getAttribute("aria-expanded")).toBe("false")

  // the keyboard on the edge: → opens, then widens; ← narrows
  const key = (k: string, shiftKey = false) => grip().dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }))
  key("ArrowRight")
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0)
  key("ArrowRight", true)
  expect(pane().style.getPropertyValue("--hsc-lw")).toBe("236px")
  expect(grip().getAttribute("aria-valuenow")).toBe("236")
  key("ArrowLeft")
  expect(pane().style.getPropertyValue("--hsc-lw")).toBe("226px")
  dispose()
  host.remove()

  // a fresh mount comes back at the same width
  ;({ host, dispose } = mount())
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0)
  expect(pane().style.getPropertyValue("--hsc-lw")).toBe("226px")
  // double-clicking the edge folds it, and that is remembered too
  grip().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
  await wait(() => pane().classList.contains("hsc--closed"))
  dispose()
  host.remove()
  ;({ host, dispose } = mount())
  await wait(() => host.querySelector(".hsc-fold") !== null)
  expect(pane().classList.contains("hsc--closed")).toBe(true)
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.scripts.list")
})

test("an account with nothing says so, and an unsaved script lights Save", async () => {
  let { host, dispose } = mount({ empty: true })
  await wait(() => !!host.querySelector(".hsc-empty"))
  expect(host.querySelector(".hsc-acct")?.textContent).toBe("#2945")
  expect(host.querySelector(".hsc-list")?.textContent).toContain("No scripts on account 2945")
  expect(host.querySelector(".hsc-empty")?.textContent).toContain("No computers on account 2945")
  dispose()
  host.remove()

  localStorage.setItem("iris.hive.scripts.slug", "console-demo")
  ;({ host, dispose } = mount())
  const ta = () => host.querySelector('textarea[aria-label="Script source"]') as HTMLTextAreaElement | null
  await wait(() => !!ta()?.value)
  const save = host.querySelector(".hsc-save") as HTMLButtonElement
  expect(save.classList.contains("hsc-save--due")).toBe(false)
  expect(save.disabled).toBe(true)
  ta()!.value += "echo more\n"
  ta()!.dispatchEvent(new Event("input", { bubbles: true }))
  await wait(() => save.classList.contains("hsc-save--due"))
  expect(save.disabled).toBe(false)
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.scripts.slug")
})

test("All · Project · Marketplace: a board's scripts, pinning, and adding a public one", async () => {
  localStorage.removeItem("iris.hive.scripts.view")
  localStorage.setItem("iris.hive.scripts.slug", "node-health")
  const { host, calls, dispose } = mount({ bloqId: 7, tagged: ["deal-scenarios"] })
  const rows = () => [...host.querySelectorAll(".hsc-list .hsc-ilist li")].map((l) => l.querySelector(".hsc-mono")?.textContent)
  const tab = (w: string) => [...host.querySelectorAll(".hsc-views button")].find((b) => b.textContent === w) as HTMLButtonElement
  await wait(() => rows().length > 0)
  expect([...host.querySelectorAll(".hsc-views button")].map((b) => b.textContent)).toEqual(["All", "Project", "Marketplace"])
  expect(tab("All").getAttribute("aria-selected")).toBe("true")
  expect(rows().length).toBe(17)
  // the board's script carries a pin in All
  expect(host.querySelector('.hsc-ilist li [title="In Deals board"]')).not.toBeNull()

  // Project: exactly what the board claimed, and it opens one of them
  tab("Project").click()
  await wait(() => rows().length === 1)
  expect(rows()).toEqual(["deal-scenarios"])
  await wait(() => host.querySelector(".hsc-file")?.textContent === "deal-scenarios.sh")
  expect(localStorage.getItem("iris.hive.scripts.view")).toBe("project")

  // pinning: the button is on, and pressing it sends the tags WITHOUT the board's, keeping the rest
  const pin = () => host.querySelector('.hsc-pin') as HTMLButtonElement
  await wait(() => pin()?.getAttribute("aria-pressed") === "true")
  pin().click()
  await wait(() => calls.some((c) => c.path.endsWith("/tags")))
  const t = calls.find((c) => c.path.endsWith("/tags"))!
  expect(t.path).toBe("/iris/hive/scripts/deal-scenarios/tags")
  expect(t.body).toEqual({ tags: ["ops"] })

  // Marketplace: public scripts, read-only, one already mine
  tab("Marketplace").click()
  await wait(() => rows().length === 2 && !!host.querySelector(".hsc-code--view"))
  expect(rows()[0]).toBe("deal-scenarios")
  expect(host.querySelector(".hsc-list .hsc-ilist li [title='Already in your scripts']")).not.toBeNull()
  expect(host.querySelector("textarea")).toBeNull()
  expect(host.querySelector(".hsc-edbar .hsc-run")?.textContent).toContain("Open mine")
  // one I do not have: Add to my scripts
  ;(host.querySelectorAll(".hsc-list .hsc-ilist li")[1] as HTMLElement).click()
  await wait(() => !!host.querySelector(".hsc-run--add"))
  expect(host.querySelector(".hsc-ed")?.textContent).toContain("Builds commands at runtime")
  expect(host.querySelector(".hsc-ed")?.textContent).toContain("1 attached file")
  ;(host.querySelector(".hsc-run--add") as HTMLButtonElement).click()
  await wait(() => calls.some((c) => c.path === "/iris/hive/market/csv-tidy/install"))
  await wait(() => tab("All").getAttribute("aria-selected") === "true")
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.scripts.view")
  localStorage.removeItem("iris.hive.scripts.slug")
})

test("Project with no board asks for one", async () => {
  localStorage.setItem("iris.hive.scripts.view", "project")
  const { host, dispose } = mount()
  await wait(() => !!host.querySelector(".hsc-list .hsc-empty"))
  expect(host.querySelector(".hsc-list .hsc-empty")?.textContent).toBe("Pick a board to see the scripts it uses.")
  expect(host.querySelector('.hsc-pin')).toBeNull()
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.scripts.view")
})

test("search finds a script by any word, last-edited orders the list, and A–Z is remembered", async () => {
  localStorage.removeItem("iris.hive.scripts.sort")
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0)
  const rows = () => [...host.querySelectorAll(".hsc-list .hsc-ilist li")].map((l) => l.querySelector(".hsc-mono")?.textContent)
  const ages = () => [...host.querySelectorAll(".hsc-list .hsc-ilist li time")].map((t) => t.getAttribute("datetime"))

  // newest edit first, and every row says how long ago
  const when = ages().filter(Boolean).map((d) => Date.parse(d!))
  expect(when.length).toBeGreaterThan(5)
  expect(when).toEqual([...when].sort((a, b) => b - a))
  expect(host.querySelector(".hsc-ilist li time")?.textContent).toMatch(/^(now|\d+[mhdwy])$/)

  // words in any order, hyphen or not; Enter opens the first hit
  const box = host.querySelector('.hsc-find input[type="search"]') as HTMLInputElement
  box.value = "scen deal"
  box.dispatchEvent(new Event("input", { bubbles: true }))
  await wait(() => rows().length === 1)
  expect(rows()).toEqual(["deal-scenarios"])
  // a test script is found by name even though the list hides them
  box.value = "e2e fda"
  box.dispatchEvent(new Event("input", { bubbles: true }))
  await wait(() => rows().length === 1 && rows()[0] === "e2e-fda")
  box.value = "zzz-nothing"
  box.dispatchEvent(new Event("input", { bubbles: true }))
  await wait(() => rows().length === 0)
  expect(host.querySelector(".hsc-list")?.textContent).toContain("Nothing matches")
  ;(host.querySelector('.hsc-find [aria-label="Clear search"]') as HTMLButtonElement).click()
  await wait(() => rows().length === 17)

  // A–Z, remembered
  ;(host.querySelector(".hsc-sort") as HTMLButtonElement).click()
  await wait(() => rows()[0] === [...rows()].sort()[0] && host.querySelector(".hsc-sort")?.textContent === "A–Z")
  expect(rows()).toEqual([...rows()].sort())
  expect(localStorage.getItem("iris.hive.scripts.sort")).toBe("name")
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.scripts.sort")
})

// #189589 follow-ups, rendered: "it doesn't tell me why" and "flat and not scannable".
test("a machine that cannot run the script says why on its card, and the code is coloured", async () => {
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0 && host.querySelectorAll(".hsc-cc").length > 0)
  const input = host.querySelector(".hsc-cmdk input") as HTMLInputElement
  input.value = "run console-demo on iris-hive-001"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector(".hsc-cmdk")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await wait(() => host.querySelectorAll(".hsc-code--view li").length > 0)

  const blocked = [...host.querySelectorAll(".hsc-cc.no")]
  if (blocked.length) {
    // the reason is TEXT on the card, not only a hover
    expect(blocked.every((c) => (c.querySelector('[data-action="hive-cant-run-why"]')?.textContent ?? "").length > 0)).toBe(true)
  }
  const spans = [...host.querySelectorAll(".hsc-code--view [class^='hl-']")]
  expect(spans.length).toBeGreaterThan(0)
  // the header lines that decide routing get their own colour
  expect(spans.some((s) => s.className === "hl-dir" && s.textContent?.includes("iris:"))).toBe(true)
  dispose()
  host.remove()
})

test("a running run has a Stop button that cancels it on the hub", async () => {
  const { host, calls, dispose } = mount()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length > 0 && host.querySelectorAll(".hsc-cc").length > 0)
  const input = host.querySelector(".hsc-cmdk input") as HTMLInputElement
  input.value = "run console-demo on iris-hive-001"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector(".hsc-cmdk")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))

  // first poll answers "running" — Stop must be there
  await wait(() => host.querySelector('[data-action="hive-stop"]') !== null)
  ;(host.querySelector('[data-action="hive-stop"]') as HTMLButtonElement).click()
  await wait(() => calls.some((c) => c.method === "POST" && c.path.endsWith("/cancel")))
  expect(calls.find((c) => c.path.endsWith("/cancel"))!.path).toMatch(/^\/iris\/hive\/tasks\/[^/]+\/cancel$/)
  await wait(() => (host.querySelector(".hsc-term")?.textContent ?? "").includes("Stopped"))
  dispose()
  host.remove()
})
