import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createRenderEffect } from "solid-js"
import { createComponent, insert, render } from "solid-js/web"

// The publish modal (#187131): opened over a real artifact, in its first-publish state.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-artifact-publish",
  setup(build) {
    build.onLoad({ filter: /iris-artifact-publish\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-artifact-publish\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})
mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props: any) => {
    const el = document.createElement("div")
    el.setAttribute("data-component", "icon")
    el.setAttribute("data-name", props.name)
    return el
  },
}))
// The ui Dialog/Button are exercised by their own package; here they are thin stand-ins, so this
// test does not depend on which compile of them another test file loaded first.
let closeOpen: (() => void) | undefined
mock.module("@opencode-ai/ui/context/dialog", () => ({
  DialogProvider: (p: any) => p.children,
  useDialog: () => ({
    show(fn: () => any) {
      const el = document.createElement("div")
      el.setAttribute("data-component", "dialog")
      document.body.append(el)
      const dispose = render(fn, el)
      closeOpen = () => {
        dispose()
        el.remove()
      }
    },
    close: () => closeOpen?.(),
  }),
}))
mock.module("@opencode-ai/ui/dialog", () => ({
  Dialog: (p: any) => {
    const d = document.createElement("div")
    d.setAttribute("data-slot", "dialog-content")
    const t = document.createElement("h2")
    t.textContent = p.title
    const ds = document.createElement("p")
    ds.textContent = p.description
    const body = document.createElement("div")
    insert(body, () => p.children)
    d.append(t, ds, body)
    return d
  },
}))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (p: any) => {
    const b = document.createElement("button")
    createRenderEffect(() => {
      b.type = p.type ?? "button"
      b.disabled = !!p.disabled
    })
    if (p.onClick) b.addEventListener("click", p.onClick)
    insert(b, () => p.children)
    return b
  },
}))
mock.module("./iris-item", () => ({ renderMarkdown: (s: string) => s }))
const { DialogProvider } = await import("@opencode-ai/ui/context/dialog")
const { IrisArtifactPublish } = await import("../src/components/session/iris-artifact-publish")

const wait = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the modal")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const BOARDS = [
  { id: 607, name: "Branded Champions" },
  { id: 512, name: "Fort Worth newsroom" },
  { id: 38, name: "Learning Ecosystem Page" },
  { id: 300, name: "Trading desk" },
]
const META = {
  id: "art_1",
  title: "Q4 sponsor one-pager",
  kind: "html",
  revision: 3,
  published: undefined,
} as any

function mount() {
  const calls: { path: string; body?: string }[] = []
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body as string | undefined })
    return new Response(JSON.stringify({ ok: true, published: { url: "https://heyiris.io/p/q4-sponsor-one-pager" } }))
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(IrisArtifactPublish, {
            meta: META,
            content: "<h1>Q4</h1>",
            doFetch,
            sessionId: "ses_1",
            bloqId: 607,
            bloqName: "Branded Champions",
            boards: () => BOARDS,
            onPublished: () => {},
          })
        },
      }),
    host,
  )
  return { host, dispose, calls }
}

test("Publish opens a modal: project first, then who can see it, then one sentence of consequence", async () => {
  const { host, dispose } = mount()
  const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Publish…" || b.textContent?.startsWith("Publish"))!
  btn.click()
  await wait(() => !!document.querySelector('[data-testid="artifact-publish-modal"]'))
  const modal = document.querySelector('[data-component="dialog"]') as HTMLElement
  if (process.env.PUB_DUMP) (await import("node:fs")).writeFileSync(process.env.PUB_DUMP + "/modal.html", modal.outerHTML)
  expect(modal.textContent).toContain("Q4 sponsor one-pager")
  expect(modal.querySelector(".iris-publish__destname")?.textContent).toBe("Branded Champions")
  // nothing pre-selected: the button says what is missing
  const submit = () => modal.querySelector('button[type="submit"]') as HTMLButtonElement
  expect(submit().disabled).toBe(true)
  expect(submit().textContent).toBe("Choose who can see it")
  expect(document.querySelector('[data-testid="artifact-publish-summary"]')?.textContent).toBe(
    "Choose who can see it · saved to Branded Champions",
  )
  // three steps, in order: where, address, who
  expect([...modal.querySelectorAll(".iris-pubm__lbl")].map((h) => h.textContent)).toEqual(["1Where it lives", "2Address", "3Who can see it"])
  ;(modal.querySelectorAll(".iris-pubm__scope input")[0] as HTMLInputElement).click()
  await wait(() => submit().textContent === "Publish publicly")
  expect(submit().disabled).toBe(false)
  expect(document.querySelector('[data-testid="artifact-publish-summary"]')?.textContent).toBe(
    "Public · anyone at heyiris.io/p/q4-sponsor-one-pager · saved to Branded Champions",
  )
  if (process.env.PUB_DUMP)
    (await import("node:fs")).writeFileSync(process.env.PUB_DUMP + "/chosen.html", document.querySelector('[data-component="dialog"]')!.outerHTML)
  // the project is a real control: open it, pick another, the sentence follows
  ;(modal.querySelector(".iris-pubm__dest") as HTMLButtonElement).click()
  await wait(() => !!document.querySelector(".iris-pubm__boards"))
  if (process.env.PUB_DUMP)
    (await import("node:fs")).writeFileSync(process.env.PUB_DUMP + "/picker.html", document.querySelector('[data-component="dialog"]')!.outerHTML)
  ;([...document.querySelectorAll(".iris-pubm__board")].find((b) => b.textContent?.includes("Trading desk")) as HTMLButtonElement).click()
  await wait(() => document.querySelector('[data-testid="artifact-publish-summary"]')?.textContent?.endsWith("saved to Trading desk") ?? false)
  dispose()
  host.remove()
})
