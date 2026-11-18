import { expect, test } from "bun:test"
import { createEffect, createMemo, createRenderEffect, createResource, createSignal, Suspense } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { settled } from "../src/utils/settled"

// #190230: clicking Hive did nothing until the Atlas board had finished downloading.
//
// The mechanism, measured on a preview build before this test was written: the panel reads its
// board, board list and member list with `x.latest ?? x()`. Before a first value, `.latest`
// suspends — so the boundary round the WHOLE panel sat in "Loading…", and Solid holds every
// effect under a suspended boundary. The effect that applies a product-tab click is one of them,
// so the click queued until every one of those requests had returned (each held 4 s in turn →
// Hive waited 4 s each time). Not a transition: removing the transition alone changed nothing.

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function mount(read: (r: any) => any) {
  const host = document.createElement("div")
  document.body.append(host)
  let finishBoard!: (v: { lists: string[] }) => void
  let click!: (s: string) => void
  let applied = "atlas"

  const Panel = () => {
    // The strip writes a request; an effect in the panel applies it (requestedSurface in the tab).
    const [requested, setRequested] = createSignal<string>()
    click = setRequested
    const [surface, setSurface] = createSignal("atlas")
    createEffect(() => {
      const r = requested()
      if (r) setSurface(r)
    })
    createEffect(() => (applied = surface()))
    // The board, still downloading. Read by something always on screen (the header, a memo).
    const [board] = createResource(() => new Promise<{ lists: string[] }>((r) => (finishBoard = r)))
    const header = createMemo(() => read(board)?.lists?.length ?? 0)
    const el = document.createElement("span")
    createRenderEffect(() => (el.textContent = `${surface()}:${header()}`))
    return el
  }

  const dispose = render(
    () =>
      createComponent(Suspense, {
        fallback: "Loading…",
        get children() {
          return createComponent(Panel, {})
        },
      }),
    host,
  )
  return {
    click: (s: string) => click(s),
    finishBoard: (v: { lists: string[] }) => finishBoard(v),
    applied: () => applied,
    text: () => host.textContent,
    dispose,
  }
}

test("the old read holds a tab click until the board arrives (the bug, reproduced)", async () => {
  const p = mount((r) => r.latest ?? r())
  await tick()
  p.click("hive")
  await tick(50)
  const whileBoardLoads = p.applied()
  p.finishBoard({ lists: ["a", "b"] })
  await tick(50)
  const afterBoard = p.applied()
  p.dispose()
  // If this starts failing, Solid stopped holding effects under a suspended boundary — settled()
  // may no longer be needed. Check before deleting it.
  expect(whileBoardLoads).toBe("atlas")
  expect(afterBoard).toBe("hive")
})

test("settled(): a tab click lands while the board is still loading", async () => {
  const p = mount((r) => settled(r))
  await tick()
  p.click("hive")
  await tick(50)
  expect(p.applied()).toBe("hive")
  expect(p.text()).not.toContain("Loading…")
  p.finishBoard({ lists: ["a", "b"] })
  await tick(50)
  p.dispose()
})

test("settled(): the board still renders once it arrives", async () => {
  const p = mount((r) => settled(r))
  await tick()
  p.finishBoard({ lists: ["a", "b"] })
  await tick(50)
  expect(p.text()).toBe("atlas:2")
  p.dispose()
})

test("settled(): an errored resource still throws to the boundary", async () => {
  let threw = false
  const [r] = createResource(async () => {
    throw new Error("Failed to fetch")
  })
  await tick(20)
  try {
    settled(r)
  } catch {
    threw = true
  }
  expect(r.state).toBe("errored")
  expect(threw).toBe(true)
})
