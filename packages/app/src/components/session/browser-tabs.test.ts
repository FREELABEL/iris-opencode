import { beforeEach, describe, expect, test } from "bun:test"
import {
  activeTab,
  addTab,
  closeTab,
  describeTabs,
  fromPageKey,
  MAX_TABS,
  noteTabPage,
  pageKey,
  resetBrowserTabs,
  resolveTab,
  setActiveTab,
  setPendingOpen,
  tabName,
  tabsOf,
  takePendingOpen,
} from "./browser-tabs"

beforeEach(() => resetBrowserTabs())

describe("browser tabs (#193328)", () => {
  test("a chat's first tab is the page it always had; its other tabs are chat:tab", () => {
    expect(pageKey("ses_a", "1")).toBe("ses_a")
    expect(pageKey("ses_a", "t2")).toBe("ses_a:t2")
    expect(fromPageKey("ses_a")).toEqual({ chat: "ses_a", tab: "1" })
    expect(fromPageKey("ses_a:t2")).toEqual({ chat: "ses_a", tab: "t2" })
    expect(fromPageKey("ses_a:T2")).toBeUndefined()
    expect(fromPageKey("")).toBeUndefined()
  })

  test("every chat has its own row, and switching one never touches another", () => {
    const t = addTab("ses_a", "Map")!
    expect(activeTab("ses_a")).toBe(t)
    expect(tabsOf("ses_b").map((x) => x.id)).toEqual(["1"])
    expect(activeTab("ses_b")).toBe("1")
  })

  test("at most MAX_TABS; ids are never reused", () => {
    const ids = Array.from({ length: MAX_TABS + 2 }, () => addTab("c"))
    expect(ids.filter(Boolean)).toHaveLength(MAX_TABS - 1)
    expect(tabsOf("c")).toHaveLength(MAX_TABS)
    closeTab("c", "t3")
    expect(addTab("c")).toBe(`t${MAX_TABS + 1}`)
  })

  test("closing the tab showing shows its neighbour; the last tab never closes", () => {
    addTab("c", "Car rental")
    addTab("c", "Map")
    expect(activeTab("c")).toBe("t3")
    expect(closeTab("c", "t3")).toBe("t2")
    expect(closeTab("c", "1")).toBe("t2")
    expect(closeTab("c", "t2")).toBeUndefined()
    expect(tabsOf("c")).toHaveLength(1)
  })

  test("the agent names a tab by number, id or label; nothing means the one showing", () => {
    addTab("c", "Car rental")
    addTab("c", "Map")
    setActiveTab("c", "t2")
    expect(resolveTab("c", undefined)).toBe("t2")
    expect(resolveTab("c", "3")).toBe("t3")
    expect(resolveTab("c", "t3")).toBe("t3")
    expect(resolveTab("c", "map")).toBe("t3")
    expect(resolveTab("c", "rental")).toBe("t2")
    expect(resolveTab("c", "9")).toBeUndefined()
    expect(resolveTab("c", "itinerary")).toBeUndefined()
  })

  test("a tab is called its label, else its page's title or site, else New tab", () => {
    const t = addTab("c")!
    expect(tabName("c", tabsOf("c")[1]!)).toBe("New tab")
    noteTabPage(pageKey("c", t), { url: "https://www.google.com/maps", title: null })
    expect(tabName("c", tabsOf("c")[1]!)).toBe("google.com")
    noteTabPage(pageKey("c", t), { url: "https://www.google.com/maps", title: "Austin to Phoenix" })
    expect(tabName("c", tabsOf("c")[1]!)).toBe("Austin to Phoenix")
    expect(describeTabs("c")).toEqual([
      { n: 1, id: "1", active: false },
      { n: 2, id: t, title: "Austin to Phoenix", url: "https://www.google.com/maps", active: true },
    ])
  })

  test("an address waiting for a new tab is taken once", () => {
    setPendingOpen("c:t2", "https://example.com")
    expect(takePendingOpen("c:t2")).toBe("https://example.com")
    expect(takePendingOpen("c:t2")).toBeUndefined()
  })
})
