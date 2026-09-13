import { describe, expect, test } from "bun:test"
import { normalizeSurface, surfaceView } from "./session-iris-tab"

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
  })
})
