import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  SESSION_OPEN_FILE_TAB,
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  getTabReorderIndex,
  shouldShowFileTree,
} from "./helpers"

describe("shouldShowFileTree", () => {
  test("does not reserve space for a disabled file tree", () => {
    expect(shouldShowFileTree({ visible: false, opened: true })).toBe(false)
    expect(shouldShowFileTree({ visible: true, opened: true })).toBe(true)
  })
})

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      expect(result.closableTab()).toBe("context")
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("exposes the Open File tab without treating it as a file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: SESSION_OPEN_FILE_TAB as string | undefined,
        all: ["file://src/a.ts", SESSION_OPEN_FILE_TAB],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
        fileBrowser: () => true,
      })

      expect(result.openFileOpen()).toBe(true)
      expect(result.panelTabs()).toEqual(["file://src/a.ts", SESSION_OPEN_FILE_TAB])
      expect(result.openedTabs()).toEqual(["file://src/a.ts"])
      expect(result.activeTab()).toBe(SESSION_OPEN_FILE_TAB)
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBe(SESSION_OPEN_FILE_TAB)
      dispose()
    })
  })

  test("hides the Open File placeholder when the file browser is unavailable", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: SESSION_OPEN_FILE_TAB as string | undefined,
        all: ["file://src/a.ts", SESSION_OPEN_FILE_TAB],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
        fileBrowser: () => false,
      })

      expect(result.openFileOpen()).toBe(false)
      expect(result.panelTabs()).toEqual(["file://src/a.ts"])
      expect(result.activeTab()).toBe("file://src/a.ts")
      dispose()
    })
  })
})

describe("createSessionTabs — iris", () => {
  const make = (all: string[], active?: string) => {
    const [state] = createStore({ active: active as string | undefined, all })
    const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
    return createSessionTabs({
      tabs,
      pathFromTab: (tab: string) => (tab.startsWith("file://") ? tab.slice(7) : undefined),
      normalizeTab: (tab: string) => tab,
      review: () => true,
      hasReview: () => true,
    })
  }

  test("atlas is a named tab, not a file tab", () => {
    createRoot((dispose) => {
      const r = make(["iris", "file:///a.ts"])
      // The bug this guards: panelTabs is the FILE list. A named tab leaking into it gets
      // rendered twice — once as itself, once as a file with a path of "iris".
      expect(r.openedTabs()).toEqual(["file:///a.ts"])
      expect(r.irisOpen()).toBe(true)
      dispose()
    })
  })

  test("an active atlas tab stays active and stays closable", () => {
    createRoot((dispose) => {
      const r = make(["iris"], "iris")
      expect(r.activeTab()).toBe("iris")
      expect(r.closableTab()).toBe("iris")
      dispose()
    })
  })

  test("open-but-not-active atlas is only reached after files and context", () => {
    createRoot((dispose) => {
      // A file wins — you clicked it last.
      expect(make(["iris", "file:///a.ts"]).activeTab()).toBe("file:///a.ts")
      dispose()
    })
    createRoot((dispose) => {
      // Context wins over atlas when both are open and neither is active: context is the
      // pre-existing default and adding a surface must not silently displace it.
      expect(make(["iris", "context"]).activeTab()).toBe("context")
      dispose()
    })
    createRoot((dispose) => {
      expect(make(["iris"]).activeTab()).toBe("iris")
      dispose()
    })
  })

  test("no atlas tab means nothing changes", () => {
    createRoot((dispose) => {
      const r = make(["context"])
      expect(r.irisOpen()).toBe(false)
      expect(r.activeTab()).toBe("context")
      dispose()
    })
  })
})
