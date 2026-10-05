import { describe, expect, test } from "bun:test"
import { releasesHold } from "@/context/command"
import { DEFAULT_DICTATE_KEYBIND, dictateCommand } from "./dictate-command"

function controls() {
  const log: string[] = []
  return {
    log,
    api: {
      press: () => log.push("press"),
      release: () => log.push("release"),
      toggle: () => log.push("toggle"),
      phase: () => "idle" as const,
    },
  }
}

const base = { title: "Dictate", description: "", category: "Session" }

describe("dictateCommand", () => {
  test("the keyboard presses and releases; the palette toggles", () => {
    const { log, api } = controls()
    const cmd = dictateCommand({ ...base, controls: () => api as any })
    cmd.onSelect!("keybind")
    cmd.onRelease!()
    cmd.onSelect!("palette")
    expect(log).toEqual(["press", "release", "toggle"])
  })

  test("is disabled, and inert, while no composer is mounted", () => {
    const cmd = dictateCommand({ ...base, controls: () => undefined })
    expect(cmd.disabled).toBe(true)
    expect(() => cmd.onSelect!("keybind")).not.toThrow()
    expect(() => cmd.onRelease!()).not.toThrow()
  })

  test("defaults to mod+shift+space, which works while typing in the prompt", () => {
    expect(dictateCommand({ ...base, controls: () => undefined }).keybind).toBe(DEFAULT_DICTATE_KEYBIND)
    expect(DEFAULT_DICTATE_KEYBIND).toBe("mod+shift+space")
  })
})

describe("releasesHold — which keyup ends a held combo", () => {
  const up = (key: string) => new KeyboardEvent("keyup", { key })
  test("the combo's own key", () => expect(releasesHold("space", up(" "))).toBe(true))
  test("any modifier — macOS sends no keyup for a key let go while Cmd is down", () => {
    for (const key of ["Meta", "Control", "Shift", "Alt"]) expect(releasesHold("space", up(key))).toBe(true)
  })
  test("an unrelated key does not", () => expect(releasesHold("space", up("a"))).toBe(false))
})
