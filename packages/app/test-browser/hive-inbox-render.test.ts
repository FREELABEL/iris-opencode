import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import fx from "../src/components/session/__fixtures__/hive-inbox.json"

// Hive › Inbox (#189279) over fictional messages: newest first, unread marked, and opening one
// shows its BODY — the thing the old detail (from / type / read / manifest position) left out.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-hive-inbox",
  setup(build) {
    build.onLoad({ filter: /iris-hive-inbox\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-hive-(scripts|inbox)\.css$/ }, () => ({ contents: "", loader: "js" }))
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
// The real sanitizer pulls a web worker; a pass-through is enough to see the markdown render.
mock.module("@opencode-ai/session-ui/markdown-cache", () => ({ sanitizeMarkdown: (html: string) => html }))
const { IrisHiveInbox } = await import("../src/components/session/iris-hive-inbox")
const nav = await import("../src/components/session/iris-nav")

const NOW = Date.parse("2026-10-13T15:00:00Z")
const iso = (m: number) => new Date(NOW - m * 60_000).toISOString()
const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the inbox")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function mount(opts: { empty?: boolean } = {}) {
  const items = opts.empty ? [] : fx.items.map(({ minutesAgo, ...r }) => ({ ...r, receivedAt: iso(minutesAgo) }))
  const reads: string[] = []
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
  const doFetch = async (path: string, init?: RequestInit) => {
    const u = new URL(path, "http://x")
    if (u.pathname === "/iris/inbox")
      return json({ measured: true, unread: items.filter((r) => !r.read).length, items })
    const read = u.pathname.match(/^\/iris\/inbox\/(\d+)\/read$/)
    if (read && init?.method === "POST") {
      const r = items.find((x) => x.index === Number(read[1]))!
      r.read = true
      reads.push(r.id)
      return json({ measured: true, read: true, burned: false })
    }
    const one = u.pathname.match(/^\/iris\/inbox\/(\d+)$/)
    if (one) {
      const r = items.find((x) => x.index === Number(one[1]))!
      const body = (fx.bodies as Record<string, string | null>)[r.id]
      return json({
        measured: true,
        message: { ...r, body, bodyState: body === null ? "binary" : "ok", burn: false, originalName: r.type === "file" ? r.label : undefined, status: r.type === "job" ? "completed" : undefined, item: r.type === "job" ? "atlas:item:5501" : undefined },
      })
    }
    return json({ measured: false, reason: "unexpected " + path })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHiveInbox, { doFetch, now: () => NOW }), host)
  return { host, dispose, reads }
}

test("the list: newest first, unread marked, sender + first line + age", async () => {
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  const rows = [...host.querySelectorAll(".hib-row")]
  expect(rows.map((r) => r.querySelector(".hib-from")?.textContent)).toEqual([
    "Riley (agent)",
    "build-runner",
    "studio-mac",
    "render-box",
    "studio-mac",
  ])
  expect(rows.map((r) => r.classList.contains("hib-row--new"))).toEqual([true, true, true, false, false])
  expect(rows[0].querySelector(".hib-subj")?.textContent).toBe("Can you review the onboarding copy before 3pm?")
  expect(rows[0].querySelector(".hib-age")?.textContent).toBe("6m")
  expect(rows[1].querySelector(".hib-kind")?.textContent).toBe("Job result")
  expect(host.querySelector(".hib-sum")?.textContent).toContain("3 unread")
  // No raw CLI command in the list.
  expect(host.textContent).not.toContain("iris hive inbox read")
  dispose()
  host.remove()
})

test("opening a message shows its full body, marks it read, and Back returns to the list", async () => {
  const { host, dispose, reads } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  const before = nav.irisInboxVersion()
  ;(host.querySelector(".hib-row") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hib-body"))
  expect(host.querySelector(".hib-title")?.textContent).toBe("Can you review the onboarding copy before 3pm?")
  expect(host.querySelector(".hib-meta .hib-from")?.textContent).toBe("Riley (agent)")
  // markdown, rendered — the bullets and the bold are elements, not asterisks
  expect(host.querySelectorAll(".hib-body li").length).toBe(3)
  expect(host.querySelector(".hib-body strong")?.textContent).toBe("welcome screen")
  // the CLI command lives in the developer drawer only
  expect(host.querySelector(".hib-dev code")?.textContent).toBe("iris hive inbox read 5")
  await wait(() => reads.length === 1)
  expect(reads).toEqual(["m5"])
  await wait(() => nav.irisInboxVersion() > before)

  ;(host.querySelector(".hib-back") as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  await wait(() => host.querySelectorAll(".hib-row--new").length === 2)
  dispose()
  host.remove()
})

test("a binary file says so instead of showing a blank body", async () => {
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  const file = [...host.querySelectorAll(".hib-row")].find((r) => r.textContent?.includes("storyboard")) as HTMLButtonElement
  file.click()
  await wait(() => !!host.querySelector(".hib-note"))
  expect(host.querySelector(".hib-note")?.textContent).toContain("storyboard-v3.pdf is not text")
  dispose()
  host.remove()
})

test("an empty inbox says it is empty and how messages arrive", async () => {
  const { host, dispose } = mount({ empty: true })
  await wait(() => !!host.querySelector(".hib-empty b"))
  expect(host.querySelector(".hib-empty b")?.textContent).toBe("Your Hive inbox is empty")
  expect(host.querySelector(".hib-empty")?.textContent).toContain("iris hive inbox send")
  dispose()
  host.remove()
})
