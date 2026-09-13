import { describe, expect, test } from "bun:test"
import { cellText, detailTabsFor, highlightJson, normalizeSurface, resolvePane, surfaceView } from "./session-iris-tab"

describe("surfaceView", () => {
  test("a failed fetch is never rendered as an empty surface", () => {
    // The whole reason `measured` is on the wire. If either of these returns "empty", the panel
    // starts telling people their board is empty whenever the network is down.
    expect(surfaceView({ loading: false, bloqs: { measured: false, reason: "fl-api 401" } })).toBe("unreachable")
    expect(
      surfaceView({ loading: false, bloqs: { measured: true }, data: { measured: false, reason: "unknown bloq 9" }, rows: [] }),
    ).toBe("surface-error")
  })

  test("an empty surface is only reachable when it was actually measured", () => {
    expect(surfaceView({ loading: false, bloqs: { measured: true }, data: { measured: true }, rows: [] })).toBe("empty")
  })

  test("rows render when there are any", () => {
    expect(surfaceView({ loading: false, bloqs: { measured: true }, data: { measured: true }, rows: [{}] })).toBe("rows")
  })

  test("a PARTIAL answer still renders its rows", () => {
    // agents can load while their scheduled jobs do not: measured=true WITH a reason. That is
    // rows plus a caveat, not an error — dropping to "surface-error" would hide every agent
    // because their schedules were unavailable.
    expect(
      surfaceView({
        loading: false,
        bloqs: { measured: true },
        data: { measured: true, reason: "schedules unavailable (fl-api 502)" },
        rows: [{}, {}],
      }),
    ).toBe("rows")
  })

  test("loading outranks everything — a half-loaded state is not a verdict", () => {
    expect(surfaceView({ loading: true, bloqs: { measured: false } })).toBe("loading")
  })
})

describe("normalizeSurface", () => {
  test("a surface name from an older build does not render a blank panel", () => {
    expect(normalizeSurface("workflows")).toBe("atlas")
    expect(normalizeSurface(null)).toBe("atlas")
    expect(normalizeSurface(undefined)).toBe("atlas")
  })

  test("a known surface survives", () => {
    expect(normalizeSurface("leads")).toBe("leads")
    expect(normalizeSurface("pages")).toBe("pages")
    expect(normalizeSurface("hive")).toBe("hive")
  })
})

describe("resolvePane", () => {
  test("a surface with no sub-views resolves to itself", () => {
    const r = resolvePane("leads", undefined)
    expect(r.sub).toBeUndefined()
    expect(r.pane).toBe("leads")
    expect(r.path(674)).toBe("/iris/leads/674")
  })

  test("the pane and the endpoint come from the SAME sub-view", () => {
    // The failure this prevents: fetch /iris/schemas/674 and draw it with the Atlas renderer,
    // which reads `lists` from a payload whose array is called `schemas`. A full response
    // rendered as an empty board — the shape of bug that reads as "my data is gone".
    const r = resolvePane("atlas", "schemas")
    expect(r.pane).toBe("schemas")
    expect(r.path(674)).toBe("/iris/schemas/674")
  })

  test("no sub-view chosen yet lands on the first one, not on nothing", () => {
    expect(resolvePane("hive", undefined).sub?.id).toBe("machines")
    expect(resolvePane("hive", undefined).path(674)).toBe("/iris/hive")
  })

  test("a sub-view persisted by an older build cannot strand you on a blank pane", () => {
    // localStorage outlives the build that wrote it. "schemas" was a TOP-LEVEL surface before
    // it moved under Atlas, so this exact string is sitting in real installs today.
    expect(resolvePane("hive", "schemas").sub?.id).toBe("machines")
    expect(resolvePane("atlas", "nonsense").pane).toBe("atlas")
  })

  test("agent modes narrow on the SERVER, in the query string", () => {
    // Not a client-side filter over rows already fetched: that leaves the footer counting the
    // unfiltered set, so "12 of 40" sits under nine rows and describes a different set.
    expect(resolvePane("agents", "scheduled").path(674)).toBe("/iris/agents/674?mode=scheduled")
    expect(resolvePane("agents", "ondemand").path(674)).toBe("/iris/agents/674?mode=ondemand")
    // Every agent mode still draws with the agents renderer — same rows, narrower set.
    expect(resolvePane("agents", "ondemand").pane).toBe("agents")
  })

  test("the hive inbox is a different endpoint AND a different renderer", () => {
    const r = resolvePane("hive", "inbox")
    expect(r.pane).toBe("inbox")
    expect(r.path(674)).toBe("/iris/inbox")
  })
})

