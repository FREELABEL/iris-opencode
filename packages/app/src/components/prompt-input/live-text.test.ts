import { describe, expect, test } from "bun:test"
// Lives in session-ui's composer; tested here because this package has a DOM (happydom.ts preload).
import { settleLiveText, writeLiveText, type LiveRegion } from "@opencode-ai/session-ui/v2/prompt-input/live-text"

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
    expect(next?.released).toBeFalsy()
    expect(editor.textContent).toBe("first words and more")
  })

  test("once the words are sent or cleared, nothing re-adds them", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "send this")!
    editor.replaceChildren() // Send clears the composer
    const next = write(editor, region, "send this now")
    expect(editor.textContent).toBe("")
    expect(settleLiveText(editor, next, "Send this now.")).toBe(false)
    expect(editor.textContent).toBe("")
  })

  test("once the person edits the dictated words, they are theirs: no later write overwrites them", () => {
    const editor = editorWith()
    const region = write(editor, undefined, "buy bred")!
    region.node.data = "buy bread" // typed a fix while still recording
    const next = write(editor, region, "buy bred and milk")
    expect(editor.textContent).toBe("buy bread")
    expect(settleLiveText(editor, next, "Buy bread and milk.")).toBe(false)
    expect(editor.textContent).toBe("buy bread")
  })
})
