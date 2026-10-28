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
      const after = (await Panel.send({ directory: "/w", session: S, command: { action: "show", surface: "atlas" } })).state
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
      expect((await Panel.send({ session: S, command: { action: "open" }, timeoutMs: 50 })).state).toBeUndefined()
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("nobody listening: undefined after the timeout, not a hang", async () => {
    const t = Date.now()
    expect((await Panel.send({ session: S, command: { action: "open" }, timeoutMs: 30 })).state).toBeUndefined()
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

// #191506 — a lost message, either way, used to read as "the user is not looking".
describe("Panel.send — re-sent until answered (#191506)", () => {
  test("a command the desktop never got is re-sent under the SAME id, and the answer to the re-send counts", async () => {
    const ids: string[] = []
    const on = (e: GlobalEvent) => {
      if (e.payload?.type !== Panel.COMMAND_EVENT) return
      ids.push(e.payload.properties.id)
      // The first one is lost on the way; the desktop only ever sees the re-send.
      if (ids.length < 2) return
      const p = e.payload.properties
      queueMicrotask(() => Panel.report({ session: p.session, open: true, tab: "web", ack: p.id }))
    }
    GlobalBus.on("event", on)
    try {
      const out = await Panel.send({ session: S, command: { action: "browse", url: "https://heyiris.io" }, timeoutMs: 1000, resendMs: 40 })
      expect(out.state).toMatchObject({ tab: "web" })
      expect(out.attempts).toBe(2)
      expect(new Set(ids).size).toBe(1)
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("re-sending stops once answered", async () => {
    let n = 0
    const on = (e: GlobalEvent) => {
      if (e.payload?.type !== Panel.COMMAND_EVENT) return
      n++
      const p = e.payload.properties
      queueMicrotask(() => Panel.report({ session: p.session, open: true, ack: p.id }))
    }
    GlobalBus.on("event", on)
    try {
      await Panel.send({ session: S, command: { action: "open" }, timeoutMs: 500, resendMs: 20 })
      await new Promise((r) => setTimeout(r, 100))
      expect(n).toBe(1)
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("an unanswered command says how long it waited, how often it was sent, and what was heard meanwhile", async () => {
    const on = (e: GlobalEvent) => {
      if (e.payload?.type !== Panel.COMMAND_EVENT) return
      // The desktop is alive and reporting, but its answer to the command never arrives.
      queueMicrotask(() => Panel.report({ session: S, open: true, tab: "web" }))
    }
    GlobalBus.on("event", on)
    Panel.streamOpened()
    try {
      const out = await Panel.send({ session: S, command: { action: "open" }, timeoutMs: 120, resendMs: 50 })
      expect(out.state).toBeUndefined()
      expect(out.attempts).toBeGreaterThanOrEqual(2)
      expect(out.elapsedMs).toBeGreaterThanOrEqual(100)
      expect(out.streams).toBe(1)
      expect(out.heard).toMatchObject({ tab: "web" })
    } finally {
      GlobalBus.off("event", on)
    }
  })
})

describe("Panel.explainSilence — facts, not a guess about the user (#191506)", () => {
  const base: Panel.Outcome = { elapsedMs: 12_000, attempts: 4, streams: 1 }

  test("a connected desktop that did not answer is a failed round trip, never 'the user is not looking'", () => {
    Panel.report({ session: S, open: true })
    const text = Panel.explainSilence(base, S, Date.now() + 63_000)
    expect(text).toContain("did not answer within 12s (sent 4 times)")
    expect(text).toContain("last reported 63s ago")
    expect(text).toContain("not evidence the user is away")
    expect(text).not.toContain("not looking")
  })

  test("only when NO event stream is open does it say no desktop can see it", () => {
    expect(Panel.explainSilence({ ...base, streams: 0 }, S)).toContain("No IRIS Desktop is connected")
    expect(Panel.explainSilence(base, S)).not.toContain("No IRIS Desktop is connected")
  })

  test("a report heard during the wait is named", () => {
    const heard = Panel.report({ session: S, open: true })
    expect(Panel.explainSilence({ ...base, heard }, S, heard.received + 2000)).toContain("reported this session's panel 2s ago")
  })

  test("a newer report from another session is pointed out — the one positive sign the user is elsewhere", () => {
    Panel.report({ session: S, open: true })
    Panel.report({ session: "ses_other", open: true })
    expect(Panel.explainSilence(base, S)).toContain("another session, ses_other")
  })

  test("the stream count follows open and close", () => {
    Panel.streamOpened()
    Panel.streamOpened()
    Panel.streamClosed()
    expect(Panel.openStreams()).toBe(1)
    Panel.streamClosed()
    Panel.streamClosed()
    expect(Panel.openStreams()).toBe(0)
  })
})

// #191507 — opening a specific Atlas card.
describe("card (#191507)", () => {
  test("needs a board and a card, as positive ids", () => {
    expect(Panel.refuse({ action: "card", bloq: 628, item: 191504 }, catalog)).toBeUndefined()
    expect(Panel.refuse({ action: "card", bloq: 628, item: 191504, list: 2180 }, catalog)).toBeUndefined()
    expect(Panel.refuse({ action: "card", bloq: 0, item: 191504 }, catalog)).toContain("bloq")
    expect(Panel.refuse({ action: "card", bloq: 628, item: 1.5 }, catalog)).toContain("item")
    expect(Panel.refuse({ action: "card", bloq: 628, item: 1, list: -2 }, catalog)).toContain("list")
  })

  test("a card id passed as a view is refused WITH the way to open a card", () => {
    expect(Panel.refuse({ action: "show", surface: "atlas", sub: "191504" }, catalog)).toContain('use action "card"')
    expect(Panel.refuse({ action: "show", surface: "atlas", sub: "graph" }, catalog)).not.toContain("card")
  })

  test("the web link is the app's own deep link", () => {
    expect(Panel.cardLink({ bloq: 628, item: 191504, list: 2180 })).toBe("https://heyiris.io/atlas?project=628&row=2180&card=191504")
    expect(Panel.cardLink({ bloq: 628, item: 191504 })).toBe("https://heyiris.io/atlas?project=628&card=191504")
  })

  test("the open card is described", () => {
    const text = Panel.describe({ session: S, open: true, tab: "iris", surface: "atlas", card: { id: 191504, bloq: 628 }, received: 0 }, 0)
    expect(text).toContain("card open: #191504 on board #628")
  })
})
