import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Panel } from "./panel"

// #190093 — the agent sees and steers the desktop side panel.

const S = "ses_panel1"
const catalog: Panel.State["catalog"] = [
  { id: "atlas", label: "Atlas", subs: [{ id: "lists", label: "Lists" }, { id: "schemas", label: "Schemas" }] },
  { id: "pages", label: "Genesis", subs: [{ id: "pages", label: "Pages" }, { id: "artifacts", label: "Artifacts" }] },
  { id: "hive", label: "Hive", subs: [] },
]

afterEach(() => Panel.reset())

describe("Panel.report / get", () => {
  test("keeps the last report per session, and the newest across sessions when none is named", () => {
    Panel.report({ session: S, open: false })
    Panel.report({ session: S, open: true, tab: "iris", surface: "atlas" })
    Panel.report({ session: "ses_other", open: true, tab: "review" })
    expect(Panel.get(S)).toMatchObject({ open: true, surface: "atlas" })
    expect(Panel.get()?.session).toBe("ses_other")
    expect(Panel.get("ses_missing")).toBeUndefined()
  })

  test("session ids are one path segment", () => {
    expect(Panel.validSession("ses_ab-12")).toBe(true)
    expect(Panel.validSession("../etc")).toBe(false)
    expect(Panel.validSession("")).toBe(false)
    expect(Panel.validSession(42)).toBe(false)
  })
})

describe("Panel.refuse / canonical", () => {
  test("an unknown product or view is refused with the real list, when the desktop sent one", () => {
    expect(Panel.refuse({ action: "show", surface: "crm" }, catalog)).toContain("atlas (Atlas)")
    expect(Panel.refuse({ action: "show", surface: "atlas", sub: "graph" }, catalog)).toContain("lists, schemas")
    expect(Panel.refuse({ action: "show", surface: "atlas", sub: "schemas" }, catalog)).toBeUndefined()
    // A product without views takes any sub — nothing to check it against.
    expect(Panel.refuse({ action: "show", surface: "hive", sub: "x" }, catalog)).toBeUndefined()
  })

  test("without a catalog the command goes through; the desktop's answer is the check", () => {
    expect(Panel.refuse({ action: "show", surface: "crm" }, undefined)).toBeUndefined()
  })

  test("labels resolve to ids — 'Genesis' is the pages product", () => {
    expect(Panel.canonical({ action: "show", surface: "Genesis", sub: "Artifacts" }, catalog)).toEqual({
      action: "show",
      surface: "pages",
      sub: "artifacts",
    })
  })

  test("browse takes http(s) only; tab takes review or context only", () => {
    expect(Panel.refuse({ action: "browse", url: "javascript:alert(1)" }, catalog)).toContain("only http(s)")
    expect(Panel.refuse({ action: "browse", url: "file:///etc/passwd" }, catalog)).toContain("only http(s)")
    expect(Panel.refuse({ action: "browse", url: "not a url" }, catalog)).toContain("not a URL")
    expect(Panel.refuse({ action: "browse", url: "https://heyiris.io" }, catalog)).toBeUndefined()
    expect(Panel.refuse({ action: "tab", tab: "iris" }, catalog)).toContain("review or context")
    expect(Panel.refuse({ action: "tab", tab: "review" }, catalog)).toBeUndefined()
  })
})

describe("Panel.send", () => {
  test("emits iris.panel.command and resolves with the desktop's ack", async () => {
    const seen: GlobalEvent[] = []
    const on = (e: GlobalEvent) => {
      seen.push(e)
      // The desktop: apply, then report with ack.
      const p = e.payload.properties
      queueMicrotask(() => Panel.report({ session: p.session, open: true, tab: "iris", surface: "atlas", ack: p.id }))
    }
    GlobalBus.on("event", on)
    try {
      const after = await Panel.send({ directory: "/w", session: S, command: { action: "show", surface: "atlas" } })
      expect(seen).toHaveLength(1)
      expect(seen[0].directory).toBe("/w")
      expect(seen[0].payload.type).toBe(Panel.COMMAND_EVENT)
      expect(seen[0].payload.properties).toMatchObject({ session: S, command: { action: "show", surface: "atlas" } })
      expect(after).toMatchObject({ open: true, surface: "atlas" })
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("a report WITHOUT the ack does not answer the command", async () => {
    const on = () => queueMicrotask(() => Panel.report({ session: S, open: true }))
    GlobalBus.on("event", on)
    try {
      expect(await Panel.send({ session: S, command: { action: "open" }, timeoutMs: 50 })).toBeUndefined()
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("nobody listening: undefined after the timeout, not a hang", async () => {
    const t = Date.now()
    expect(await Panel.send({ session: S, command: { action: "open" }, timeoutMs: 30 })).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(1000)
  })
})

describe("Panel.describe", () => {
  test("says what is on screen in words, with labels from the catalog", () => {
    const text = Panel.describe(
      {
        session: S,
        open: true,
        tab: "iris",
        tabs: ["review", "iris"],
        surface: "pages",
        sub: "artifacts",
        bloq: { id: 571, name: "MAYO" },
        artifact: "a1",
        catalog,
        received: 1000,
      },
      3000,
    )
    expect(text).toContain("panel: open  (reported 2s ago)")
    expect(text).toContain("product: Genesis › Artifacts  (pages/artifacts)")
    expect(text).toContain("board: MAYO #571")
    expect(text).toContain("artifact selected: a1")
  })

  test("no report is said plainly", () => {
    expect(Panel.describe(undefined)).toContain("No desktop panel has reported")
  })
})
