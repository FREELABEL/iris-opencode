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

test("Heartbeats: skipping and failing on top, a held one is not late, a week and a timeline for each", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hbt-row").length > 0)
  if (process.env.HBT_DUMP) (await import("node:fs")).writeFileSync(process.env.HBT_DUMP + "/list.html", host.innerHTML)

  // skips and laundered failures count (#189113, #189114); a wake held for its hours does not
  expect(host.querySelector(".hmc-sum")?.textContent).toBe("10 of 18 beating8 need attention")
  const rows = [...host.querySelectorAll(".hbt-row")]
  expect(rows.length).toBe(18)
  expect(rows.map((r) => r.getAttribute("data-state")).slice(0, 8)).toEqual([
    "silent", "silent", "silent", "silent", "silent", "silent", "failing", "failing",
  ])
  expect(rows[0].querySelector(".hbt-name")?.textContent).toBe("Music Curator")
  expect(rows[0].querySelector(".hbt-line")?.textContent).toBe("Wakes but does nothing · last real beat 8 h ago")
  const mw = rows.find((r) => r.textContent?.includes("Market Watch Agent"))!
  expect(mw.getAttribute("data-state")).toBe("ok")
  expect(mw.querySelector(".hbt-line")?.textContent).toBe("Next in 14h · held for its hours · last beat 4 days ago")

  // the detail opens on the first row: its hours, the week, what is wrong
  expect(host.querySelector(".hmc-dname")?.textContent).toBe("Music CuratorSkipping")
  expect(host.querySelector(".hmc-spec")?.textContent).toContain("Weekdays · 09:00–17:00 ET")
  expect(host.querySelector(".hmc-att-list b")?.textContent).toBe("Wakes up but does nothing — last real beat 8 h ago")
  expect(host.querySelector(".hbt-week figcaption")?.textContent).toBe("This week1 worked · 3 skipped · of 20 due · 5 held for its hours")
  expect(host.querySelectorAll(".hbt-wmiss").length).toBe(3)

  // Run now goes to THIS job, and says so
  ;(host.querySelector(".hmc-btn--go") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hbt-note"))
  expect(calls.some((c) => c.path === "/iris/heartbeats/865/run")).toBe(true)
  expect(host.querySelector(".hbt-note")?.hasAttribute("data-ok")).toBe(true)

  // the held one: its next beat is when its window opens, and the cadence drift is called out
  ;([...host.querySelectorAll(".hbt-row")].find((r) => r.textContent?.includes("Market Watch Agent")) as HTMLElement).click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent?.startsWith("Market Watch Agent") ?? false)
  expect(host.querySelector(".hmc-spec")?.textContent).toContain("Tue–Thu · 07:00–16:00 ET")
  expect(host.querySelector(".hbt-wkey")?.textContent).toContain("next in 14h · held for its hours")
  expect([...host.querySelectorAll(".hmc-att-list b")].map((b) => b.textContent)).toEqual([
    "Its settings say every 5 minutes; it actually wakes every 8 hours",
  ])

  // a laundered failure opens on WHY, flagged as recorded-as-success
  const cos = [...host.querySelectorAll(".hbt-row")].find((r) => r.textContent?.includes("Chief of Staff")) as HTMLElement
  cos.click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent?.startsWith("Chief of Staff") ?? false)
  const beat = host.querySelector(".hbt-runs li") as HTMLElement
  expect(beat.getAttribute("data-b")).toBe("fail")
  expect(beat.querySelector(".hbt-run-gist")?.textContent).toBe("AI API error: 402")
  ;(beat.querySelector(".hbt-run-top") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hbt-beat"))
  expect(host.querySelector(".hbt-part--fail p")?.textContent).toBe("AI API error: 402")
  expect(host.querySelector(".hbt-fine")?.textContent).toContain("Recorded as a success")
  if (process.env.HBT_DUMP) (await import("node:fs")).writeFileSync(process.env.HBT_DUMP + "/fail.html", host.innerHTML)

  // a good beat opens on what happened, what changed, what it did, and what it left
  const nl = [...host.querySelectorAll(".hbt-row")].find((r) => r.textContent?.includes("Newsletter Agent")) as HTMLElement
  nl.click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent?.startsWith("Newsletter Agent") ?? false)
  expect(host.querySelector(".hbt-beat")).toBeNull() // a different agent starts closed
  ;(host.querySelector(".hbt-runs .hbt-run-top") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hbt-beat"))
  expect([...host.querySelectorAll(".hbt-beat h5")].map((h) => h.textContent)).toEqual([
    "What happened", "What changed since the last beat", "What it did", "Numbers", "Result",
  ])
  expect(host.querySelector(".hbt-beat .hbt-part p")?.textContent).toBe("The project is progressing; two new items were drafted.")
  if (process.env.HBT_DUMP) (await import("node:fs")).writeFileSync(process.env.HBT_DUMP + "/beat.html", host.innerHTML)

  // a pause fl-api did not save is reported as not working — never as done
  const mc = [...host.querySelectorAll(".hbt-row")].find((r) => r.textContent?.includes("Music Curator")) as HTMLElement
  mc.click()
  await wait(() => host.querySelector(".hmc-dname")?.textContent?.startsWith("Music Curator") ?? false)
  expect(host.querySelector(".hbt-aside")?.textContent).toContain("still runs on schedule")
  expect(host.querySelector(".hbt-week figcaption")?.textContent).toContain("3 skipped")
  ;([...host.querySelectorAll(".hmc-btn")].find((b) => b.textContent === "Pause") as HTMLButtonElement).click()
  await wait(() => host.querySelector(".hbt-note")?.textContent?.startsWith("Did not work") ?? false)
  expect(JSON.parse(calls.find((c) => c.path.endsWith("/pause"))!.body!)).toEqual({ paused: true })

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