describe("a held payload from another pane", () => {
  test("is never rendered as an empty answer about the pane on screen", () => {
    // Measured in the browser: Hive › Machines -> Hive › Inbox showed "Nothing in Hive › Inbox"
    // for the length of the fetch. `data.latest` holds the previous payload so the panel does
    // not blink through nothing, which is right when both panes name their rows the same way
    // and a confident lie when they do not — machines arrive as `nodes`, inbox as `items`.
    expect(
      surfaceView({
        loading: false,
        bloqs: { measured: true },
        data: { measured: true },
        rows: [],
        dataPane: "hive",
        pane: "inbox",
      }),
    ).toBe("loading")
  })

  test("an empty answer about the CURRENT pane is still reachable", () => {
    // The guard must not swallow genuine emptiness, or it trades one wrong state for another.
    expect(
      surfaceView({
        loading: false,
        bloqs: { measured: true },
        data: { measured: true },
        rows: [],
        dataPane: "inbox",
        pane: "inbox",
      }),
    ).toBe("empty")
  })
})

describe("detailTabsFor", () => {
  test("info is always present and always first", () => {
    // A detail that opens on a tab with nothing in it reads as broken.
    for (const pane of ["schemas", "pages", "agents", "leads", "hive", "nonsense"]) {
      expect(detailTabsFor(pane)[0].id).toBe("info")
    }
  })

  test("a schema offers its records and a page offers its preview", () => {
    expect(detailTabsFor("schemas").map((t) => t.id)).toContain("records")
    expect(detailTabsFor("pages").map((t) => t.id)).toContain("preview")
    // And not the other way around — a page has no dataset behind it.
    expect(detailTabsFor("pages").map((t) => t.id)).not.toContain("records")
  })
})

describe("cellText", () => {
  test("an absent value is visibly absent, never the word undefined", () => {
    expect(cellText(undefined)).toBe("—")
    expect(cellText(null)).toBe("—")
    expect(cellText("")).toBe("—")
  })

  test("false is a VALUE, not an absence", () => {
    // The bug this exists to prevent: a falsy check renders `false` as "—", so a boolean column
    // shows a blank for every record where the answer is no.
    expect(cellText(false)).toBe("no")
    expect(cellText(0)).toBe("0")
  })
})

describe("highlightJson", () => {
  test("escapes markup before adding its own", () => {
    // The raw view is exactly where hostile-looking content gets inspected, so it is the last
    // place that should execute it.
    const out = highlightJson({ title: "<script>alert(1)</script>" })
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })

  test("a key and a string value are told apart", () => {
    const out = highlightJson({ name: "value" })
    expect(out).toContain("iris-json__key")
    expect(out).toContain("iris-json__str")
  })

  test("null, booleans and numbers each get their own role", () => {
    const out = highlightJson({ a: null, b: true, c: 42 })
    expect(out).toContain("iris-json__null")
    expect(out).toContain("iris-json__bool")
    expect(out).toContain("iris-json__num")
  })

  test("a value that cannot be stringified returns empty rather than throwing", () => {
    const cyclic: any = {}
    cyclic.self = cyclic
    expect(highlightJson(cyclic)).toBe("")
  })
})

describe("detailTabsFor — playbooks", () => {
  test("a playbook offers its steps and its local document", () => {
    const ids = detailTabsFor("playbooks").map((t) => t.id)
    expect(ids).toEqual(["info", "steps", "doc", "json"])
  })
})
