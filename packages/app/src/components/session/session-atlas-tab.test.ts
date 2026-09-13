import { describe, expect, test } from "bun:test"
import { atlasView } from "./session-atlas-tab"

describe("atlasView", () => {
  test("a failed fetch is never rendered as an empty board", () => {
    // The whole reason `measured` is on the wire. If this ever returns "empty", the panel
    // starts telling people their Atlas is empty whenever the network is down.
    expect(atlasView({ loading: false, bloqs: { measured: false, reason: "fl-api 401" } })).toBe("unreachable")
    expect(
      atlasView({ loading: false, bloqs: { measured: true }, atlas: { measured: false, reason: "fl-api 404", lists: [] } }),
    ).toBe("board-error")
  })

  test("an empty board is only reachable when it was actually measured", () => {
    expect(atlasView({ loading: false, bloqs: { measured: true }, atlas: { measured: true, lists: [] } })).toBe("empty")
  })

  test("lists render when there are any", () => {
    expect(atlasView({ loading: false, bloqs: { measured: true }, atlas: { measured: true, lists: [{}] } })).toBe("lists")
  })

  test("loading outranks everything — a half-loaded state is not a verdict", () => {
    expect(atlasView({ loading: true, bloqs: { measured: false } })).toBe("loading")
  })
})
