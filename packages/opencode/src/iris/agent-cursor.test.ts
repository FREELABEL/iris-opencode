/**
 * IRIS's cursor, run in a REAL Chrome: it is drawn, glides to the element, presses, never takes
 * a click from the page, and survives the page re-rendering its body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cursorMoveScript, cursorPressScript } from "./agent-cursor"
import { PageSession, findChrome } from "./browser-driver"

const chrome = await findChrome()
let server: ReturnType<typeof Bun.serve> | undefined
let base = ""
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        `<title>t</title><button data-iris-ref="1" style="position:absolute;left:300px;top:200px;width:120px;height:40px" onclick="document.title='clicked'">Go</button><div style="height:3000px"></div><button data-iris-ref="2" style="margin:20px">Far</button>`,
        { headers: { "content-type": "text/html" } },
      ),
  })
  base = `http://127.0.0.1:${server.port}/`
})
afterAll(() => server?.stop(true))

describe.skipIf(!chrome)("the agent's cursor in a real page", () => {
  test("glides to the element, presses, and the page's own click still works", async () => {
    const p = new PageSession()
    try {
      await p.open(base)
      expect(await p.evaluate<number>(cursorMoveScript(1))).toBeGreaterThanOrEqual(0)
      const pos = await p.evaluate<{ x: number; y: number; on: boolean; pe: string }>(
        `(() => { const s = window.__irisCursor; return { x: s.x, y: s.y, on: s.c.classList.contains('on'), pe: s.host.style.pointerEvents } })()`,
      )
      expect(pos).toEqual({ x: 360, y: 220, on: true, pe: "none" })
      expect(await p.evaluate<boolean>(cursorPressScript())).toBe(true)
      // the cursor is pointer-events:none: the element under it is still the button
      expect(await p.evaluate<string>(`document.elementFromPoint(360, 220).textContent`)).toBe("Go")
      // a second glide is timed by distance
      const d = await p.evaluate<number>(cursorMoveScript(2))
      expect(d).toBeGreaterThanOrEqual(320)
      expect(await p.evaluate<number>(cursorMoveScript(99))).toBe(-1)
      // a page that rebuilds its body gets the cursor back
      await p.evaluate(`document.body.innerHTML = '<button data-iris-ref="3">New</button>'`)
      expect(await p.evaluate<number>(cursorMoveScript(3))).toBeGreaterThanOrEqual(0)
      expect(await p.evaluate<boolean>(`!!document.querySelector('[data-iris-cursor]')`)).toBe(true)
    } finally {
      await p.close()
    }
  }, 60_000)
})
