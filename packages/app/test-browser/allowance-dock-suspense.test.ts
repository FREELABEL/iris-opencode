import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createSignal, Show, Suspense } from "solid-js"
import { createComponent, render } from "solid-js/web"

// #191772 — "the entire pane goes black and then displays after approval answer submission".
// While IRIS waits on an approval or a question, the composer (and the allowance bar inside it) is
// swapped for the card. Answering brings the composer back, which mounts a fresh allowance bar,
// which fetches /iris/plan. Reading that not-yet-resolved resource handed the whole chat column to
// its <Suspense>, whose fallback is an empty div: the column went blank until /iris/plan answered.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-allowance-dock",
  setup(build) {
    build.onLoad({ filter: /session-allowance-dock\.tsx$/ }, async ({ path }) => {
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

let answerPlan: ((response: Response) => void) | undefined
mock.module("@/context/server", () => ({ useServer: () => ({ current: { http: { url: "http://engine" } } }) }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    fetch: () => new Promise<Response>((resolve) => (answerPlan = resolve)),
  }),
}))
mock.module("@/context/settings", () => ({
  glowDurations: { normal: [4] },
  useSettings: () => ({
    glow: { speed: () => "normal", ring: () => false, halo: () => false, reduceMotion: () => true, background: () => false },
  }),
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show() {}, close() {} }) }))
mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: () => document.createElement("button") }))
mock.module("@/components/dialog-upgrade", () => ({ DialogUpgrade: () => null }))
mock.module("@/components/background-work-menu", () => ({ BackgroundWorkMenu: () => null }))
mock.module("@/utils/upgrade-funnel", () => ({ trackPromptedOnce() {} }))

const { SessionAllowanceDock } = await import("../src/pages/session/composer/session-allowance-dock")

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

test("answering an approval does not blank the chat while the allowance bar loads", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const [answered, setAnswered] = createSignal(false)

  const dispose = render(
    () =>
      createComponent(Suspense, {
        // The split column's fallback (split-view.tsx): an empty column.
        get fallback() {
          const blank = document.createElement("div")
          blank.setAttribute("data-slot", "session-split-loading")
          return blank
        },
        get children() {
          const chat = document.createElement("div")
          chat.setAttribute("data-slot", "chat")
          chat.textContent = "the conversation"
          // The approval card is up: no composer, no allowance bar. Answering brings them back.
          return [chat, createComponent(Show, { get when() { return answered() }, get children() { return createComponent(SessionAllowanceDock, {}) } })]
        },
      }),
    host,
  )

  await tick()
  expect(host.querySelector('[data-slot="chat"]')).not.toBeNull()

  setAnswered(true)
  await tick()
  // /iris/plan has not answered yet. The chat must still be on screen.
  expect(host.querySelector('[data-slot="session-split-loading"]')).toBeNull()
  expect(host.querySelector('[data-slot="chat"]')).not.toBeNull()

  // And once it answers (out of allowance), the bar appears.
  answerPlan?.(
    new Response(JSON.stringify({ measured: true, fraction: 1.2, tokensUsed: 100, paid: false }), {
      headers: { "content-type": "application/json" },
    }),
  )
  await tick(50)
  expect(host.querySelector('[data-component="session-allowance-dock"]')).not.toBeNull()
  expect(host.querySelector('[data-slot="chat"]')).not.toBeNull()

  dispose()
  host.remove()
})
