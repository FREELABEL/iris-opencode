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

function mount() {
  const calls: { path: string; method: string; body?: any }[] = []
  let polled = 0
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path === "/iris/hive/scripts") return json({ measured: true, scripts: snap.scripts })
    if (path.startsWith("/iris/hive?")) return json({ measured: true, nodes: snap.nodes })
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
  const dispose = render(() => createComponent(IrisHiveScripts, { doFetch, now: () => NOW }), host)
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

  // tests can be shown
  ;(host.querySelector(".hsc-more") as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".hsc-ilist li").length === 27)
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
