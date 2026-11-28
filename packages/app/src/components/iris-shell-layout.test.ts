import { describe, expect, test } from "bun:test"
import { IRIS_SHELL_PHONE_QUERY, irisShellPanelLayout } from "./iris-shell-layout"

describe("irisShellPanelLayout", () => {
  test("a phone gets the panel as a full-screen sheet, never beside the page (#194511)", () => {
    // 393 px: the panel used to take its 360 px minimum here and leave Home a 33 px sliver.
    expect(irisShellPanelLayout({ phone: true, row: 393, share: 0.5 })).toEqual({ overlay: true, width: 393 })
    expect(irisShellPanelLayout({ phone: true, row: 393, share: 0.8 })).toEqual({ overlay: true, width: 393 })
  })

  test("a window keeps the side-by-side split it always had", () => {
    expect(irisShellPanelLayout({ phone: false, row: 1500, share: 0.5 })).toEqual({ overlay: false, width: 750 })
    // At least 360 px, at most 80% of the row.
    expect(irisShellPanelLayout({ phone: false, row: 1500, share: 0.8 })).toEqual({ overlay: false, width: 360 })
    expect(irisShellPanelLayout({ phone: false, row: 1000, share: 0.2 })).toEqual({ overlay: false, width: 800 })
    // A tablet at 768 px stays side by side.
    expect(irisShellPanelLayout({ phone: false, row: 768, share: 0.5 })).toEqual({ overlay: false, width: 384 })
  })

  test("the phone query is the app breakpoint (md, 768 px) the titlebar and settings already use", () => {
    expect(IRIS_SHELL_PHONE_QUERY).toBe("(max-width: 767px)")
  })
})
