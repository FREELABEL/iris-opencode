import { describe, expect, test } from "bun:test"
// Lives in session-ui's composer; tested here because this package has a DOM (happydom.ts preload).
import { isLiveDictation, showLiveText } from "@opencode-ai/session-ui/v2/prompt-input/live-text"

const editorWith = (text = "") => {
  const editor = document.createElement("div")
  if (text) editor.appendChild(document.createTextNode(text))
  return editor
}

describe("live dictation in the chat box", () => {
  test("words appear as they are spoken, rewritten in place — one span, not one per partial", () => {
    const editor = editorWith()
    let span = showLiveText(editor, undefined, "what's on")
    span = showLiveText(editor, span, "what's on my calendar")
    span = showLiveText(editor, span, "what's on my calendar tomorrow")
    expect(editor.querySelectorAll("[data-slot=dictate-live]")).toHaveLength(1)
    expect(editor.textContent).toBe("what's on my calendar tomorrow")
  })

  test("after text already typed, the take is separated by a space", () => {
    const editor = editorWith("Hey TOBI,")
    showLiveText(editor, undefined, "add a note")
    expect(editor.textContent).toBe("Hey TOBI, add a note")
  })

  test("undefined clears it, and leaves the typed text alone", () => {
    const editor = editorWith("keep me")
    const span = showLiveText(editor, undefined, "gone soon")
    expect(showLiveText(editor, span, undefined)).toBeUndefined()
    expect(editor.textContent).toBe("keep me")
  })

  test("if the editor rebuilt its DOM under it, the next words get a fresh span, not a lost one", () => {
    const editor = editorWith()
    const span = showLiveText(editor, undefined, "first words")!
    editor.replaceChildren(document.createTextNode("typed"))
    const next = showLiveText(editor, span, "first words and more")
    expect(next).not.toBe(span)
    expect(editor.textContent).toBe("typed first words and more")
  })

  test("the span is marked so the prompt parser skips it — it is never sent twice", () => {
    const editor = editorWith("typed")
    const span = showLiveText(editor, undefined, "spoken")!
    expect(isLiveDictation(span)).toBe(true)
    expect(isLiveDictation(editor.firstChild!)).toBe(false)
    expect(span.contentEditable).toBe("false")
  })
})
