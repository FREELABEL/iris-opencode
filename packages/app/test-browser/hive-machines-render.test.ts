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

function mount(opts: { empty?: boolean; nodes?: unknown[]; sessions?: unknown; here?: unknown } = {}) {
  const doFetch = async (path: string) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path.startsWith("/iris/hive/peers")) return json({ measured: true, peers: PEERS })
    if (path.startsWith("/iris/hive?")) return json({ measured: true, nodes: opts.empty ? [] : (opts.nodes ?? snap.nodes) })
    if (path === "/iris/hive/sessions" && opts.sessions) return json(opts.sessions)
    if (path === "/iris/hive/here" && opts.here) return json(opts.here)
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

// #192608 — Computers: how each is reached, agents vs shells per computer with totals, the filter.
const HUB = "01a10379-0c9f-73c5-bf83-157496a21589"
const ADDR: Record<string, object> = {
  "01a09d2c-2076-72e5-9292-7f69c00e8407": { tailscaleIp: "100.100.67.48", tailscaleIpAt: "2026-10-09T21:04:43Z", lastIp: "169.150.224.130" },
  [HUB]: { tailscaleIp: "100.79.222.57", tailscaleIpAt: "2026-10-09T21:04:36Z", lastIp: "169.150.224.129" },
  "019e1d80-a446-71fa-84a3-6269bf19fab0": { tailscaleIp: "100.114.214.29", tailscaleIpAt: "2026-10-09T20:00:00Z", lastIp: "89.222.103.194" },
}
const row = (id: string, status = "active") => ({ sessionId: id, provider: "claude_code", label: id, status, activity: null, model: null, branch: null, updatedAt: null, question: null })
const rec = (id: string, report: string, sessions: unknown[], incomplete: string[] = []) => ({
  id, name: id, online: true, lastHeartbeat: null, report, reportedAt: report === "never" ? null : "2026-10-09T21:15:00Z", incomplete, sessions,
})
const SESSIONS = {
  measured: true,
  nodes: [
    rec(HUB, "fresh", [row("a"), row("b", "idle"), row("c", "stale")]),
    rec("01a09d2c-2076-72e5-9292-7f69c00e8407", "fresh", [row("d"), row("e"), row("f", "needs_you"), row("g", "idle")]),
    rec("019e1d80-a446-71fa-84a3-6269bf19fab0", "stale", [row("h", "unknown")]),
    rec("01a097a9-3cab-73ef-92ee-e639c92e34b4", "never", []),
  ],
}
const HERE = { measured: true, nodeId: HUB, onTailnet: true, shells: { measured: true, workspaces: [{ panes: 3, kind: "swarm" }] } }
const withAddr = () => snap.nodes.map((n: any) => ({ ...n, ...ADDR[n.id] }))
const card = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll(".hmc-card")].find((c) => c.querySelector(".hmc-name")?.textContent === name) as HTMLElement

test("Computers: every machine says how it is reached and what runs on it; totals add up", async () => {
  localStorage.removeItem("iris.hive.machines.view")
  localStorage.removeItem("iris.hive.computers.filter")
  const { host, dispose } = mount({ nodes: withAddr(), sessions: SESSIONS, here: HERE })
  await wait(() => !!host.querySelector(".hmc-totals") && !!host.querySelector('.hmc-count[data-kind="shells"][data-counted]'))
  if (process.env.HMC_DUMP) (await import("node:fs")).writeFileSync(process.env.HMC_DUMP + "/computers.html", host.innerHTML)

  const reach = (n: string) => card(host, n).querySelector(".hmc-reach")?.textContent
  expect(reach("iris-hive-001")).toBe("This computer")
  expect(reach("Alexs-MacBook-Pro-11711")).toBe("Tailscale")
  expect(reach("AlexMaysnow1063")).toBe("Tailscale")
  expect(reach("qb-host-vanguard")).toBe("Unknown") // no address of any kind in the snapshot
  expect(card(host, "qb-host-vanguard").querySelector(".hmc-online")?.textContent).toBe("Offline")
  expect(card(host, "iris-hive-001").querySelector(".hmc-online")?.textContent).toBe("Online")

  const counts = (n: string) => [...card(host, n).querySelectorAll(".hmc-count")].map((c) => c.textContent)
  expect(counts("iris-hive-001")).toEqual(["2 agent sessions", "3 shells"])
  expect(counts("Alexs-MacBook-Pro-11711")).toEqual(["4 agent sessions", "Shells: not counted"])
  expect(counts("qb-host-vanguard")).toEqual(["Agents: never reported", "Shells: not counted"])
  expect(card(host, "iris-hive-001").querySelector('.hmc-count[data-kind="shells"]')?.getAttribute("title")).toBe("Hive-started only · 1 workspace")

  // totals: 2 + 4 + 1 agent sessions over the 3 computers that report them; shells from here only
  const totals = host.querySelector(".hmc-totals")!.textContent!
  expect(totals).toContain("7 agent sessions on 3 of 4 computers that report them")
  expect(totals).toContain("3 shells · this computer only, Hive-started only")

  // the detail says the same, in sentences
  ;(card(host, "Alexs-MacBook-Pro-11711") as HTMLElement).click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent === "Alexs-MacBook-Pro-11711")
  expect(host.querySelector(".hmc-reach-detail")?.textContent).toBe("TailscaleOver Tailscale at 100.100.67.48")
  expect([...host.querySelectorAll(".hmc-running dd")].map((d) => d.textContent)).toEqual([
    "4 agent sessions",
    "Shells: not counted",
    "Hive counts shells only on the computer you are using",
  ])
  dispose()
  host.remove()
})

