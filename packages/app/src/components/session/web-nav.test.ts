import { describe, expect, test } from "bun:test"
import {
  addressToUrl,
  knownEmbeddable,
  linkAction,
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
