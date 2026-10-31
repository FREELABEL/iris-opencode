import { describe, expect, test } from "bun:test"
import { eventKey, formatKeybind, matchKeybind, parseKeybind } from "./command"

describe("command keybind helpers", () => {
  test("parseKeybind handles aliases and multiple combos", () => {
    const keybinds = parseKeybind("control+option+k, mod+shift+comma")

    expect(keybinds).toHaveLength(2)
    expect(keybinds[0]).toEqual({
      key: "k",
      ctrl: true,
      meta: false,
      shift: false,
      alt: true,
    })
    expect(keybinds[1]?.shift).toBe(true)
    expect(keybinds[1]?.key).toBe("comma")
    expect(Boolean(keybinds[1]?.ctrl || keybinds[1]?.meta)).toBe(true)
  })

  test("parseKeybind treats none and empty as disabled", () => {
    expect(parseKeybind("none")).toEqual([])
    expect(parseKeybind("")).toEqual([])
  })

  test("matchKeybind normalizes punctuation keys", () => {
    const keybinds = parseKeybind("ctrl+comma, shift+plus, meta+space")

    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: ",", ctrlKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: "+", shiftKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: " ", metaKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: ",", ctrlKey: true, altKey: true }))).toBe(false)
  })

  test("matchKeybind supports bracket keys", () => {
    const keybinds = parseKeybind("mod+alt+[, mod+alt+]")
    const prev = keybinds[0]
    const next = keybinds[1]

    expect(
      matchKeybind(
        keybinds,
        new KeyboardEvent("keydown", { key: "[", ctrlKey: prev?.ctrl, metaKey: prev?.meta, altKey: true }),
      ),
    ).toBe(true)
    expect(
      matchKeybind(
        keybinds,
        new KeyboardEvent("keydown", { key: "]", ctrlKey: next?.ctrl, metaKey: next?.meta, altKey: true }),
      ),
    ).toBe(true)
  })

  test("formatKeybind returns human readable output", () => {
    const display = formatKeybind("ctrl+alt+arrowup")

    expect(display).toContain("↑")
    expect(display.includes("Ctrl") || display.includes("⌃")).toBe(true)
    expect(display.includes("Alt") || display.includes("⌥")).toBe(true)
    expect(formatKeybind("none")).toBe("")
  })

  test("formatKeybind prefers the first combo", () => {
    const display = formatKeybind("mod+k,mod+p")

    expect(display.includes("K") || display.includes("k")).toBe(true)
    expect(display.includes("P") || display.includes("p")).toBe(false)
  })
})

describe("Option shortcuts on macOS (#191484)", () => {
  const ev = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent

  test("⌥ remaps the character; the physical key still matches", () => {
    // "mod" is platform-dependent, so the match is checked with alt alone
    expect(matchKeybind(parseKeybind("alt+\\"), ev("«", "Backslash", { altKey: true }))).toBe(true)
    expect(matchKeybind(parseKeybind("alt+w"), ev("∑", "KeyW", { altKey: true }))).toBe(true)
    expect(eventKey(ev("∑", "KeyW", { altKey: true }))).toBe("w")
    expect(eventKey(ev("“", "BracketLeft", { altKey: true }))).toBe("[")
    expect(eventKey(ev("¡", "Digit1", { altKey: true }))).toBe("1")
  })

  test("without ⌥ the character decides, as before; arrows are untouched", () => {
    expect(eventKey(ev("«", "Backslash"))).toBe("«")
    expect(eventKey(ev("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe("arrowleft")
    expect(eventKey(ev("Enter", "Enter", { altKey: true }))).toBe("enter")
  })
})
