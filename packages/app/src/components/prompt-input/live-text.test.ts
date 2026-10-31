import { describe, expect, test } from "bun:test"
// Lives in session-ui's composer; tested here because this package has a DOM (happydom.ts preload).
import { caretAtEnd, caretToEnd, closeLiveSegment, settleLiveText, writeLiveText, type LiveRegion } from "@opencode-ai/session-ui/v2/prompt-input/live-text"

const editorWith = (text = "") => {
  const editor = document.createElement("div")
  if (text) editor.appendChild(document.createTextNode(text))
  return editor
}

const write = (editor: HTMLElement, region: LiveRegion | undefined, text: string | undefined) =>
  writeLiveText(editor, region, text).region

describe("live dictation in the chat box", () => {
  test("words appear as they are spoken, rewritten in place — one text node, not one per partial", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "what's on")
    region = write(editor, region, "what's on my calendar")
    region = write(editor, region, "what's on my calendar tomorrow")
    expect(editor.childNodes).toHaveLength(1)
    expect(editor.textContent).toBe("what's on my calendar tomorrow")
  })

  test("the words are the editor's real text, not a preview element (#189543)", () => {
    const editor = editorWith()
    write(editor, undefined, "I need to build a shopping list")
    // A plain text node is what the prompt parser reads, so the prompt has a value: no placeholder,
    // the editor's own colour, Send enabled — and Send sends exactly this.
    expect(editor.firstChild).toBeInstanceOf(Text)
    expect(editor.querySelector("[data-slot]")).toBeNull()
  })

  test("writing reports a change only when the text changed, so input fires once per update", () => {
    const editor = editorWith()
    const first = writeLiveText(editor, undefined, "hello")
    expect(first.changed).toBe(true)
    expect(writeLiveText(editor, first.region, "hello").changed).toBe(false)
  })

  test("after text already typed, the take is separated by a space", () => {
    const editor = editorWith("Hey TOBI,")
    write(editor, undefined, "add a note")
    expect(editor.textContent).toBe("Hey TOBI, add a note")
  })

  test("undefined takes the words back out, and leaves the typed text alone", () => {
    const editor = editorWith("keep me")
    const region = write(editor, undefined, "gone soon")
    expect(write(editor, region, undefined)).toBeUndefined()
    expect(editor.textContent).toBe("keep me")
  })

  test("the final transcript replaces the live words — the take appears once", () => {
    const editor = editorWith("Note:")
    const region = write(editor, undefined, "I need to build a shopping")
    expect(settleLiveText(editor, region, "I need to build a shopping list.")).toBe(true)
    expect(editor.textContent).toBe("Note: I need to build a shopping list.")
  })

  test("with no live words, the final transcript is appended", () => {
    const editor = editorWith("Hello")
    expect(settleLiveText(editor, undefined, "world")).toBe(true)
    expect(editor.textContent).toBe("Hello world")
  })

  test("a DOM rebuild from the prompt keeps the words: they are found again, not written twice", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "first words")!
    // What the composer does when the prompt changes from outside: same text, new nodes.
    editor.replaceChildren(document.createTextNode("first words"))
    const next = write(editor, region, "first words and more")
    expect(next?.touched).toBe(false)
    expect(editor.textContent).toBe("first words and more")
  })

  test("an empty update (a partial taken back) leaves the words on screen", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "hello there")
    expect(writeLiveText(editor, region, "")).toEqual({ region, changed: false })
    expect(editor.textContent).toBe("hello there")
  })
})

describe("a take is segments: editing mid-take (#191998, specs/voice/standard.md rule 2)", () => {
  test("the edit is kept, and words said after it still arrive after it", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy oatmilk today" // typed mid-take
    region = write(editor, region, "buy oat milk and call")!
    expect(editor.textContent).toBe("buy oatmilk today and call")
    region = write(editor, region, "buy oat milk and call the plumber at noon")!
    expect(editor.textContent).toBe("buy oatmilk today and call the plumber at noon")
  })

  test("the final transcript keeps the edit and places only the words after it", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy oatmilk"
    region = write(editor, region, "buy oat milk and call the plumber")!
    expect(settleLiveText(editor, region, "Buy oat milk, and call the plumber at noon.")).toBe(true)
    expect(editor.textContent).toBe("buy oatmilk and call the plumber at noon.")
  })

  test("edited with no live words since: the final's later words are appended", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy oatmilk"
    expect(settleLiveText(editor, region, "Buy oat milk and call the plumber at noon.")).toBe(true)
    expect(editor.textContent).toBe("buy oatmilk and call the plumber at noon.")
  })

  test("an edit that says everything the final does adds nothing, and is not overwritten", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy OAT MILK!"
    expect(settleLiveText(editor, region, "Buy oat milk.")).toBe(false)
    expect(editor.textContent).toBe("buy OAT MILK!")
  })

  test("a second edit, on the words after the first, is kept the same way", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "one two")!
    region.node!.data = "ONE two"
    region = write(editor, region, "one two three four")!
    region.node!.data = " THREE four"
    region = write(editor, region, "one two three four five")!
    expect(editor.textContent).toBe("ONE two THREE four five")
  })

  test("a final that does not line up keeps what is on screen", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy oatmilk"
    expect(settleLiveText(editor, region, "completely different words were heard here")).toBe(false)
    expect(editor.textContent).toBe("buy oatmilk")
  })
})