test("Computers: All / Agents only / Shells only, remembered; unknown is never filtered as none", async () => {
  localStorage.removeItem("iris.hive.machines.view")
  localStorage.removeItem("iris.hive.computers.filter")
  const { host, dispose } = mount({ nodes: withAddr(), sessions: SESSIONS, here: HERE })
  await wait(() => !!host.querySelector('.hmc-count[data-kind="shells"][data-counted]'))
  const pick = (label: string) => ([...host.querySelectorAll(".hmc-filter button")].find((b) => b.textContent === label) as HTMLButtonElement).click()
  const names = () => [...host.querySelectorAll(".hmc-card .hmc-name")].map((n) => n.textContent)
  expect(names().length).toBe(4)

  pick("Agents only")
  await wait(() => names().length === 3)
  expect(names().sort()).toEqual(["AlexMaysnow1063", "Alexs-MacBook-Pro-11711", "iris-hive-001"])
  expect(host.querySelectorAll('.hmc-count[data-kind="shells"]').length).toBe(0)
  expect(host.querySelector(".hmc-filter-note")?.textContent).toContain("1 computer not shown — their sessions could not be counted")
  expect(localStorage.getItem("iris.hive.computers.filter")).toBe("agents")

  pick("Shells only")
  await wait(() => names().length === 1)
  expect(names()).toEqual(["iris-hive-001"])
  expect(host.querySelectorAll('.hmc-count[data-kind="agents"]').length).toBe(0)
  expect(host.querySelector(".hmc-filter-note")?.textContent).toContain("3 computers not shown — Hive counts shells only on the computer you are using")

  pick("All")
  await wait(() => names().length === 4)
  dispose()
  host.remove()
  localStorage.removeItem("iris.hive.computers.filter")
})

test("Add a computer opens the secure-mesh steps, in order", async () => {
  const { host, dispose } = mount({ nodes: withAddr(), sessions: SESSIONS, here: HERE })
  await wait(() => host.querySelectorAll(".hmc-card").length > 0)
  ;(host.querySelector(".hmc-add-btn") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hmc-add"))
  expect([...host.querySelectorAll(".hmc-add code")].map((c) => c.textContent)).toEqual([
    "iris playbook run hive-secure-mesh --action onboard",
    "iris playbook run hive-secure-mesh --action enroll --ip <its 100.x address>",
    "iris playbook run hive-secure-mesh --action doctor",
  ])
  dispose()
  host.remove()
})

test("Computers: sessions or this computer unreadable → said, never zero", async () => {
  const { host, dispose } = mount({ nodes: withAddr() })
  await wait(() => host.querySelectorAll(".hmc-card").length > 0 && !!host.querySelector(".hmc-totals"))
  await new Promise((r) => setTimeout(r, 50))
  expect(host.querySelector(".hmc-totals")?.textContent).toContain("— agent sessions")
  expect(host.querySelector(".hmc-totals")?.textContent).toContain("— shells · not counted")
  const counts = [...card(host, "iris-hive-001").querySelectorAll(".hmc-count")].map((c) => c.textContent)
  expect(counts).toEqual(["Agents: couldn't check", "Shells: couldn't check"])
  expect(card(host, "iris-hive-001").querySelector(".hmc-reach")?.textContent).toBe("Unknown")
  dispose()
  host.remove()
})
