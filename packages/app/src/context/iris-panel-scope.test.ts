import { describe, expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { IrisPanelScopeProvider, LAST_BLOQ_KEY, readLastBloq, useIrisPanelScope } from "./iris-panel-scope"

describe("the panel's chosen project (#193407)", () => {
  test("is read from the remembered key, and nothing is undefined", () => {
    localStorage.setItem(LAST_BLOQ_KEY, "674")
    expect(readLastBloq()).toBe(674)
    localStorage.setItem(LAST_BLOQ_KEY, "nope")
    expect(readLastBloq()).toBeUndefined()
    localStorage.removeItem(LAST_BLOQ_KEY)
    expect(readLastBloq()).toBeUndefined()
  })

  test("two IRIS tabs in one scope see the same project — a pick in one is the other's", () => {
    createRoot((dispose) => {
      const a = useIrisPanelScope()
      const b = useIrisPanelScope()
      a.setBloq(202)
      expect(b.bloq()).toBe(202)
      b.setBloq(303)
      expect(a.bloq()).toBe(303)
      dispose()
    })
  })

  test("a split column starts on the window's project, then keeps its own", () => {
    createRoot((dispose) => {
      const win = useIrisPanelScope()
      win.setBloq(101)
      let col: ReturnType<typeof useIrisPanelScope> | undefined
      createComponent(IrisPanelScopeProvider, {
        get children() {
          col = useIrisPanelScope()
          return null
        },
      })
      expect(col!.bloq()).toBe(101)
      col!.setBloq(202)
      expect(win.bloq()).toBe(101)
      dispose()
    })
  })
})