describe("a take is segments: Send mid-take", () => {
  // Send clears the composer; the take keeps recording.
  const send = (editor: HTMLElement) => editor.replaceChildren()

  test("words said after Send become a new draft, without the words already sent", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "send this")!
    send(editor)
    region = write(editor, region, "send this now and then the rest")!
    expect(editor.textContent).toBe("now and then the rest")
  })

  test("the final transcript settles the new draft, and sends nothing twice", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "send this")!
    send(editor)
    region = write(editor, region, "send this and then the res")!
    expect(settleLiveText(editor, region, "Send this. And then the rest.")).toBe(true)
    expect(editor.textContent).toBe("And then the rest.")
  })

  test("words only the final transcript caught are still put in the draft", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "send this")!
    send(editor)
    expect(settleLiveText(editor, region, "Send this, and one more thing.")).toBe(true)
    expect(editor.textContent).toBe("and one more thing.")
  })

  test("nothing said after Send: the composer stays empty", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "send this")!
    send(editor)
    expect(settleLiveText(editor, region, "Send this.")).toBe(false)
    expect(editor.textContent).toBe("")
  })

  test("a second Send mid-take sends only what was new", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "first")!
    send(editor)
    region = write(editor, region, "first second")!
    expect(editor.textContent).toBe("second")
    send(editor)
    region = write(editor, region, "first second third")!
    expect(editor.textContent).toBe("third")
  })

  test("a final that does not line up after Send keeps the live draft", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "send this")!
    send(editor)
    region = write(editor, region, "send this and more")!
    expect(settleLiveText(editor, region, "nothing like the live words at all")).toBe(false)
    expect(editor.textContent).toBe("and more")
  })

  test("taking the words back out removes only what is still the take's", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "kept by the person")!
    region.node!.data = "kept by me"
    region = write(editor, region, "kept by the person and later words")!
    expect(write(editor, region, undefined)).toBeUndefined()
    expect(editor.textContent).toBe("kept by me")
  })
})

describe("the deleted text stays gone (#191998)", () => {
  // Alex's report: start talking, delete the text, talk again; Stop brought it all back.
  const del = (editor: HTMLElement, region: LiveRegion) => (editor.replaceChildren(), closeLiveSegment(region))

  test("delete everything, talk, Stop: only the words after the delete", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "my secret first thought")!
    region = del(editor, region)
    region = write(editor, region, "my secret first thought and the real message")!
    expect(editor.textContent).toBe("and the real message")
    settleLiveText(editor, region, "My secret first thought, and the real message.")
    expect(editor.textContent).toBe("and the real message.")
  })

  test("delete everything, nothing said after: the box stays empty", () => {
    const editor = editorWith()
    const region = del(editor, write(editor, undefined, "my secret first thought")!)
    expect(settleLiveText(editor, region, "My secret first thought.")).toBe(false)
    expect(editor.textContent).toBe("")
  })

  test("a repeated phrase refines the newest copy, never the deleted one", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "call me")!
    region = del(editor, region)
    region = write(editor, region, "call me call me")!
    settleLiveText(editor, region, "Call me. Call me!")
    expect(editor.textContent).toBe("Call me!")
  })

  test("too few of the words line up: what is on screen stays", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "first")!
    region = del(editor, region)
    region = write(editor, region, "first buy oat milk")!
    expect(settleLiveText(editor, region, "First we talked about milk and more.")).toBe(false)
    expect(editor.textContent).toBe("buy oat milk")
  })

  test("a lone common word does not drag the rest of the recording back in", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "the private plan for the merger is off")!
    region = del(editor, region)
    region = write(editor, region, "the private plan for the merger is off the")!
    expect(settleLiveText(editor, region, "The private plan, for the merger, is off. The next thing I said went on for a while.")).toBe(false)
    expect(editor.textContent).toBe("the")
  })

  test("a revised first word still refines", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "gone")!
    region = del(editor, region)
    region = write(editor, region, "gone by oat milk")!
    settleLiveText(editor, region, "Gone. Buy oat milk.")
    expect(editor.textContent).toBe("Buy oat milk.")
  })

  test("an edit closes the segment even when the words are untouched: an edit anywhere counts", () => {
    const editor = editorWith("draft")
    let region = write(editor, undefined, "one two")!
    region = closeLiveSegment(region)
    region = write(editor, region, "one two three")!
    expect(editor.textContent).toBe("draft one two three")
    settleLiveText(editor, region, "One, two, three.")
    expect(editor.textContent).toBe("draft one two three.")
  })
})

describe("the caret during a take (#191998)", () => {
  const mounted = (text = "") => {
    const editor = editorWith(text)
    editor.contentEditable = "true"
    document.body.appendChild(editor)
    return editor
  }
  const caretAt = (node: Node, offset: number) => {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }

  test("at the end when words arrive: it follows them", () => {
    const editor = mounted()
    caretToEnd(editor)
    let region = write(editor, undefined, "one")
    expect(caretAtEnd(editor)).toBe(true)
    region = write(editor, region, "one two three")
    expect(caretAtEnd(editor)).toBe(true)
    editor.remove()
  })

  test("moved earlier: it stays, and new words still go at the end", () => {
    const editor = mounted("typed before")
    const typed = editor.firstChild!
    caretAt(typed, 3)
    write(editor, undefined, "live words")
    expect(editor.textContent).toBe("typed before live words")
    const selection = window.getSelection()!
    expect(selection.anchorNode === typed).toBe(true)
    expect(selection.anchorOffset).toBe(3)
    editor.remove()
  })

  test("moved inside the open words: a rewrite does not throw it to their start", () => {
    const editor = mounted()
    const region = write(editor, undefined, "one two")!
    caretAt(region.node!, 4)
    write(editor, region, "one two three")
    expect(window.getSelection()!.anchorOffset).toBe(4)
    editor.remove()
  })

  test("back at the end: it follows again", () => {
    const editor = mounted("typed")
    caretAt(editor.firstChild!, 2)
    let region = write(editor, undefined, "one")
    caretToEnd(editor)
    region = write(editor, region, "one two")
    expect(caretAtEnd(editor)).toBe(true)
    editor.remove()
  })
})
