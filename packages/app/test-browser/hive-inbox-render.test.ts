import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import fx from "../src/components/session/__fixtures__/hive-inbox.json"

// Hive › Inbox over fictional messages. v1 (#189279): opening one shows its BODY. v2 (#190917): one
// inbox, two lenses, a click opens the THREAD, and done / unread / reply are real writes.
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

function mount(opts: { empty?: boolean; unmeasured?: boolean } = {}) {
  try {
    localStorage.removeItem("iris.hive-inbox.v2")
  } catch {}
  const items: any[] = opts.empty ? [] : fx.items.map(({ minutesAgo, ...r }) => ({ ...r, receivedAt: iso(minutesAgo) }))
  const sent: any[] = opts.empty ? [] : fx.sent.map(({ minutesAgo, ...s }) => ({ ...s, sentAt: iso(minutesAgo) }))
  const reads: string[] = []
  const states: any[] = []
  const sends: any[] = []
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
  const doFetch = async (path: string, init?: RequestInit) => {
    const u = new URL(path, "http://x")
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (u.pathname === "/iris/inbox")
      return json(
        opts.unmeasured
          ? { measured: false, reason: "the inbox manifest could not be parsed", unread: null, items: [] }
          : { measured: true, unread: items.filter((r) => !r.read).length, items },
      )
    if (u.pathname === "/iris/inbox-sent") return json({ measured: true, items: sent })
    if (u.pathname === "/iris/inbox-send" && init?.method === "POST") {
      sends.push(body)
      const s = { id: `o${sends.length + 1}`, to: body.to, text: body.text, sentAt: new Date(NOW).toISOString(), taskId: "t-x", replyTo: body.replyTo }
      sent.push(s)
      return json({ measured: true, ok: true, sent: s })
    }
    const read = u.pathname.match(/^\/iris\/inbox\/(\d+)\/read$/)
    if (read && init?.method === "POST") {
      const r = items.find((x) => x.index === Number(read[1]))!
      r.read = true
      reads.push(r.id)
      return json({ measured: true, read: true, burned: false })
    }
    const st = u.pathname.match(/^\/iris\/inbox\/(\d+)\/state$/)
    if (st && init?.method === "POST") {
      const r = items.find((x) => x.index === Number(st[1]))!
      states.push({ id: r.id, ...body })
      if (body.read !== undefined) r.read = body.read
      if (body.done !== undefined) {
        r.done = body.done
        if (body.done) r.read = true
      }
      return json({ measured: true, read: r.read, done: !!r.done, ...(body.resolveCard ? { card: { item: r.item, ok: true } } : {}) })
    }
    const one = u.pathname.match(/^\/iris\/inbox\/(\d+)$/)
    if (one) {
      const r = items.find((x) => x.index === Number(one[1]))!
      const b = (fx.bodies as Record<string, string | null>)[r.id]
      return json({
        measured: true,
        message: { ...r, body: b, bodyState: b === null ? "binary" : "ok", burn: false, originalName: r.type === "file" ? r.label : undefined, status: r.status ?? (r.type === "job" ? "completed" : undefined), item: r.item ?? (r.type === "job" ? "atlas:item:5501" : undefined) },
      })
    }
    return json({ measured: false, reason: "unexpected " + path })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHiveInbox, { doFetch, now: () => NOW }), host)
  const done = () => {
    dispose()
    host.remove()
  }
  return { host, done, reads, states, sends, items }
}

const froms = (host: HTMLElement) => [...host.querySelectorAll(".hib-row .hib-from")].map((e) => e.textContent?.trim())
const chip = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".hib-chip")].find((c) => c.textContent?.startsWith(label))!
const tab = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".hib-seg button")].find((c) => c.textContent?.trim() === label)!
const key = (host: HTMLElement, k: string) =>
  host.querySelector(".hib")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))

