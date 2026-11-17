import { describe, expect, test } from "bun:test"
import { tidyBubbleSegments } from "./bubble-text"

// #193703 — returns typed after the last word showed as a block of dead space in the bubble.
describe("the text in a sent message's bubble", () => {
  test("the reported message: blank lines after the link are gone, the gap between the lines stays", () => {
    const out = tidyBubbleSegments([
      { text: "this needs to be the official UI for IRIS DRIVES\n\nhttps://heyiris.io/p/iris-drives-files\n\n\n\n" },
    ])
    expect(out).toEqual([{ text: "this needs to be the official UI for IRIS DRIVES\n\nhttps://heyiris.io/p/iris-drives-files" }])
  })

  test("blank lines before the first word go; the first line keeps its indent", () => {
    expect(tidyBubbleSegments([{ text: "\n \n  indented\nnext" }])).toEqual([{ text: "  indented\nnext" }])
  })

  test("a run of blank lines inside the message shows as one", () => {
    expect(tidyBubbleSegments([{ text: "a\n\n\n\n\nb" }])).toEqual([{ text: "a\n\nb" }])
  })

  test("a mention is never trimmed, and empty text around it is dropped", () => {
    const out = tidyBubbleSegments([{ text: "\n\n" }, { text: "@notes.md", type: "file" }, { text: " \n\n" }])
    expect(out).toEqual([{ text: "@notes.md", type: "file" }])
  })

  test("text between two mentions keeps its spaces", () => {
    const out = tidyBubbleSegments([
      { text: "@a.md", type: "file" },
      { text: " and " },
      { text: "@b.md", type: "file" },
    ])
    expect(out.map((s) => s.text).join("")).toBe("@a.md and @b.md")
  })

  test("only whitespace shows nothing", () => {
    expect(tidyBubbleSegments([{ text: "\n \n" }])).toEqual([])
  })
})
