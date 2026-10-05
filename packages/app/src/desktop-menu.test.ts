import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { DESKTOP_MENU } from "./desktop-menu"
import { NATIVE_COMMAND_EVENT, NATIVE_COMMANDS } from "./context/command"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })
})

describe("the menus send people to IRIS, not OpenCode (#187966)", () => {
  test("no menu item links to OpenCode's docs, Discord or GitHub", () => {
    const hrefs = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).flatMap((item) =>
      item.type === "item" && item.href ? [item.href] : [],
    )
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect([href, /opencode|anomalyco|discord\.com/.test(href)]).toEqual([href, false])
  })

  test("the native Mac menu offers Settings, and the app only answers allow-listed commands", () => {
    const menu = readFileSync(path.join(import.meta.dir, "../../desktop/src/menu.ts"), "utf8")
    expect(menu).toContain('text: "Settings..."')
    expect(menu).toContain('detail: "settings.open"')
    expect(NATIVE_COMMANDS.has("settings.open")).toBe(true)
    expect(menu).toContain(`"${NATIVE_COMMAND_EVENT}"`)
  })

  test("release notes are never fetched from OpenCode's changelog", () => {
    const src = readFileSync(path.join(import.meta.dir, "context/highlights.tsx"), "utf8")
    expect(src).not.toContain("opencode.ai/changelog")
  })
})