test("Inbox lens: needs-you first, then unread, then read — with the count from the manifest", async () => {
  const { host, done } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length === 6)
  expect(froms(host)).toEqual(["Riley (agent)", "iris-hive-001", "build-runner", "studio-mac", "render-box", "studio-mac"])
  expect([...host.querySelectorAll(".hib-row")].map((r) => !!r.querySelector(".hib-need"))).toEqual([true, true, false, false, false, false])
  expect(host.querySelector(".hib-sum")?.textContent).toContain("4 unread")
  expect(host.querySelector(".hib-sum")?.textContent).toContain("this machine")
  expect(chip(host, "All").textContent).toBe("All6")
  expect(chip(host, "Needs me").textContent).toBe("Needs me2")
  expect(chip(host, "Sent").textContent).toBe("Sent1")
  // the handoff row names its card, and that someone already replied
  const handoff = [...host.querySelectorAll(".hib-row")][1]
  expect(handoff.querySelector(".hib-sub")?.textContent).toContain("#190875")
  expect(handoff.querySelector(".hib-sub")?.textContent).toContain("1 reply")
  expect(host.textContent).not.toContain("iris hive inbox read")
  done()
})

test("Activity lens: the same items in time order, grouped by day — and the filter travels", async () => {
  const { host, done } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length === 6)
  tab(host, "Activity").click()
  await wait(() => !!host.querySelector(".hib-day"))
  expect(froms(host)).toEqual(["Riley (agent)", "iris-hive-001", "build-runner", "studio-mac", "render-box", "studio-mac"].slice(0, 6))
  expect(host.querySelector(".hib-day")?.textContent).toBe("Today")
  expect(host.querySelectorAll(".hib-day").length).toBeGreaterThanOrEqual(2)
  chip(host, "Files").click()
  await wait(() => host.querySelectorAll(".hib-row").length === 1)
  tab(host, "Inbox").click()
  await wait(() => !host.querySelector(".hib-day"))
  expect(host.querySelectorAll(".hib-row").length).toBe(1)
  expect(chip(host, "Files").getAttribute("aria-selected")).toBe("true")
  done()
})

test("Sent is a filter in both lenses, and never claims delivery", async () => {
  const { host, done } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length === 6)
  chip(host, "Sent").click()
  await wait(() => host.querySelectorAll(".hib-row--out").length === 1)
  const r = host.querySelector(".hib-row--out")!
  expect(r.querySelector(".hib-from")?.textContent).toContain("iris-hive-001")
  expect(r.textContent).toContain("accepted by IRIS")
  expect(r.textContent).not.toMatch(/delivered|seen/i)
  done()
})

test("a click opens the thread: rail, full body, marks read; Esc returns with the same selection", async () => {
  const { host, done, reads } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  const before = nav.irisInboxVersion()
  ;(host.querySelector(".hib-row") as HTMLButtonElement).click()
  await wait(() => !!host.querySelector(".hib-msg .hib-body"))
  expect(host.querySelector(".hib-thead .hib-title")?.textContent).toBe("Riley (agent)")
  expect(host.querySelectorAll(".hib-body li").length).toBe(3)
  expect(host.querySelector(".hib-body strong")?.textContent).toBe("welcome screen")
  expect(host.querySelectorAll(".hib-rail-btn").length).toBe(5)
  expect(host.querySelector(".hib-dev code")?.textContent).toBe("iris hive inbox read 5")
  await wait(() => reads.includes("m5"))
  await wait(() => nav.irisInboxVersion() > before)
  key(host, "Escape")
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  expect(host.querySelector(".hib-row--sel .hib-from")?.textContent).toBe("Riley (agent)")
  done()
})

