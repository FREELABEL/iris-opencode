import { describe, expect, test } from "bun:test"
import { nextSpeakable, speakable } from "./speakable"

describe("speakable", () => {
  test("strips markdown formatting but keeps the words", () => {
    expect(speakable("## Done\n\n**Saved** to your *Pathways* board — see [the board](https://x.y/b).")).toBe(
      "Done Saved to your Pathways board — see the board.",
    )
  })

  test("skips code blocks instead of reading them, keeps inline code words", () => {
    expect(speakable("Run `bun typecheck` first:\n```sh\nbun typecheck\ncd app\n```\nThen it passes.")).toBe(
      "Run bun typecheck first: Then it passes.",
    )
  })

  test("lists, quotes and bare URLs read cleanly", () => {
    expect(speakable("- one\n- two\n1. three\n> quoted\nhttps://example.com/x")).toBe("one two three quoted link")
  })

  test("tables become comma-separated cells, not pipes", () => {
    expect(speakable("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(", a , b , , 1 , 2 ,")
  })
})

describe("nextSpeakable", () => {
  test("releases only complete sentences while streaming", () => {
    const raw = "First sentence. Second is still being wri"
    const a = nextSpeakable(raw, 0, false)
    expect(a.text).toBe("First sentence.")
    expect(raw.slice(a.consumed)).toBe(" Second is still being wri")
    // Nothing new until the sentence ends.
    expect(nextSpeakable(raw, a.consumed, false).text).toBe("")
  })

  test("the rest goes when the reply is final", () => {
    const raw = "First sentence. And the end"
    const a = nextSpeakable(raw, 0, false)
    expect(nextSpeakable(raw, a.consumed, true).text).toBe("And the end")
  })

  test("never releases text inside an unfinished code fence", () => {
    const raw = "Here is the fix. ```ts\nconst a = 1. const b = 2. "
    const a = nextSpeakable(raw, 0, false)
    expect(a.text).toBe("Here is the fix.")
    expect(nextSpeakable(raw, a.consumed, false).text).toBe("")
  })

  test("after the fence closes, the sentences after it are spoken and the code is not", () => {
    const open = "Fix. ```ts\nx = 1. y = 2."
    const a = nextSpeakable(open, 0, false)
    expect(a.text).toBe("Fix.")
    const raw = open + "\n``` That's it. Done"
    const b = nextSpeakable(raw, a.consumed, false)
    expect(b.text).toBe("That's it.")
    expect(nextSpeakable(raw, b.consumed, true).text).toBe("Done")
  })

  test("streaming in pieces says every word exactly once", () => {
    const full = "One. Two is longer. Three!\n\nFour"
    let consumed = 0
    const said: string[] = []
    for (let n = 1; n <= full.length; n++) {
      const r = nextSpeakable(full.slice(0, n), consumed, false)
      if (r.text) said.push(r.text)
      consumed = r.consumed
    }
    const last = nextSpeakable(full, consumed, true)
    if (last.text) said.push(last.text)
    expect(said.join(" ")).toBe("One. Two is longer. Three! Four")
  })
})
