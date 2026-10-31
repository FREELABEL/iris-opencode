import { describe, expect, test } from "bun:test"
import { slideCards } from "./iris-board-motion"

/*
 * The test DOM does no layout, so each card reports a position from its place in the column
 * (50px a card) — the same thing a browser's layout would say for equal-height cards — and keeps
 * the animations it was asked to play.
 */
function column(ids: string[]) {
  const root = document.createElement("div")
  const played = new Map<string, Keyframe[]>()
  for (const id of ids) {
    const el = document.createElement("div")
    el.dataset.boardCard = id
    el.getBoundingClientRect = () => {
      const top = Array.from(root.children).indexOf(el) * 50
      return { top, left: 0, bottom: top + 40, right: 200, width: 200, height: 40, x: 0, y: top, toJSON() {} } as DOMRect
    }
    Object.assign(el, { animate: (frames: Keyframe[]) => played.set(id, frames) })
    root.append(el)
  }
  return { root, played, card: (id: string) => root.querySelector<HTMLElement>(`[data-board-card="${id}"]`)! }
}

describe("board motion — cards slide, not jump", () => {
  test("a card moving up plays from where it was", () => {
    const c = column(["a", "b", "c"])
    slideCards(c.root, () => c.card("a").remove())
    // b was at 50, now at 0: it starts 50px down and slides up
    expect(c.played.get("b")?.[0]).toEqual({ transform: "translate(0px, 50px)" })
    expect(c.played.get("c")?.[0]).toEqual({ transform: "translate(0px, 50px)" })
    expect(c.played.get("b")?.[1]).toEqual({ transform: "translate(0, 0)" })
  })

  test("a placeholder opening above a card pushes it down", () => {
    const c = column(["a", "b"])
    const ghost = document.createElement("div")
    slideCards(c.root, () => c.root.insertBefore(ghost, c.card("a")))
    expect(c.played.get("a")?.[0]).toEqual({ transform: "translate(0px, -50px)" })
    expect(c.played.get("b")?.[0]).toEqual({ transform: "translate(0px, -50px)" })
  })

  test("cards that did not move are left alone", () => {
    const c = column(["a", "b", "c"])
    slideCards(c.root, () => c.root.append(document.createElement("div")))
    expect(c.played.size).toBe(0)
  })

  test("the change always happens — with no board, and under reduced motion", () => {
    let ran = 0
    slideCards(undefined, () => ran++)
    expect(ran).toBe(1)

    const c = column(["a", "b"])
    const real = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({ matches: q.includes("reduce") }) as MediaQueryList) as typeof matchMedia
    try {
      slideCards(c.root, () => c.card("a").remove())
    } finally {
      globalThis.matchMedia = real
    }
    expect(c.root.children.length).toBe(1)
    expect(c.played.size).toBe(0)
  })
})
