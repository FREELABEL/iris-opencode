import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { AsyncStorage } from "@solid-primitives/storage"

// #193410: a tab switch rewrote opencode.global.dat (121 KB on the reporter's Mac) because the
// command catalog was re-set unchanged on every switch and tabs.recent lived in the same file.

type PersistModule = typeof import("../src/utils/persist")
let mod: PersistModule

class CountingStorage implements Storage {
  values = new Map<string, string>()
  sets: string[] = []
  clear() {
    this.values.clear()
  }
  get length() {
    return this.values.size
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.sets.push(key)
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

/** Desktop's tauri-plugin-store, one Map per file, every set counted per file. */
function desktopFiles() {
  const files = new Map<string, Map<string, string>>()
  const sets: string[] = []
  const file = (name = "default.dat") => {
    let f = files.get(name)
    if (!f) files.set(name, (f = new Map()))
    return f
  }
  const storage = (name?: string): AsyncStorage => ({
    getItem: async (key) => file(name).get(key) ?? null,
    setItem: async (key, value) => {
      sets.push(`${name}:${key}`)
      file(name).set(key, value)
    },
    removeItem: async (key) => {
      file(name).delete(key)
    },
  })
  return { files, sets, file, storage }
}

const local = new CountingStorage()
// The real (happy-dom) localStorage, put back when this file is done so later files see theirs.
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original)
})

beforeAll(async () => {
  mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
  mod = await import("../src/utils/persist")
})

beforeEach(() => {
  local.clear()
  local.sets.length = 0
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true })
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("persisted writes (#193410)", () => {
  test("desktop: an unchanged value is not written again", async () => {
    const d = desktopFiles()
    const desktop = { platform: "desktop", storage: d.storage } as never
    let set!: (v: Record<string, { title: string }>) => void
    let ready!: Promise<unknown> | undefined
    const dispose = createRoot((dispose) => {
      const [, s, , r] = mod.persisted(
        mod.Persist.global("catalog.test"),
        createStore<Record<string, { title: string }>>({}),
        desktop,
      )
      set = s as never
      ready = r.promise
      return dispose
    })
    await ready
    d.sets.length = 0
    set({ a: { title: "A" } })
    set({ a: { title: "A" } })
    set({ a: { title: "A" } })
    await flush()
    expect(d.sets.filter((k) => k.endsWith("catalog.test"))).toHaveLength(1)
    set({ b: { title: "B" } })
    await flush()
    expect(d.sets.filter((k) => k.endsWith("catalog.test"))).toHaveLength(2)
    dispose()
  })

  test("two persisted() of one key never skip a write the other made stale", () => {
    createRoot((dispose) => {
      const web = { platform: "web" } as never
      const [, setA] = mod.persisted(mod.Persist.global("open.test"), createStore({ app: "finder" }), web)
      const [, setB] = mod.persisted(mod.Persist.global("open.test"), createStore({ app: "finder" }), web)
      setA("app", "vscode")
      setB("app", "cursor")
      setA("app", "vscode")
      expect(JSON.parse(local.getItem("opencode.global.dat:open.test")!)).toEqual({ app: "vscode" })
      dispose()
    })
  })

  test("removing a persisted key forgets its last write, so the same value writes again", () => {
    createRoot((dispose) => {
      const web = { platform: "web" } as never
      const [, set] = mod.persisted(mod.Persist.global("gone.test"), createStore({ v: 0 }), web)
      set("v", 1)
      mod.removePersisted(mod.Persist.global("gone.test"), web)
      set("v", 1)
      expect(local.getItem("opencode.global.dat:gone.test")).toBe('{"v":1}')
      dispose()
    })
  })

  test("web: a value cleared outside persist (site data cleared) is written again", () => {
    createRoot((dispose) => {
      const web = { platform: "web" } as never
      const [, set] = mod.persisted(mod.Persist.global("cleared.test"), createStore({ v: 0 }), web)
      set("v", 1)
      local.clear()
      set("v", 2)
      set("v", 1)
      expect(local.getItem("opencode.global.dat:cleared.test")).toBe('{"v":1}')
      local.clear()
      set("v", 1)
      expect(local.getItem("opencode.global.dat:cleared.test")).toBe('{"v":1}')
      dispose()
    })
  })

  test("desktop: window keys (tabs, tabs.recent) get their own file, not opencode.global.dat", () => {
    const desktop = { platform: "desktop", storage: () => undefined } as never
    const target = mod.PersistTesting.resolveTarget(mod.Persist.window("tabs.recent"), desktop)
    expect(target.storage).toBe("opencode.window.main.dat")
    expect(target.legacyStorageNames).toContain("opencode.global.dat")
    // a window that has its own id keeps its own file, as before
    const own = mod.PersistTesting.resolveTarget(mod.Persist.window("tabs"), {
      platform: "desktop",
      windowID: "w2",
    } as never)
    expect(own.storage).toBe("opencode.window.w2.dat")
  })

  test("desktop: tabs saved in opencode.global.dat by an older version move to the window file on first read", async () => {
    const d = desktopFiles()
    const tabs = [{ type: "session", server: "http://127.0.0.1:4096", sessionId: "ses_1" }]
    d.file("opencode.global.dat").set("tabs.legacy", JSON.stringify(tabs))
    d.file("opencode.global.dat").set("notification", '{"list":[]}')
    const desktop = { platform: "desktop", storage: d.storage } as never

    let ready!: Promise<unknown> | undefined
    let state!: unknown[]
    const dispose = createRoot((dispose) => {
      const [s, , , r] = mod.persisted(mod.Persist.window("tabs.legacy"), createStore<unknown[]>([]), desktop)
      state = s
      ready = r.promise
      return dispose
    })
    await ready
    await flush()
    expect(JSON.parse(JSON.stringify(state))).toEqual(tabs)
    expect(d.file("opencode.window.main.dat").get("tabs.legacy")).toBe(JSON.stringify(tabs))
    expect(d.file("opencode.global.dat").has("tabs.legacy")).toBeFalse()
    // everything else stays where it was
    expect(d.file("opencode.global.dat").get("notification")).toBe('{"list":[]}')
    dispose()
  })

  test("desktop: a tab switch writes only the small window file", async () => {
    const d = desktopFiles()
    const desktop = { platform: "desktop", storage: d.storage } as never
    let set!: (k: "key", v: string) => void
    let ready!: Promise<unknown> | undefined
    const dispose = createRoot((dispose) => {
      const [, s, , r] = mod.persisted(mod.Persist.window("tabs.recent.switch"), createStore<{ key?: string }>({}), desktop)
      set = s as never
      ready = r.promise
      return dispose
    })
    await ready
    d.sets.length = 0
    set("key", "a")
    set("key", "b")
    set("key", "b")
    await flush()
    expect(d.sets).toEqual(["opencode.window.main.dat:tabs.recent.switch", "opencode.window.main.dat:tabs.recent.switch"])
    dispose()
  })
})
