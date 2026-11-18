import { describe, expect, test } from "bun:test"
import {
  addressToUrl,
  knownEmbeddable,
  linkAction,
  needsSystemBrowser,
  navigateWeb,
  webBack,
  webCanBack,
  webCanForward,
  webForward,
  webReloadKey,
  webUrl,
} from "./web-nav"

const click = (
  href: string | undefined,
  mods: Partial<{ button: number; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
) =>
  linkAction({
    href,
    button: 0,
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    appOrigin: "tauri://localhost",
    ...mods,
  })

describe("linkAction", () => {
  test("a plain click on a web link opens it in the side panel", () => {
    expect(click("https://heyiris.io/p/x")).toBe("panel")
    expect(click("https://github.com/FREELABEL")).toBe("panel")
  })

  test("Cmd-click and Ctrl-click still go to the system browser", () => {
    expect(click("https://github.com/", { meta: true })).toBe("system")
    expect(click("https://github.com/", { ctrl: true })).toBe("system")
  })

  test("mailto, tel, file and custom schemes are left exactly as they were", () => {
    for (const href of ["mailto:a@b.co", "tel:+15555555555", "file:///etc/hosts", "vscode://file/x"])
      expect(click(href)).toBe("default")
  })

  test("links back into the app are navigation, never framed", () => {
    expect(
      linkAction({
        href: "/session/abc",
        button: 0,
        meta: false,
        ctrl: false,
        shift: false,
        alt: false,
        appOrigin: "http://localhost:4097",
      }),
    ).toBe("default")
    expect(
      linkAction({
        href: "http://localhost:4097/x",
        button: 0,
        meta: false,
        ctrl: false,
        shift: false,
        alt: false,
        appOrigin: "http://localhost:4097",
      }),
    ).toBe("default")
  })

  test("middle click, shift, alt and missing href are not claimed", () => {
    expect(click("https://a.com/", { button: 1 })).toBe("default")
    expect(click("https://a.com/", { shift: true })).toBe("default")
    expect(click("https://a.com/", { alt: true })).toBe("default")
    expect(click(undefined)).toBe("default")
  })
})

describe("history", () => {
  test("back, forward, and a new page drops the forward stack", () => {
    navigateWeb("https://a.com/")
    navigateWeb("https://b.com/")
    navigateWeb("https://c.com/")
    webBack()
    expect(webUrl()).toBe("https://b.com/")
    expect(webCanForward()).toBe(true)
    navigateWeb("https://d.com/")
    expect(webCanForward()).toBe(false)
    webBack()
    expect(webUrl()).toBe("https://b.com/")
    webForward()
    expect(webUrl()).toBe("https://d.com/")
    expect(webCanBack()).toBe(true)
  })

  test("opening the page already shown reloads it instead of stacking a duplicate", () => {
    navigateWeb("https://e.com/")
    const key = webReloadKey()
    navigateWeb("https://e.com/")
    expect(webReloadKey()).toBe(key + 1)
    webBack()
    expect(webUrl()).not.toBe("https://e.com/")
  })
})

describe("addressToUrl / knownEmbeddable", () => {
  test("a bare host gets https; junk and non-web schemes do not", () => {
    expect(addressToUrl("heyiris.io/p/x")).toBe("https://heyiris.io/p/x")
    expect(addressToUrl("http://localhost:3000")).toBe("http://localhost:3000/")
    expect(addressToUrl("hello")).toBeUndefined()
    expect(addressToUrl("javascript:alert(1)")).toBeUndefined()
  })

  test("only https heyiris.io skips the frame check", () => {
    expect(knownEmbeddable("https://heyiris.io/p/x")).toBe(true)
    expect(knownEmbeddable("http://heyiris.io/p/x")).toBe(false)
    expect(knownEmbeddable("https://heyiris.io.evil.com/")).toBe(false)
  })
})

describe("restoreHistory", () => {
  test("brings back the page you were on, and refuses anything that is not a web page", async () => {
    const { restoreHistory } = await import("./web-nav")
    expect(restoreHistory(JSON.stringify({ stack: ["https://a.com/", "https://b.com/"], index: 0 }))).toEqual({
      stack: ["https://a.com/", "https://b.com/"],
      index: 0,
      reload: 0,
    })
    expect(
      restoreHistory(JSON.stringify({ stack: ["javascript:alert(1)", "https://a.com/"], index: 9 })).stack,
    ).toEqual(["https://a.com/"])
    expect(restoreHistory("not json").index).toBe(-1)
    expect(restoreHistory(null).stack).toEqual([])
  })
})

describe("sign-in pages open in the system browser (#188639)", () => {
  test("Composio connect, Google, Microsoft and OAuth paths are never framed", () => {
    for (const u of [
      "https://backend.composio.dev/api/v3/s/2zvCydoI",
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://github.com/login/oauth/authorize?client_id=x",
      "https://www.facebook.com/v19.0/dialog/oauth?x=1",
      "https://app.example.com/oauth/authorize",
    ])
      expect(needsSystemBrowser(u)).toBe(true)
  })
  test("ordinary pages still open in the panel", () => {
    for (const u of ["https://heyiris.io/p/x", "https://www.facebook.com/somepage", "https://docs.example.com/authoring-guide", "https://github.com/FREELABEL"])
      expect(needsSystemBrowser(u)).toBe(false)
  })
  test("a click on a sign-in link is a system open, not a panel open", () => {
    expect(click("https://backend.composio.dev/api/v3/s/2zvCydoI")).toBe("system")
    expect(click("https://heyiris.io/p/x")).toBe("panel")
  })
})

describe("a claimed chat link opens once (#192620)", () => {
  const { claimLinkClick } = require("./web-nav")

  // tauri-plugin-shell 2.x's injected script, as shipped: a <body> click listener that opens every
  // target=_blank http(s) link and does NOT check defaultPrevented.
  function mount(href: string) {
    document.body.innerHTML = `<div id="chat"><p><a id="l" class="external-link" href="${href}" target="_blank"><code>x</code></a></p></div>`
    const shellOpened: string[] = []
    const openerOpened: string[] = []
    const app: string[] = []
    const onBody = (e: Event) => {
      const a = (e.target as Element).closest("a") as HTMLAnchorElement | null
      if (a && a.target === "_blank" && /^https?:/.test(a.href)) shellOpened.push(a.href)
    }
    const onWindow = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const a = (e.target as Element).closest("a") as HTMLAnchorElement | null
      if (a && a.target === "_blank") openerOpened.push(a.href)
    }
    document.body.addEventListener("click", onBody)
    window.addEventListener("click", onWindow)
    const chat = document.getElementById("chat")!
    chat.addEventListener("click", (e) => {
      const c = claimLinkClick(e as MouseEvent, "http://tauri.localhost")
      if (c) app.push(`${c.action}:${c.href}`)
    }, true)
    const cleanup = () => {
      document.body.removeEventListener("click", onBody)
      window.removeEventListener("click", onWindow)
    }
    return { shellOpened, openerOpened, app, cleanup }
  }
  const click = (init: MouseEventInit = {}) =>
    document.querySelector("#l code")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }))

  test("a Genesis link opens in the panel and nowhere else", () => {
    const m = mount("https://heyiris.io/p/some-page")
    click()
    expect(m.app).toEqual(["panel:https://heyiris.io/p/some-page"])
    expect(m.shellOpened).toEqual([])
    expect(m.openerOpened).toEqual([])
    m.cleanup()
  })

  test("an Atlas link too", () => {
    const m = mount("https://heyiris.io/atlas?project=402&card=1")
    click()
    expect(m.app).toEqual(["panel:https://heyiris.io/atlas?project=402&card=1"])
    expect(m.shellOpened).toEqual([])
    m.cleanup()
  })

  test("Cmd-click goes to the browser once, not twice", () => {
    const m = mount("https://example.com/")
    click({ metaKey: true })
    expect(m.app).toEqual(["system:https://example.com/"])
    expect(m.shellOpened).toEqual([])
    m.cleanup()
  })

  test("a click the app leaves alone (Shift) is not claimed", () => {
    const m = mount("https://example.com/")
    click({ shiftKey: true })
    expect(m.app).toEqual([])
    expect(m.shellOpened).toEqual(["https://example.com/"])
    m.cleanup()
  })
})
