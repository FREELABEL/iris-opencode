import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { paneParams } from "./session-pane"

const route = { serverKey: "route-server", id: "ses_route", dir: "cm91dGU", extra: "kept" }

describe("paneParams (#191484)", () => {
  test("outside a pane, the URL answers — one column reads what it always read", () => {
    expect(paneParams(route, undefined)).toBe(route)
  })

  test("inside a pane, the pane's session answers, reactively; other params still come from the URL", () => {
    const [id, setId] = createSignal("ses_left")
    const params = paneParams(route, {
      params: () => ({ serverKey: "pane-server", id: id() }),
      focused: () => false,
      focus() {},
    })
    expect(params.id).toBe("ses_left")
    expect(params.serverKey).toBe("pane-server")
    expect(params.dir).toBeUndefined()
    expect(params.extra).toBe("kept")
    setId("ses_right")
    expect(params.id).toBe("ses_right")
  })
})
