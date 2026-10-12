import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import snap from "../src/components/session/__fixtures__/hive-scripts.json"

// Hive › Machines over the REAL fleet snapshot of account #193 (6 registrations, 4 computers).
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-hive-machines",
  setup(build) {
    build.onLoad({ filter: /iris-hive-machines\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-hive-(scripts|machines)\.css$/ }, () => ({ contents: "", loader: "js" }))
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
const { IrisHiveMachines } = await import("../src/components/session/iris-hive-machines")
const nav = await import("../src/components/session/iris-nav")

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the panel")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const NOW = Date.parse("2026-10-09T21:20:00Z")
const PEERS = [
  { id: "1", name: "Emily Glynn", status: "accepted", active: true, inviter: true },
  { id: "2", name: "kmontero", status: "pending", active: false, inviter: true, inviteCode: "ABC" },
]

function mount(opts: { empty?: boolean } = {}) {
  const doFetch = async (path: string) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path.startsWith("/iris/hive/peers")) return json({ measured: true, peers: PEERS })
    if (path.startsWith("/iris/hive?")) return json({ measured: true, nodes: opts.empty ? [] : snap.nodes })
    return json({ measured: false, reason: "unexpected " + path })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHiveMachines, { doFetch, now: () => NOW }), host)
  return { host, dispose }
}

test("Machines: triage on top, one card per computer, problems on the computer, detail beside", async () => {
  localStorage.removeItem("iris.hive.machines.view")
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hmc-card").length > 0)
  if (process.env.HMC_DUMP) (await import("node:fs")).writeFileSync(process.env.HMC_DUMP + "/list.html", host.innerHTML)

  expect(host.querySelector(".hmc-sum")?.textContent).toBe("2 of 4 computers online2 need attention")
  const cards = [...host.querySelectorAll(".hmc-card")]
  expect(cards.length).toBe(4)
  const mac = cards.find((c) => c.querySelector(".hmc-name")?.textContent === "Alexs-MacBook-Pro-11711")!
  expect(mac.querySelector(".hmc-x")?.textContent).toBe("×3")
  expect(mac.querySelector(".hmc-done")?.textContent).toBe("1,226 done")
  expect(mac.querySelector(".hmc-status")?.textContent).toBe("Free — can take 3 tasks")
  expect(mac.querySelector(".hmc-chip")?.textContent).toBe("Disk almost full — 2.1 GB free")
  const qb = cards.find((c) => c.textContent?.includes("qb-host-vanguard"))!
  expect(qb.classList.contains("off")).toBe(true)
  expect(qb.querySelector(".hmc-status")?.textContent).toBe("Away since 3 days ago")
  expect(qb.querySelector(".hmc-disk")?.textContent).toBe("disk not reported")

  // the detail opens on the first card, and follows a click
  expect(host.querySelector(".hmc-dname")?.textContent).toBe("Alexs-MacBook-Pro-11711")
  expect(host.querySelector(".hmc-spec")?.textContent).toBe("Mac · 10 cores · 16 GB memory")
  expect([...host.querySelectorAll(".hmc-att-list b")].map((b) => b.textContent)).toEqual([
    "Disk almost full — 2.1 GB free",
    "Registered 3 times — same computer",
  ])
  expect(host.querySelectorAll(".hmc-can li").length).toBeGreaterThan(4)

  // Send a task → Scripts, with this computer named
  ;(host.querySelector(".hmc-btn--go") as HTMLButtonElement).click()
  expect(nav.irisNavRequest()).toMatchObject({ surface: "hive", sub: "scripts" })
  expect(snap.nodes.map((n: any) => n.id)).toContain(nav.irisHiveNodeFocus()?.id)

  ;(qb as HTMLElement).click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent === "qb-host-vanguard")
  expect((host.querySelector(".hmc-btn--go") as HTMLButtonElement).disabled).toBe(true)
  dispose()
  host.remove()
})

test("Map: the same fleet as a network, with the people you share with, remembered", async () => {
  localStorage.removeItem("iris.hive.machines.view")
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hmc-card").length > 0)
  ;([...host.querySelectorAll(".hmc-seg button")].find((b) => b.textContent === "Map") as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".hmc-node").length > 0)
  if (process.env.HMC_DUMP) (await import("node:fs")).writeFileSync(process.env.HMC_DUMP + "/map.html", host.innerHTML)
  expect(host.querySelectorAll('.hmc-node[data-kind="computer"]').length).toBe(4)
  expect(host.querySelectorAll('.hmc-node[data-kind="peer"]').length).toBe(2)
  expect(host.querySelectorAll(".hmc-node[data-att]").length).toBe(2)
  expect(localStorage.getItem("iris.hive.machines.view")).toBe("map")
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.machines.view")
})

test("an account with no computers says how to add one", async () => {
  const { host, dispose } = mount({ empty: true })
  await wait(() => !!host.querySelector(".hmc-empty"))
  expect(host.querySelector(".hmc-empty")?.textContent).toContain("iris hive connect")
  expect(host.querySelector(".hmc-detail")).toBeNull()
  dispose()
  host.remove()
})
