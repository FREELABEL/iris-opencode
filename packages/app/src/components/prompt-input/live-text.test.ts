import { describe, expect, test } from "bun:test"
// Lives in session-ui's composer; tested here because this package has a DOM (happydom.ts preload).
import { settleLiveText, wordsAfter, writeLiveText, type LiveRegion } from "@opencode-ai/session-ui/v2/prompt-input/live-text"

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
    expect(settleLiveText(editor, region, "I need to build a shopping list.")).toEqual({ changed: true, held: false })
    expect(editor.textContent).toBe("Note: I need to build a shopping list.")
  })

  test("with no live words, the final transcript is appended", () => {
    const editor = editorWith("Hello")
    expect(settleLiveText(editor, undefined, "world").changed).toBe(true)
    expect(editor.textContent).toBe("Hello world")
  })

  test("a DOM rebuild from the prompt keeps the words: they are found again, not written twice", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "first words")!
    // What the composer does when the prompt changes from outside: same text, new nodes.
    editor.replaceChildren(document.createTextNode("first words"))
    const next = write(editor, region, "first words and more")
    expect(next?.handed).toBeUndefined()
    expect(editor.textContent).toBe("first words and more")
  })

  test("an empty update (a partial taken back) leaves the words on screen", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "hello there")
    expect(writeLiveText(editor, region, "")).toEqual({ region, changed: false })
    expect(editor.textContent).toBe("hello there")
  })
})

describe("nothing said is lost: editing mid-take (specs/voice/standard.md rule 2)", () => {
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
    expect(settleLiveText(editor, region, "Buy oat milk, and call the plumber at noon.")).toEqual({ changed: true, held: false })
    expect(editor.textContent).toBe("buy oatmilk and call the plumber at noon.")
  })

  test("edited with no live words since: the final's later words are appended", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy oatmilk"
    expect(settleLiveText(editor, region, "Buy oat milk and call the plumber at noon.").changed).toBe(true)
    expect(editor.textContent).toBe("buy oatmilk and call the plumber at noon.")
  })

  test("an edit that says everything the final does adds nothing, and is not overwritten", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy OAT MILK!"
    expect(settleLiveText(editor, region, "Buy oat milk.")).toEqual({ changed: false, held: false })
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

  test("a final that does not line up with what was shown is held: the editor is left alone", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy oat milk")!
    region.node!.data = "buy oatmilk"
    expect(settleLiveText(editor, region, "completely different words were heard here")).toEqual({ changed: false, held: true })
    expect(editor.textContent).toBe("buy oatmilk")
  })
})

describe("nothing said is lost: Send mid-take", () => {
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
    expect(settleLiveText(editor, region, "Send this. And then the rest.").changed).toBe(true)
    expect(editor.textContent).toBe("And then the rest.")
  })

  test("words only the final transcript caught are still put in the draft", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "send this")!
    send(editor)
    expect(settleLiveText(editor, region, "Send this, and one more thing.").changed).toBe(true)
    expect(editor.textContent).toBe("and one more thing.")
  })

  test("nothing said after Send: the composer stays empty", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "send this")!
    send(editor)
    expect(settleLiveText(editor, region, "Send this.")).toEqual({ changed: false, held: false })
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

  test("an unplaceable final after Send is held, and the live draft stays", () => {
    const editor = editorWith()
    let region = write(editor, undefined, "send this")!
    send(editor)
    region = write(editor, region, "send this and more")!
    expect(settleLiveText(editor, region, "nothing like the live words at all").held).toBe(true)
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

describe("lining a transcript up with the words already shown", () => {
  test("punctuation and case do not matter", () => {
    expect(wordsAfter("buy oat milk", "Buy, oat milk! And more.")).toBe("And more.")
  })
  test("a word still being revised at the takeover counts as already had", () => {
    expect(wordsAfter("buy oat mil", "buy oat milk and call")).toBe("and call")
  })
  test("the engine rewording a word mid-take does not lose the tail", () => {
    expect(wordsAfter("call the plumber at noon please", "call a plumber at noon please then rest")).toBe("then rest")
  })
  test("a phrase repeated later in the take is kept", () => {
    expect(wordsAfter("ok so call me", "okay so call me and then call me")).toBe("and then call me")
  })
  test("no overlap: undefined, so the caller holds it rather than guessing", () => {
    expect(wordsAfter("buy oat milk", "the weather is nice")).toBeUndefined()
  })
})
