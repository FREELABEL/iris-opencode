import { beforeEach, describe, expect, test } from "bun:test"
import { chatOnScreen, markOnScreen, runPageCommand, type PageCommand } from "./use-panel-control"
import { grantSite, revokeSite } from "./browser-grants"
import { resetBrowserTabs } from "./browser-tabs"

// #193492 — the agent's chat need not be on screen. In the flight test every Browser failure was
// the agent's own chat timing out while the person looked at another chat.

const SITE = "https://www.google.com"

function fakeBrowser(opts: { alive: boolean; url?: string; shotFails?: boolean }) {
  const calls: string[] = []
  let alive = opts.alive
  let url = opts.url ?? `${SITE}/travel/flights`
  const nb = {
    calls,
    async show(u: string | undefined, b: { x: number }) {
      calls.push(`show ${u ?? "-"} x=${b.x}`)
      alive = true
      if (u) url = u
    },
    async hide() {
      calls.push("hide")
    },
    async bounds() {},
    async navigate(u: string) {
      if (!alive) throw new Error("the browser is not open")
      calls.push(`navigate ${u}`)
      url = u
      return u
    },
    async go() {},
    async state() {
      return { url, title: "Flights", loading: false }
    },
    async eval(script: string) {
      if (!alive) throw new Error("the Browser isn't open")
      if (script === "true") return "true"
      if (script.includes("_cf_chl_opt")) return JSON.stringify({ ok: true, value: { title: "Flights", heading: "", cfChallenge: false, blockWidget: false, asksForHuman: false } })
      calls.push(`eval ${script}`)
      return JSON.stringify({ ok: true, value: "done" })
    },
    async screenshot() {
      if (opts.shotFails) throw new Error("snapshot failed")
      return "JPEG"
    },
    onState() {
      return () => {}
    },
  }
  return nb
}

function run(nb: ReturnType<typeof fakeBrowser>, cmd: PageCommand, onScreen = false) {
  return new Promise<{ result?: string; error?: string }>((resolve) => {
    void runPageCommand(
      {
        chat: "ses_agent",
        platform: { nativeBrowser: () => nb } as any,
        onScreen,
        reply: resolve,
        showBrowser: () => nb.calls.push("showBrowser"),
      },
      cmd,
    )
  })
}

describe("page commands for a chat that is not on screen (#193492)", () => {
  beforeEach(() => {
    resetBrowserTabs()
    grantSite(SITE, true)
  })

  test("a click runs in the chat's hidden page, without switching the person's screen", async () => {
    const nb = fakeBrowser({ alive: true })
    const r = await run(nb, { action: "page", op: "eval", script: "click(7)", mode: "act" })
    expect(r.error).toBeUndefined()
    expect(nb.calls).toContain("eval click(7)")
    expect(nb.calls).not.toContain("showBrowser")
    expect(nb.calls.some((c) => c.startsWith("show "))).toBe(false)
  })

  test("a page closed to make room is woken off screen, then hidden, then used", async () => {
    const nb = fakeBrowser({ alive: false })
    const r = await run(nb, { action: "page", op: "eval", script: "read()", mode: "read" })
    expect(r.error).toBeUndefined()
    expect(nb.calls[0]).toBe("show - x=-30000")
    expect(nb.calls[1]).toBe("hide")
    expect(nb.calls).toContain("eval read()")
  })

  test("open loads the address in the hidden page", async () => {
    const nb = fakeBrowser({ alive: true, url: `${SITE}/` })
    const r = await run(nb, { action: "page", op: "open", url: `${SITE}/travel/flights` })
    expect(r.error).toBeUndefined()
    expect(nb.calls).toContain(`navigate ${SITE}/travel/flights`)
    expect(JSON.parse(r.result!).value.url).toBe(`${SITE}/travel/flights`)
  })

  test("an irreversible click never happens off screen: it answers at once, nothing clicked", async () => {
    const nb = fakeBrowser({ alive: true })
    const r = await run(nb, { action: "page", op: "eval", script: "click(9)", mode: "act", confirm: "Book" })
    expect(r.error).toContain(`clicking "Book" needs the person's yes`)
    expect(r.error).toContain("another chat")
    expect(nb.calls.some((c) => c.startsWith("eval click"))).toBe(false)
  })

  test("a site not allowed answers at once and says the person is elsewhere", async () => {
    revokeSite(SITE)
    const nb = fakeBrowser({ alive: true })
    const r = await run(nb, { action: "page", op: "eval", script: "read()", mode: "read" })
    expect(r.error).toContain("hasn't let IRIS use")
    expect(r.error).toContain("another chat")
  })

  test("a picture of a hidden page that fails says to read instead", async () => {
    const nb = fakeBrowser({ alive: true, shotFails: true })
    const r = await run(nb, { action: "page", op: "screenshot" })
    expect(r.error).toContain("Use read, elements or find instead")
  })

  test("on screen, a click in the showing tab behaves as before", async () => {
    const nb = fakeBrowser({ alive: true })
    const r = await run(nb, { action: "page", op: "eval", script: "click(7)", mode: "act" }, true)
    expect(r.error).toBeUndefined()
    expect(nb.calls).toContain("eval click(7)")
  })

  test("a chat counts as on screen while any pane shows it", () => {
    const a = markOnScreen("ses_x")
    const b = markOnScreen("ses_x")
    a()
    expect(chatOnScreen("ses_x")).toBe(true)
    b()
    expect(chatOnScreen("ses_x")).toBe(false)
  })
})
