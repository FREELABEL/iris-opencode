import { describe, expect, test } from "bun:test"
import {
  boundsFollower,
  boundsOf,
  nativeBrowserEnabled,
  nextPlacement,
  OVERLAY_SELECTOR,
  QUICK_SITES,
  sameBounds,
} from "./native-browser-model"

describe("boundsOf", () => {
  test("a visible panel body becomes rounded logical pixels", () => {
    expect(boundsOf({ left: 800.4, top: 72.6, width: 640.2, height: 900 })).toEqual({
      x: 800,
      y: 73,
      width: 640,
      height: 900,
    })
  })
  test("the app's zoom scales it", () => {
    expect(boundsOf({ left: 100, top: 50, width: 400, height: 300 }, 1.25)).toEqual({
      x: 125,
      y: 63,
      width: 500,
      height: 375,
    })
  })
  test("a hidden tab (zero size) means hide, not a 1x1 view", () => {
    expect(boundsOf({ left: 0, top: 0, width: 0, height: 0 })).toBeUndefined()
    expect(boundsOf({ left: 10, top: 10, width: 400, height: 0 })).toBeUndefined()
  })
  test("a nonsense zoom is treated as 1", () => {
    expect(boundsOf({ left: 1, top: 1, width: 10, height: 10 }, 0)?.width).toBe(10)
  })
})

test("sameBounds compares by value and treats two absences as equal", () => {
  expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
  expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false)
  expect(sameBounds(undefined, undefined)).toBe(true)
  expect(sameBounds(undefined, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
})

test("the overlay selector covers dialogs, menus and popovers", () => {
  for (const s of ['[role="dialog"]', '[role="menu"]', "[data-popper-positioner]"]) {
    expect(OVERLAY_SELECTOR).toContain(s)
  }
})

test("quick-launch sites are all https", () => {
  for (const s of QUICK_SITES) expect(s.url.startsWith("https://")).toBe(true)
})

describe("nativeBrowserEnabled", () => {
  const store = (v: string | null) => ({ getItem: () => v })
  test("off where the platform has no native browser (web build)", () => {
    expect(nativeBrowserEnabled(store(null), false)).toBe(false)
  })
  test("on by default on desktop, off with iris.browser.native=0", () => {
    expect(nativeBrowserEnabled(store(null), true)).toBe(true)
    expect(nativeBrowserEnabled(store("0"), true)).toBe(false)
  })
  test("storage that throws does not turn it off", () => {
    expect(
      nativeBrowserEnabled(
        {
          getItem: () => {
            throw new Error("denied")
          },
        },
        true,
      ),
    ).toBe(true)
  })
})

describe("boundsFollower (#193405)", () => {
  const rect = (x: number, width = 600) => ({ x, y: 40, width, height: 800 })
  const setup = () => {
    const sent: { b: ReturnType<typeof rect>; seq: number }[] = []
    const pending: (() => void)[] = []
    let seq = 0
    let current = rect(800)
    const f = boundsFollower({
      send: (b, s) => sent.push({ b, seq: s }),
      settle: () => f.follow(current, true),
      next: () => ++seq,
      timers: {
        set: (fn) => pending.push(fn) - 1,
        clear: (h) => (pending[h as number] = () => {}),
      },
    })
    /** Let the quiet time pass: run the one live timer. */
    const quiet = () => {
      const live = pending.splice(0)
      for (const fn of live) fn()
    }
    return { f, sent, quiet, setRect: (b: ReturnType<typeof rect>) => (current = b) }
  }

  test("sends only changes, numbered upward", () => {
    const { f, sent } = setup()
    f.placed(rect(800))
    f.follow(rect(800))
    f.follow(rect(780))
    f.follow(rect(780))
    f.follow(rect(760))
    expect(sent.map((s) => [s.b.x, s.seq])).toEqual([
      [780, 1],
      [760, 2],
    ])
  })

  test("once resizing goes quiet, the current rect is sent again even though it equals the last sent", () => {
    // The ticket's case: the final rect was sent, but a stale mid-drag one landed after it.
    const { f, sent, quiet, setRect } = setup()
    f.placed(rect(800))
    f.follow(rect(700))
    f.follow(rect(640))
    setRect(rect(640))
    quiet()
    expect(sent.map((s) => s.b.x)).toEqual([700, 640, 640])
    expect(sent.at(-1)!.seq).toBeGreaterThan(sent[1].seq)
  })

  test("the settle resend does not arm another one (no loop)", () => {
    const { f, sent, quiet } = setup()
    f.placed(rect(800))
    f.follow(rect(700))
    quiet()
    quiet()
    quiet()
    expect(sent.length).toBe(2)
  })

  test("a window resize with no rect change still re-places once it settles", () => {
    // macOS live resize: the rect was read before layout moved, so nothing looked changed.
    const { f, sent, quiet } = setup()
    f.placed(rect(800))
    f.arm()
    quiet()
    expect(sent.map((s) => s.b.x)).toEqual([800])
  })

  test("stop cancels a pending settle (hidden, covered, unmounted)", () => {
    const { f, sent, quiet } = setup()
    f.placed(rect(800))
    f.follow(rect(700))
    f.stop()
    quiet()
    expect(sent.length).toBe(1)
  })

  test("placement numbers only go up across panes", () => {
    const a = nextPlacement()
    expect(nextPlacement()).toBe(a + 1)
  })
})
