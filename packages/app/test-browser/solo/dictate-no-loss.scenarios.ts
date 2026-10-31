import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createComponent, render } from "solid-js/web"

// The real v2 composer and its real Dictate control, with only the recorder faked: the words come
// from the test instead of a microphone. Rule 2 of specs/voice/standard.md: nothing said is lost.
// Compiled the way vite does (babel-preset-solid) — see security-render.test.ts. Run on its own by
// ../dictate-no-loss.test.ts: a process that already loaded these components keeps those copies.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-dictate-no-loss",
  setup(build) {
    build.onLoad({ filter: /packages\/(session-ui|ui)\/src\/.*\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

type Callbacks = {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onTranscript: (text: string, origin?: { review?: boolean }) => void
  onError: (message: string) => void
}
let recorder: Callbacks
const [phase, setPhase] = createSignal<"idle" | "recording" | "transcribing">("idle")
const [heldList, setHeldList] = createSignal<{ id: string; seconds: number }[]>([])
const fake = (opts: Callbacks) => {
  recorder = opts
  return {
    phase,
    seconds: () => 0,
    levels: () => new Array(80).fill(0),
    holding: () => false,
    toggle: () => setPhase(phase() === "idle" ? "recording" : "transcribing"),
    press: () => {},
    release: () => {},
    cancel: () => {},
    extend: () => {},
    held: heldList,
    retrying: () => false,
    nextRetryIn: () => undefined,
    retryHeld: async () => {},
    discardHeld: async () => {},
    readiness: () => undefined,
    discardKept: () => {},
    live: () => "streaming",
  }
}
mock.module(resolve(import.meta.dir, "../../../session-ui/src/v2/components/prompt-input/dictation.ts"), () => ({
  createDictation: fake,
  MAX_SECONDS: 300,
}))

const { PromptInputV2 } = await import("../../../session-ui/src/v2/components/prompt-input/index")
const { caretAtEnd, caretToEnd } = await import("../../../session-ui/src/v2/components/prompt-input/live-text")

function mount() {
  const [parts, setParts] = createSignal<any[]>([{ type: "text", content: "", start: 0, end: 0 }])
  const [state] = createStore({ mode: "normal", drag: undefined, activeContextID: undefined, popover: { type: "closed" } })
  const sent: string[] = []
  const value = () => parts().map((part) => part.content ?? "").join("")
  const controller: any = {
    state,
    view: { placeholder: () => "Ask anything", submit: { stopping: () => false } },
    parts,
    value,
    attachments: () => [],
    comments: () => [],
    suggestions: () => [],
    canSubmit: () => value().trim().length > 0,
    onInput: (_text: string, next: any[]) => setParts(next),
    submit: () => {
      // What createPromptSubmit does: send the prompt as it stands, then clear it.
      sent.push(value())
      setParts([{ type: "text", content: "", start: 0, end: 0 }])
    },
  }
  const noop = () => {}
  for (const name of [
    "setEditor", "setFileInput", "dispatch", "onCursor", "onKeyDown", "onPaste", "onDragEnter", "onDragLeave",
    "onDragOver", "onDrop", "stop", "setQuery", "addAttachments", "attach", "openAttachment", "openCommands",
    "openContext", "openShell", "removeAttachment", "removeContext", "toggleContext",
  ])
    controller[name] = noop
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => createComponent(PromptInputV2, { controller, transcribeUrl: () => "http://sidecar" }), host)
  const editor = host.querySelector('[data-component="prompt-input"]') as HTMLDivElement
  /** A person typing: the DOM changes, then the browser fires input. */
  const type = (change: (editor: HTMLDivElement) => void) => {
    change(editor)
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  const start = () => (host.querySelector('[data-action="prompt-dictate"]') as HTMLButtonElement).click()
  return { host, editor, sent, value, controller, type, start, dispose: () => (dispose(), host.remove()) }
}

const panel = () => document.body.querySelector('[data-slot="dictate-panel"]')
const fullAction = () => document.body.querySelector('[data-action="prompt-dictate-full"]') as HTMLButtonElement | null
const caretTo = (node: Node, offset: number) => {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

let cleanup = () => {}
afterEach(() => {
  cleanup()
  cleanup = () => {}
  setPhase("idle")
  setHeldList([])
})
const begin = () => {
  const ui = mount()
  cleanup = ui.dispose
  ui.start()
  expect(phase()).toBe("recording")
  return ui
}
/** The take ends with its final transcript, as the recorder delivers it. */
const finish = (text: string) => {
  setPhase("transcribing")
  recorder.onTranscript(text)
  setPhase("idle")
}

describe("dictating in the composer: nothing said is lost", () => {
  test("an untouched take: live words become the prompt, then the final replaces them once", () => {
    const ui = begin()
    recorder.onPartial("buy oat")
    expect(ui.value()).toBe("buy oat")
    expect(ui.controller.canSubmit()).toBe(true)
    finish("Buy oat milk.")
    expect(ui.editor.textContent).toBe("Buy oat milk.")
    expect(ui.value()).toBe("Buy oat milk.")
    expect(!!panel()).toBe(false)
  })

  test("edit mid-take: the edit stays, later words and the final's tail still arrive", () => {
    const ui = begin()
    recorder.onFinal("buy oat milk")
    ui.type((editor) => ((editor.lastChild as Text).data = "buy oatmilk"))
    recorder.onPartial("and call")
    expect(ui.value()).toBe("buy oatmilk and call")
    finish("Buy oat milk and call the plumber at noon.")
    expect(ui.value()).toBe("buy oatmilk and call the plumber at noon.")
    expect(!!panel()).toBe(false)
  })

  test("Send mid-take: what is on screen is sent, the mic keeps going, later words are the next draft", () => {
    const ui = begin()
    recorder.onFinal("send this")
    ui.controller.submit()
    expect(ui.sent).toEqual(["send this"])
    expect(phase()).toBe("recording")
    expect(ui.editor.textContent).toBe("")
    recorder.onPartial("and then the res")
    expect(ui.value()).toBe("and then the res")
    finish("Send this and then the rest.")
    expect(ui.value()).toBe("and then the rest.")
    expect(ui.sent).toEqual(["send this"])
  })

  test("a final that cannot be lined up keeps what is on screen, with no panel; Full transcript recovers it", () => {
    const ui = begin()
    recorder.onFinal("buy oat milk")
    ui.type((editor) => ((editor.lastChild as Text).data = "my own words now"))
    finish("something the engine heard quite differently")
    expect(ui.value()).toBe("my own words now")
    expect(!!panel()).toBe(false)
    fullAction()!.click()
    expect(ui.value()).toBe("my own words now")
    expect(panel()?.textContent).toContain("something the engine heard quite differently")
    ;(panel()?.querySelector('[data-slot="dictate-btn"][data-primary]') as HTMLButtonElement).click()
    expect(ui.value()).toBe("my own words now something the engine heard quite differently")
    expect(!!panel()).toBe(false)
  })

  // Alex's scenarios (#191998).
  test("delete everything mid-take, talk, Stop: the deleted text stays gone, later words are there", () => {
    const ui = begin()
    recorder.onFinal("the first thought I deleted")
    // What a browser leaves in a box emptied with select-all and delete.
    ui.type((editor) => editor.replaceChildren(document.createElement("br")))
    expect(ui.value().trim()).toBe("")
    recorder.onPartial("and now the real")
    expect(ui.value()).toBe("and now the real")
    finish("The first thought I deleted. And now the real message.")
    expect(ui.value()).toBe("And now the real message.")
    expect(!!panel()).toBe(false)
  })

  test("Send mid-take, talk, Stop: the first sentence does not return, and nothing is sent twice", () => {
    const ui = begin()
    recorder.onFinal("the first sentence")
    ui.controller.submit()
    recorder.onFinal("the second one")
    finish("The first sentence. The second one.")
    expect(ui.value()).toBe("The second one.")
    expect(ui.sent).toEqual(["the first sentence"])
    expect(!!panel()).toBe(false)
  })

  test("Full transcript holds the whole take, and never lands in the message by itself", () => {
    const ui = begin()
    recorder.onFinal("gone")
    ui.type((editor) => editor.replaceChildren())
    recorder.onFinal("kept words")
    finish("Gone. Kept words.")
    expect(ui.value()).toBe("Kept words.")
    fullAction()!.click()
    expect(panel()?.textContent).toContain("Gone. Kept words.")
    expect(ui.value()).toBe("Kept words.")
    expect(!!fullAction()).toBe(false)
  })

  test("an untouched take offers no Full transcript", () => {
    const ui = begin()
    recorder.onFinal("all mine")
    finish("All mine.")
    expect(!!fullAction()).toBe(false)
  })

  test("a live write is not an edit: the take stays untouched however many words arrive", () => {
    const ui = begin()
    recorder.onPartial("one")
    recorder.onPartial("one two")
    recorder.onFinal("one two three")
    finish("Entirely. Reworded by the final.")
    expect(ui.value()).toBe("Entirely. Reworded by the final.")
  })

  test("an edit anywhere closes the segment, even if the live node is untouched", () => {
    const ui = mount()
    cleanup = ui.dispose
    ui.type((editor) => editor.replaceChildren(document.createTextNode("Draft:")))
    ui.start()
    recorder.onFinal("one two")
    ui.type((editor) => ((editor.firstChild as Text).data = "Note:"))
    recorder.onPartial("three")
    finish("Something else entirely was heard.")
    expect(ui.value()).toBe("Note: one two three")
    expect(!!panel()).toBe(false)
  })

  test("the cursor at the end follows live words", () => {
    const ui = begin()
    ui.editor.focus()
    caretToEnd(ui.editor)
    recorder.onPartial("one")
    expect(caretAtEnd(ui.editor)).toBe(true)
    recorder.onPartial("one two three")
    expect(caretAtEnd(ui.editor)).toBe(true)
  })

  test("a moved cursor stays, words go at the end, and it follows again from the end", () => {
    const ui = begin()
    recorder.onFinal("one two")
    caretTo(ui.editor.lastChild as Text, 2)
    recorder.onFinal("three")
    expect(ui.editor.textContent).toBe("one two three")
    expect(window.getSelection()!.anchorOffset).toBe(2)
    caretToEnd(ui.editor)
    recorder.onFinal("four")
    expect(caretAtEnd(ui.editor)).toBe(true)
  })

  test("Stop moves the cursor to the end, unless the person is mid-edit", () => {
    const moved = begin()
    recorder.onFinal("never touched")
    caretTo(moved.editor.lastChild as Text, 2)
    finish("Never touched.")
    expect(caretAtEnd(moved.editor)).toBe(true)
    moved.dispose()
    cleanup = () => {}
    setPhase("idle")

    const ui = begin()
    recorder.onFinal("one two three")
    ui.type((editor) => ((editor.lastChild as Text).data = "one TWO three"))
    const edited = ui.editor.lastChild as Text
    caretTo(edited, 5)
    recorder.onFinal("four")
    finish("One two three four.")
    expect(ui.value()).toBe("one TWO three four.")
    expect(window.getSelection()!.anchorNode === edited).toBe(true)
    expect(window.getSelection()!.anchorOffset).toBe(5)
  })

  test("edit the middle, keep talking: the edit stays and later words follow it", () => {
    const ui = begin()
    recorder.onFinal("one two three")
    ui.type((editor) => ((editor.lastChild as Text).data = "one 2 three"))
    recorder.onFinal("four five")
    expect(ui.value()).toBe("one 2 three four five")
    finish("One two three, four five.")
    expect(ui.value()).toBe("one 2 three four five.")
    expect(!!panel()).toBe(false)
  })

  test("Send stays enabled mid-take, and a later draft can be sent too", () => {
    const ui = begin()
    recorder.onFinal("first")
    expect(ui.controller.canSubmit()).toBe(true)
    ui.controller.submit()
    recorder.onFinal("second")
    expect(ui.controller.canSubmit()).toBe(true)
    ui.controller.submit()
    expect(ui.sent).toEqual(["first", "second"])
  })

  test("a touched take that fails keeps its words; the saved take's Retry offers review, not the message", () => {
    const ui = begin()
    recorder.onFinal("gone")
    ui.type((editor) => editor.replaceChildren())
    recorder.onFinal("kept words")
    setPhase("transcribing")
    setHeldList([{ id: "a", seconds: 3 }])
    recorder.onError("Transcription failed. Your recording is saved.")
    setPhase("idle")
    expect(ui.value()).toBe("kept words")
    recorder.onTranscript("Gone. Kept words.", { review: true })
    expect(ui.value()).toBe("kept words")
    expect(!!panel()).toBe(false)
    fullAction()!.click()
    expect(panel()?.textContent).toContain("Gone. Kept words.")
  })

  test("a take that fails with no audio saved leaves its live words in the composer", () => {
    const ui = begin()
    recorder.onFinal("the only copy of these words")
    setPhase("transcribing")
    recorder.onError("Could not reach the server")
    setPhase("idle")
    expect(ui.value()).toBe("the only copy of these words")
  })

  test("a take that fails with its audio saved takes the live words back out: Retry brings them", () => {
    const ui = begin()
    recorder.onFinal("saved for retry")
    setPhase("transcribing")
    setHeldList([{ id: "a", seconds: 3 }])
    recorder.onError("Transcription failed. Your recording is saved.")
    setPhase("idle")
    expect(ui.value()).toBe("")
  })
})
