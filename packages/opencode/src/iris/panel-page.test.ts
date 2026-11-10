import { describe, expect, test } from "bun:test"
import { PanelPage, unpackPageAnswer } from "./panel-page"
import type { Panel } from "./panel"

const outcome = (state?: Partial<Panel.Stored>): Panel.Outcome => ({
  state: state ? ({ session: "s", open: true, received: 1, ...state } as Panel.Stored) : undefined,
  elapsedMs: 10,
  attempts: 1,
  streams: 1,
})
const silence = () => "no desktop answered"
const env = (value: unknown) => JSON.stringify({ ok: true, value })

describe("unpackPageAnswer", () => {
  test("a result envelope becomes its value", () => {
    expect(unpackPageAnswer(outcome({ result: env("hello") }), silence)).toBe("hello")
    expect(unpackPageAnswer(outcome({ result: env([{ ref: 1 }]) }), silence)).toEqual([{ ref: 1 }])
  })
  test("the app's refusal (no grant) reaches the agent word for word", () => {
    expect(() => unpackPageAnswer(outcome({ error: "the person hasn't let IRIS use x.com" }), silence)).toThrow(
      "hasn't let IRIS use x.com",
    )
  })
  test("no answer at all is explained, not guessed", () => {
    expect(() => unpackPageAnswer(outcome(undefined), silence)).toThrow("no desktop answered")
  })
  test("an older desktop that acks without a result says so", () => {
    expect(() => unpackPageAnswer(outcome({}), silence)).toThrow("no Browser pane yet")
  })
  test("a script that threw in the page", () => {
    expect(() => unpackPageAnswer(outcome({ result: JSON.stringify({ ok: false, error: "boom" }) }), silence)).toThrow(
      "the page script failed: boom",
    )
  })
})

describe("PanelPage", () => {
  // A fake desktop that runs nothing: it records what was sent and answers from a table.
  const desktop = (answer: (c: Panel.Command) => Partial<Panel.Stored>) => {
    const sent: Panel.Command[] = []
    const send = async (c: Panel.Command) => {
      sent.push(c)
      return outcome(answer(c))
    }
    return { sent, page: new PanelPage(send, silence) }
  }

  test("reading the person's page sends the SAME script the CDP target runs, as read", async () => {
    const { sent, page } = desktop(() => ({ result: env("page text") }))
    expect(await page.text()).toBe("page text")
    expect(sent[0]).toEqual({ action: "page", op: "eval", script: "document.body ? document.body.innerText : ''", mode: "read" })
  })

  test("attach learns where the pane is", async () => {
    const { page } = desktop(() => ({ result: env("https://www.youtube.com/") }))
    expect(await page.attach()).toBe("https://www.youtube.com/")
    expect(page.currentUrl).toBe("https://www.youtube.com/")
  })

  test("the three verbs that act go out as act, and reading goes back to read", async () => {
    const { sent, page } = desktop(() => ({ result: env(true) }))
    await page.typeRef(3, "tokyo")
    await page.text()
    expect(sent.filter((c) => c.action === "page" && c.op === "eval" && c.mode === "act").length).toBeGreaterThan(0)
    expect((sent.at(-1) as { mode: string }).mode).toBe("read")
  })

  test("an act refused by the app fails the verb (the app is the gate, not the tool)", async () => {
    const { page } = desktop((c) =>
      c.action === "page" && c.op === "eval" && c.mode === "act" ? { error: "it can only read" } : { result: env(true) },
    )
    expect(page.clickRef(1)).rejects.toThrow("it can only read")
  })

  test("open asks the pane to navigate and reports where it landed", async () => {
    const { sent, page } = desktop(() => ({ result: env({ url: "https://x.com/home", title: "Home / X" }) }))
    expect(await page.open("https://x.com")).toEqual({ url: "https://x.com/home", title: "Home / X", status: "ok" })
    expect(sent[0]).toEqual({ action: "page", op: "open", url: "https://x.com" })
  })

  test("close leaves the person's page alone", async () => {
    const { sent, page } = desktop(() => ({ result: env("https://x.com/") }))
    await page.attach()
    await page.close()
    expect(sent.length).toBe(1)
    expect(page.currentUrl).toBeNull()
  })
})
