import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import snap from "../src/components/session/__fixtures__/heartbeats.json"

// Agents › Heartbeats over the REAL heartbeats of account #193 on 2026-10-12.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-heartbeats",
  setup(build) {
    build.onLoad({ filter: /iris-heartbeats\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-(hive-scripts|hive-machines|heartbeats)\.css$/ }, () => ({ contents: "", loader: "js" }))
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
const { IrisHeartbeats } = await import("../src/components/session/iris-heartbeats")

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the panel")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const NOW = Date.parse(snap.capturedAt)

function mount(opts: { empty?: boolean; unread?: boolean } = {}) {
  const calls: { path: string; body?: string }[] = []
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body as string | undefined })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path === "/iris/heartbeats") {
      if (opts.unread) return json({ measured: false, reason: "fl-api 500", heartbeats: [] })
      return json({ measured: true, heartbeats: opts.empty ? [] : snap.heartbeats })
    }
    if (path.endsWith("/run")) return json({ ok: true, status: "running" })
    if (path.endsWith("/pause")) return json({ ok: false, reason: 'fl-api saved "scheduled", not "paused"' })
    return json({ ok: false, reason: "unexpected " + path })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHeartbeats, { doFetch, now: () => NOW }), host)
  return { host, dispose, calls }
}

test("Heartbeats: the late one on top, a trace per agent, detail with what to do", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hbt-row").length > 0)
  if (process.env.HBT_DUMP) (await import("node:fs")).writeFileSync(process.env.HBT_DUMP + "/list.html", host.innerHTML)

  expect(host.querySelector(".hmc-sum")?.textContent).toBe("16 of 18 beating2 need attention")
  const rows = [...host.querySelectorAll(".hbt-row")]
  expect(rows.length).toBe(18)
  expect(rows[0].getAttribute("data-state")).toBe("late")
  expect(rows[0].querySelector(".hbt-name")?.textContent).toBe("Market Watch Agent")
  expect(rows[0].querySelector(".hbt-line")?.textContent).toBe("Late · due 3 days ago")
  expect(rows[0].querySelector(".hbt-cad")?.textContent).toBe("Every 8 hours")
  const ncma = rows.find((r) => r.textContent?.includes("Newsletter Agent"))!
  expect([...ncma.querySelectorAll(".hbt-strip i")].map((i) => i.getAttribute("data-b"))).toEqual(["ok", "fail", "ok", "ok"])

  // detail opens on the first row and says what is wrong and what to do
  expect(host.querySelector(".hmc-dname")?.textContent).toBe("Market Watch AgentLate")
  expect(host.querySelector(".hmc-att-list b")?.textContent).toBe("Missed its beat — due 3 days ago")
  expect(host.querySelector(".hmc-stats dd[data-low]")?.textContent).toBe("3d ago")

  // Run now goes to THIS job, and says so
  ;(host.querySelector(".hmc-btn--go") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hbt-note"))
  expect(calls.some((c) => c.path === "/iris/heartbeats/764/run")).toBe(true)
  expect(host.querySelector(".hbt-note")?.hasAttribute("data-ok")).toBe(true)

  // a pause fl-api did not save is reported as not working — never as done
  // the list re-renders after the action refetches; take the row as it is now
  const dj = [...host.querySelectorAll(".hbt-row")].find((r) => r.textContent?.includes("Music Curator")) as HTMLElement
  dj.click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent?.startsWith("Music Curator") ?? false)
  expect(host.querySelector(".hbt-aside")?.textContent).toContain("still runs on schedule")
  ;([...host.querySelectorAll(".hmc-btn")].find((b) => b.textContent === "Pause") as HTMLButtonElement).click()
  await wait(() => host.querySelector(".hbt-note")?.textContent?.startsWith("Did not work") ?? false)
  expect(JSON.parse(calls.find((c) => c.path.endsWith("/pause"))!.body!)).toEqual({ paused: true })
  expect(host.querySelector(".hbt-note")?.hasAttribute("data-ok")).toBe(false)

  // find narrows; Escape clears
  const find = host.querySelector(".hbt-find") as HTMLInputElement
  find.value = "oversight"
  find.dispatchEvent(new Event("input", { bubbles: true }))
  await wait(() => host.querySelectorAll(".hbt-row").length === 1)
  dispose()
  host.remove()
})

test("an account with no heartbeats says how to start one; an unreadable one says it could not read", async () => {
  const a = mount({ empty: true })
  await wait(() => !!a.host.querySelector(".hmc-empty"))
  expect(a.host.querySelector(".hmc-empty")?.textContent).toContain("--heartbeat-mode")
  expect(a.host.querySelector(".hmc-detail")).toBeNull()
  a.dispose()
  a.host.remove()
  const b = mount({ unread: true })
  await wait(() => !!b.host.querySelector(".hsc-warn"))
  expect(b.host.querySelector(".hsc-warn")?.textContent).toBe("Could not read your heartbeats — fl-api 500")
  expect(b.host.querySelector(".hmc-empty")).toBeNull()
  b.dispose()
  b.host.remove()
})
