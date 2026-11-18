import { describe, expect, test } from "bun:test"
import { createStore, reconcile } from "solid-js/store"
import { isServer } from "solid-js/web"
import { closeColumn, open, type PaneRef } from "@/pages/session/split-model"
import { snapshot } from "./split"

// The write context/split.tsx makes, without the persistence around it.
const split = (read: (panes: PaneRef[]) => PaneRef[]) => {
  const [store, setStore] = createStore<{ panes: PaneRef[] }>({ panes: [] })
  return {
    panes: () => read(store.panes),
    set: (panes: PaneRef[]) => setStore("panes", reconcile(snapshot(panes))),
  }
}
const p = (id: string): PaneRef => ({ server: "local", sessionId: id })

describe("split store (#191484)", () => {
  test("closing the focused column focuses its neighbour, as read after the write", () => {
    const s = split(snapshot)
    s.set([p("x"), p("y"), p("z")])
    const next = closeColumn(s.panes(), p("x"), p("x"))
    s.set(next.panes)
    expect(next.focus?.sessionId).toBe("y")
    expect(s.panes().map((q) => q.sessionId)).toEqual(["y", "z"])
  })

  test("inserting beside the focused column keeps every session once", () => {
    const s = split(snapshot)
    s.set([p("x"), p("y")])
    s.set(open(s.panes(), s.panes()[0], p("z")))
    expect(s.panes().map((q) => q.sessionId)).toEqual(["x", "z", "y"])
  })

  // Only the browser build's stores rewrite slots in place; the suite's default (--conditions=solid)
  // resolves the server build, where this cannot happen. Run with --conditions=browser to see it.
  test.skipIf(isServer)("handing out the store's own objects is the bug: the focus moves under the caller", () => {
    const s = split((panes) => panes)
    s.set([p("x"), p("y"), p("z")])
    const next = closeColumn(s.panes(), p("x"), p("x"))
    s.set(next.panes)
    expect(next.focus?.sessionId).toBe("z")
  })
})
