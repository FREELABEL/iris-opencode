import { describe, expect, test } from "bun:test"
import { CONFIRM_TIMEOUT_MS, PanelPage, unpackPageAnswer } from "./panel-page"
import { cursorMoveScript, cursorPressScript } from "./agent-cursor"
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

  test("not allowed yet: it waits for the person's one Allow, then carries on (no second ask)", async () => {
    let allowed = false
    const { sent, page } = desktop(() =>
      allowed
        ? { result: env("feed") }
        : { error: "the person hasn't let IRIS use youtube.com yet. Ask them to click Allow in the Browser bar (it is showing now), then try again" },
    )
    page.allowPollMs = 5
    setTimeout(() => (allowed = true), 30)
    expect(await page.text()).toBe("feed")
    expect(sent.length).toBeGreaterThan(1)
  })

  test("a \"prove you're human\" page: it waits while the person finishes the check, then carries on", async () => {
    let passed = false
    const { sent, page } = desktop(() =>
      passed
        ? { result: env("jobs") }
        : { error: "the site is checking for a human: the person needs to finish the check in the Browser" },
    )
    page.allowPollMs = 5
    setTimeout(() => (passed = true), 30)
    expect(await page.text()).toBe("jobs")
    expect(sent.length).toBeGreaterThan(1)
  })

  test("waiting gives up after its window, and Not now (any other refusal) ends it at once", async () => {
    const never = desktop(() => ({ error: "the person hasn't let IRIS use x.com yet. Ask them to click Allow in the Browser bar (it is showing now), then try again" }))
    never.page.allowPollMs = 5
    never.page.allowWaitMs = 30
    await expect(never.page.text()).rejects.toThrow("click Allow")
    const no = desktop(() => ({ error: "the person chose Not now for x.com. Don't try again unless they ask" }))
    await expect(no.page.text()).rejects.toThrow("Not now")
    expect(no.sent.length).toBe(1)
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

  test("an irreversible click carries its label ONCE, on the click itself, with the long timeout", async () => {
    const sent: { c: Panel.Command; t?: number }[] = []
    const page = new PanelPage(async (c, t) => {
      sent.push({ c, t })
      return outcome({ result: env(true) })
    }, silence)
    page.confirmNext = "Book"
    await page.clickRef(7)
    const acts = sent.filter((x) => x.c.action === "page" && x.c.op === "eval" && x.c.mode === "act")
    const withConfirm = acts.filter((x) => (x.c as { confirm?: string }).confirm === "Book")
    expect(withConfirm.length).toBe(1)
    expect(withConfirm[0]!.t).toBe(CONFIRM_TIMEOUT_MS)
    expect((acts[0]!.c as { doing?: string }).doing).toBe('clicking "Book"')
    expect(page.confirmNext).toBeUndefined()
  })

  test("press on the focused field acts with no cursor, and an Enter that submits carries its label once (#193355)", async () => {
    const sent: { c: Panel.Command; t?: number }[] = []
    const page = new PanelPage(async (c, t) => {
      sent.push({ c, t })
      return outcome({ result: env(true) })
    }, silence)
    page.confirmNext = "Place order"
    expect(await page.pressKey(undefined, "Enter")).toBe(true)
    const acts = sent.filter((x) => x.c.action === "page" && x.c.op === "eval" && x.c.mode === "act")
    expect(acts.length).toBe(sent.length)
    expect(acts.filter((x) => (x.c as { confirm?: string }).confirm === "Place order").length).toBe(1)
    expect((acts[0]!.c as { doing?: string }).doing).toBe('pressing Enter on "Place order"')
    expect(page.confirmNext).toBeUndefined()
  })

  test("IRIS's cursor glides to the element and presses, as reads, before the act", async () => {
    const { sent, page } = desktop(() => ({ result: env(0) }))
    await page.clickRef(4)
    expect(sent[0]).toEqual({ action: "page", op: "eval", script: cursorMoveScript(4), mode: "read" })
    expect(sent[1]).toEqual({ action: "page", op: "eval", script: cursorPressScript(), mode: "read" })
    expect((sent[2] as { mode?: string }).mode).toBe("act")
  })

  test("a cursor that can't be drawn never stops the act", async () => {
    const { sent, page } = desktop((c) =>
      c.action === "page" && c.op === "eval" && c.script.includes("__irisCursor") ? { error: "page threw" } : { result: env(true) },
    )
    expect(await page.clickRef(4)).toBe(true)
    expect(sent.some((c) => c.action === "page" && c.op === "eval" && c.mode === "act")).toBe(true)
  })

  test("a person's Deny reaches the agent and the act fails", async () => {
    const { page } = desktop((c) =>
      c.action === "page" && c.op === "eval" && (c as { confirm?: string }).confirm
        ? { error: 'the person did not allow clicking "Pay"' }
        : { result: env(true) },
    )
    page.confirmNext = "Pay"
    expect(page.clickRef(2)).rejects.toThrow("did not allow")
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

describe("PanelPage.screenshot (the agent's eyes on maps and charts)", () => {
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64")
  test("asks the pane for a picture and decodes it", async () => {
    const sent: Panel.Command[] = []
    const page = new PanelPage(async (c) => (sent.push(c), outcome({ result: env(fakeJpeg) })), silence)
    const img = await page.screenshot()
    expect(sent[0]).toEqual({ action: "page", op: "screenshot" })
    expect([...img.slice(0, 2)]).toEqual([0xff, 0xd8])
  })
  test("waits for the person's Allow like reading does", async () => {
    let allowed = false
    const page = new PanelPage(
      async () =>
        outcome(
          allowed
            ? { result: env(fakeJpeg) }
            : { error: "the person hasn't let IRIS use maps.google.com yet. Ask them to click Allow in the Browser bar (it is showing now), then try again" },
        ),
      silence,
    )
    page.allowPollMs = 5
    setTimeout(() => (allowed = true), 25)
    expect((await page.screenshot()).length).toBe(7)
  })
})