test("a handoff thread: both sides, the Atlas card, Done closes the card, and a reply goes to that computer", async () => {
  const { host, done, states, sends } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  ;([...host.querySelectorAll(".hib-row")][1] as HTMLButtonElement).click()
  await wait(() => host.querySelectorAll(".hib-msg").length === 2)
  const msgs = [...host.querySelectorAll(".hib-msg")]
  expect(msgs[0].querySelector(".hib-card")?.textContent).toContain("#190875")
  expect(msgs[0].querySelector(".hib-card-status")?.textContent).toBe("blocked")
  expect(msgs[1].classList.contains("hib-msg--out")).toBe(true)
  expect(msgs[1].querySelector(".hib-state")?.textContent).toBe("accepted by IRIS")

  const doneBtn = [...msgs[0].querySelectorAll<HTMLButtonElement>(".hib-chipbtn")].find((b) => b.textContent?.startsWith("Done"))!
  expect(doneBtn.textContent).toBe("Done · close #190875")
  doneBtn.click()
  await wait(() => states.length === 1)
  expect(states[0]).toMatchObject({ id: "m6", done: true, resolveCard: true })
  await wait(() => !!host.querySelector(".hib-notice"))
  expect(host.querySelector(".hib-notice")?.textContent).toContain("card #190875 closed")

  const ta = host.querySelector(".hib-compose-dock textarea") as HTMLTextAreaElement
  ta.value = "Same branch, please."
  ta.dispatchEvent(new Event("input", { bubbles: true }))
  ;(host.querySelector(".hib-compose-dock form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await wait(() => sends.length === 1)
  expect(sends[0]).toEqual({ to: "iris-hive-001", text: "Same branch, please.", replyTo: "m6" })
  await wait(() => host.querySelectorAll(".hib-msg--out").length === 2)
  done()
})

test("keyboard: j moves, e marks done (separate from read), u marks unread", async () => {
  const { host, done, states } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length === 6)
  key(host, "j")
  key(host, "j")
  key(host, "j")
  await wait(() => host.querySelector(".hib-row--sel .hib-from")?.textContent === "build-runner")
  expect(host.querySelector(".hib-peek")).toBeTruthy()
  key(host, "e")
  await wait(() => states.length === 1)
  expect(states[0]).toMatchObject({ id: "m4", done: true })
  // done leaves All and lands in Done
  await wait(() => chip(host, "Done").textContent === "Done1")
  chip(host, "All").click()
  await wait(() => host.querySelectorAll(".hib-row").length === 5)
  // the oldest message is read: focusing it selects it, and u marks it unread — a write, not a filter
  const rows = [...host.querySelectorAll<HTMLButtonElement>(".hib-row")]
  rows[rows.length - 1].focus()
  await wait(() => !!host.querySelector(".hib-row--sel"))
  key(host, "u")
  await wait(() => states.length === 2)
  expect(states[1]).toMatchObject({ id: "m1", read: false })
  expect(states[1].done).toBeUndefined()
  done()
})

test("unread that could not be measured is a dash, never zero", async () => {
  const { host, done } = mount({ unmeasured: true })
  await wait(() => !!host.querySelector(".hsc-warn"))
  expect(host.querySelector(".hib-sum b")?.textContent).toBe("—")
  done()
})

test("a binary file says so instead of showing a blank body", async () => {
  const { host, done } = mount()
  await wait(() => host.querySelectorAll(".hib-row").length > 0)
  const file = [...host.querySelectorAll(".hib-row")].find((r) => r.textContent?.includes("storyboard")) as HTMLButtonElement
  file.click()
  await wait(() => !!host.querySelector(".hib-note"))
  expect(host.querySelector(".hib-note")?.textContent).toContain("storyboard-v3.pdf is not text")
  expect(host.querySelector(".hib-file-name")?.textContent).toBe("storyboard-v3.pdf")
  done()
})

test("an empty inbox says it is empty and how messages arrive", async () => {
  const { host, done } = mount({ empty: true })
  await wait(() => !!host.querySelector(".hib-empty b"))
  expect(host.querySelector(".hib-empty b")?.textContent).toBe("Your Hive inbox is empty")
  expect(host.querySelector(".hib-empty")?.textContent).toContain("iris hive inbox send")
  done()
})
