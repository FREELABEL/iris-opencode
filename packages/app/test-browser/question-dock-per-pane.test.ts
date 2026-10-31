import { plugin } from "bun"
import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, insert, render } from "solid-js/web"

// #191780 / #191781 — the question card in split view.
// Several chats side by side (split-view.tsx), each its own column with its own conversation
// scroller and composer. The card measured "the" scroller with a document-wide query, which is
// the FIRST column's whichever column the card is in (#191780); and on appearing it moved focus to
// its first option, pulling the keyboard out of whatever column the person was typing in (#191781).
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-question-dock",
  setup(build) {
    build.onLoad({ filter: /(session-question-dock|use-composer-commands)\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
  },
})

const el = (tag: string, attrs: Record<string, string> = {}) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

mock.module("@tanstack/solid-query", () => ({ useMutation: () => ({ isPending: false, mutate() {} }) }))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: any) => {
    const b = el("button")
    insert(b, () => props.children)
    return b
  },
}))
mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => el("span") }))
mock.module("@opencode-ai/ui/motion-spring", () => ({ useSpring: () => () => 0 }))
mock.module("@opencode-ai/session-ui/dock-prompt", () => ({
  DockPrompt: (props: any) => {
    const div = el("div", { "data-component": "dock-prompt", "data-bottom": "880" })
    props.ref?.(div)
    insert(div, () => [props.header, props.children, props.footer])
    return div
  },
}))
mock.module("@/utils/toast", () => ({ showToast() {} }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ api: { question: {} } }) }))
mock.module("@/context/sync", () => ({ useSync: () => () => ({ set() {} }) }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "local" }) }))

mock.module("@/context/command", () => ({ useCommand: () => ({ register() {} }) }))
mock.module("@/context/local", () => ({ useLocal: () => ({ model: {} }) }))
mock.module("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show() {} }) }))
mock.module("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ sessionKey: () => "k" }) }))

const { SessionQuestionDock } = await import("../src/pages/session/composer/session-question-dock")
const { activeComposer } = await import("../src/pages/session/use-composer-commands")

// happy-dom lays nothing out: each element reports the bottom edge written on it.
const rect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function (this: Element) {
  const bottom = Number(this.getAttribute("data-bottom") ?? 0)
  return { top: 0, left: 0, right: 0, width: 0, height: bottom, bottom, x: 0, y: 0, toJSON() {} } as DOMRect
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

let cleanup: VoidFunction[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  document.body.innerHTML = ""
})

/** One chat: its panel, conversation scroller (sticky header ending at `headBottom`) and dock. */
function pane(parent: HTMLElement, headBottom: number) {
  const panel = el("div", { "data-component": "session-panel" })
  const scroller = el("div", { class: "scroll-view__viewport" })
  scroller.append(el("div", { class: "sticky", "data-bottom": String(headBottom) }))
  const dock = el("div", { "data-component": "session-prompt-dock", "data-bottom": "900" })
  const input = el("textarea")
  dock.append(input)
  panel.append(scroller, dock)
  parent.append(panel)
  return { dock, input }
}

function column(row: HTMLElement, headBottom: number) {
  const col = el("div", { "data-component": "session-split-column" })
  row.append(col)
  return pane(col, headBottom)
}

const request = {
  id: "que_1",
  sessionID: "ses_b",
  questions: [{ question: "Which one?", header: "Pick", options: [{ label: "First", description: "" }, { label: "Second", description: "" }] }],
} as any

function showQuestion(dock: HTMLElement) {
  const host = el("div")
  dock.append(host)
  const dispose = render(() => createComponent(SessionQuestionDock, { request, onSubmit() {} }), host)
  cleanup.push(dispose)
  return host
}

const firstOption = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-slot="question-option"]')

test("a question in the second column measures the second column's scroller (#191780)", async () => {
  const row = el("div", { "data-component": "session-split" })
  document.body.append(row)
  column(row, 50) // column A: its sticky header ends at 50
  const b = column(row, 100) // column B: its sticky header ends at 100

  const host = showQuestion(b.dock)
  await tick()

  const root = host.querySelector<HTMLElement>('[data-component="dock-prompt"]')!
  // dock bottom 900 − B's header 100 − gap 8 − (900 − card bottom 880). A's would give 822.
  expect(root.style.getPropertyValue("--question-prompt-max-height")).toBe("772px")
})

test("a question appearing in column B leaves focus in column A's composer (#191781)", async () => {
  const row = el("div", { "data-component": "session-split" })
  document.body.append(row)
  const a = column(row, 50)
  const b = column(row, 100)
  a.input.focus()
  expect(document.activeElement).toBe(a.input)

  const host = showQuestion(b.dock)
  await tick()

  expect(firstOption(host)).not.toBeNull()
  expect(document.activeElement).toBe(a.input)
})

test("a question in the column being typed in takes focus (#191781)", async () => {
  const row = el("div", { "data-component": "session-split" })
  document.body.append(row)
  column(row, 50)
  const b = column(row, 100)
  b.input.focus()

  const host = showQuestion(b.dock)
  await tick()

  expect(document.activeElement).toBe(firstOption(host))
})

test("with one chat open the question still takes focus (keyboard access)", async () => {
  const solo = pane(document.body, 100)
  const host = showQuestion(solo.dock)
  await tick()

  expect(document.activeElement).toBe(firstOption(host))
})

afterAll(() => {
  Element.prototype.getBoundingClientRect = rect
})

test("the model picker returns to the composer the person was in, not the first column's", () => {
  const row = el("div", { "data-component": "session-split" })
  document.body.append(row)
  const composers = [0, 1].map(() => {
    const col = el("div", { "data-component": "session-split-column" })
    const editor = el("div", { "data-component": "prompt-input", contenteditable: "true", tabindex: "0" })
    col.append(editor)
    row.append(col)
    return { col, editor }
  })

  composers[1].editor.focus()
  expect(activeComposer()).toBe(composers[1].editor)

  // Focus already gone (a menu took it): the focused column's composer.
  composers[1].editor.blur()
  window.getSelection()?.removeAllRanges()
  composers[1].col.setAttribute("data-focused", "")
  expect(activeComposer()).toBe(composers[1].editor)
})
