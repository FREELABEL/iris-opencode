import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createSignal, splitProps } from "solid-js"
import { createComponent, insert, render, spread } from "solid-js/web"
import { matchesHands, type HandsFilter } from "../src/components/session/playbook-flow"
import fixture from "./fixtures-playbooks-flow.json"

// The Playbooks panel ("03 Flow"), rendered. Compiled the way vite does — babel-preset-solid —
// for the same reason as iris-panel-boundary.test.ts: bun's own JSX runtime is eager.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /iris-playbook-flow\.tsx$/ }, async ({ path }) => {
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
// The shared UI primitives are stand-ins: another test file in this process may already have loaded
// the real ones through bun's own (React-style) JSX, and a module is only ever compiled once — so
// compiling them here would depend on file order. What is under test is this panel, not Kobalte.
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: any) => {
    const [local, rest] = splitProps(props, ["children", "variant", "size", "class"])
    const el = document.createElement("button")
    el.setAttribute("data-component", "button")
    el.setAttribute("data-variant", local.variant ?? "secondary")
    if (local.class) el.className = local.class
    spread(el, rest, false, true)
    insert(el, () => local.children)
    return el
  },
}))
mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props: any) => {
    const el = document.createElement("div")
    el.setAttribute("data-component", "icon")
    el.setAttribute("data-name", props.name)
    return el
  },
}))
const { PlaybookFilters, PlaybookFlowList, PlaybookFlowInfo } = await import(
  "../src/components/session/iris-playbook-flow"
)

// Real catalogue rows (names, step modes and titles, views, dates), shaped like /iris/playbooks.
// The last one is re-owned so the "another account" boundary has somewhere to fall.
const rows: any[] = (fixture as any[]).map((r, i, all) =>
  i === all.length - 1 ? { ...r, owned: false, ownerUserId: 2945 } : r,
)

function mountList() {
  const host = document.createElement("div")
  document.body.append(host)
  const [filter, setFilter] = createSignal<HandsFilter>("any")
  const shown = () => rows.filter((r) => matchesHands(r, filter()))
  const dispose = render(
    () => [
      createComponent(PlaybookFilters, {
        get value() {
          return filter()
        },
        onChange: setFilter,
        get shown() {
          return shown().length
        },
        total: rows.length,
      }),
      createComponent(PlaybookFlowList, {
        get rows() {
          return shown()
        },
        total: rows.length,
        get filter() {
          return filter()
        },
        onOpen: () => {},
        onReset: () => setFilter("any"),
      }),
    ],
    host,
  )
  return { host, dispose }
}

test("every row draws one strip segment per published step, and an honest empty strip otherwise", () => {
  const { host, dispose } = mountList()
  const facts = [...host.querySelectorAll("[data-slot='pbf-row']")].map((row) => {
    const strip = row.querySelector("[data-slot='pbf-strip']")!
    return {
      name: row.getAttribute("data-name"),
      title: row.querySelector(".pbf-row__title")?.textContent,
      segs: strip.querySelectorAll(".pbf-seg").length,
      you: strip.querySelectorAll(".pbf-seg[data-who='you']").length,
      empty: strip.classList.contains("pbf-strip--empty"),
      n: row.querySelector(".pbf-row__n")?.textContent,
      tags: [...row.querySelectorAll(".pbf-tag")].map((t) => t.textContent),
      views: row.querySelector(".pbf-views")?.textContent,
    }
  })
  console.log("ROWS\n" + facts.map((f) => JSON.stringify(f)).join("\n"))

  expect(facts.length).toBe(rows.length)
  for (const f of facts) {
    const r = rows.find((x) => x.name === f.name)!
    expect(f.segs).toBe(r.steps.length)
    expect(f.empty).toBe(r.steps.length === 0)
    expect(f.you).toBe(r.steps.filter((s: any) => s.mode === "human").length)
  }
  const ads = facts.find((f) => f.name === "freelabel-ads")!
  // No author title: the row shows the slug exactly, drawn as an identifier (mono).
  expect(ads.title).toBe("freelabel-ads")
  const adsTitle = document.querySelector('[data-name="freelabel-ads"] .pbf-row__title')!
  expect(adsTitle.classList.contains("pbf-slug")).toBe(true)
  expect(ads.tags).toContain("Asks you once")
  expect(ads.tags).toContain("Only you")
  expect(ads.views).toBe("488")
  expect(facts.find((f) => f.name === "bills-to-books")!.tags).toContain("Fully automatic")
  expect(facts.find((f) => f.name === "daily-brief")!.n).toBe("—")
  // Each segment says who and what; the strip has a name.
  const seg = host.querySelector("[data-name='pathways-intake-review'] .pbf-seg[data-who='you']")!
  expect(seg.getAttribute("title")).toBe("Needs you — Physician approves the case AND the assignment")
  expect(
    host.querySelector("[data-name='pathways-intake-review'] [data-slot='pbf-strip']")!.getAttribute("aria-label"),
  ).toBe("4 steps: Runs on its own, IRIS thinks, Runs on its own, Needs you")
  // The owner boundary is drawn once, before the first row that is not yours.
  expect(host.querySelectorAll(".pbf-group").length).toBe(1)
  dispose()
  host.remove()
})

test("the chips are pressed buttons and narrow the list", () => {
  const { host, dispose } = mountList()
  const chips = [...host.querySelectorAll<HTMLButtonElement>(".pbf-chip")]
  expect(chips.map((c) => c.querySelector(".pbf-ic")?.getAttribute("data-icon") ?? null)).toEqual([
    null,
    "settings-gear",
    "hand",
    "hand",
  ])
  expect(chips.map((c) => c.textContent)).toEqual(["Anything", "Fully automatic", "Asks me once", "I stay in charge"])
  const counts: Record<string, number> = {}
  for (const chip of chips) {
    chip.click()
    expect(chip.getAttribute("aria-pressed")).toBe("true")
    expect(chips.filter((c) => c.getAttribute("aria-pressed") === "true").length).toBe(1)
    counts[chip.textContent!] = host.querySelectorAll("[data-slot='pbf-row']").length
  }
  console.log("CHIPS " + JSON.stringify(counts))
  expect(counts).toEqual({
    Anything: rows.length,
    "Fully automatic": rows.filter((r) => r.steps.length && !r.steps.some((s: any) => s.mode === "human")).length,
    "Asks me once": rows.filter((r) => r.steps.filter((s: any) => s.mode === "human").length === 1).length,
    "I stay in charge": rows.filter((r) => r.steps.filter((s: any) => s.mode === "human").length >= 2).length,
  })
  expect(host.querySelector(".pbf-count")?.textContent).toBe(`${counts["I stay in charge"]} of ${rows.length} loaded`)
  dispose()
  host.remove()
})

test("the detail answers what, whether it bothers you, and whether anyone uses it", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const row = rows.find((r) => r.name === "pathways-intake-review")!
  const installs: boolean[] = []
  const copied: string[] = []
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (t: string) => void copied.push(t) },
  })
  const dispose = render(
    () =>
      createComponent(PlaybookFlowInfo, {
        row,
        button: { label: "Install", force: false },
        command: "iris playbook install pathways-intake-review",
        installing: false,
        installResult: null,
        projectDir: "/tmp/project",
        onInstall: async (force: boolean) => (installs.push(force), true),
      }),
    host,
  )
  const facts = Object.fromEntries(
    [...host.querySelectorAll(".pbf-facts > div")].map((d) => [
      d.querySelector("dt")!.textContent,
      d.querySelector("dd")!.textContent,
    ]),
  )
  const steps = [...host.querySelectorAll(".pbf-step")].map((s) => [
    s.getAttribute("data-who"),
    s.querySelector(".pbf-step__who")!.textContent,
  ])
  const buttons = [...host.querySelectorAll("[data-slot='iris-playbook-install'] button")].map((b) => b.textContent)
  console.log("DETAIL " + JSON.stringify({ facts, steps, buttons, need: host.querySelector(".pbf-need")?.textContent }))

  expect(buttons.map((b) => b?.trim())).toEqual(["Run it", "Add to this project"])
  expect(host.querySelector(".pbf-need")?.textContent).toBe("You'll need: Case id")
  expect(facts.Steps).toBe("4")
  expect(facts["Needs you"]).toBe("1×")
  expect(facts["Looked at"]).toBe("60")
  expect(facts.Updated).toMatch(/ago|today|yesterday/)
  expect(Object.keys(facts)).not.toContain("Installs")
  expect(steps[3]).toEqual(["you", "Needs you"])
  // Icons: one meaning each, aria-hidden, words beside them.
  const icon = (sel: string) => host.querySelector(sel)?.querySelector(".pbf-ic")?.getAttribute("data-icon")
  expect(icon(".pbf-step[data-who='you'] .pbf-step__who")).toBe("hand")
  expect(icon(".pbf-step[data-who='think'] .pbf-step__who")).toBe("sparkle")
  expect(icon(".pbf-step[data-who='auto'] .pbf-step__who")).toBe("settings-gear")
  expect([...host.querySelectorAll(".pbf-facts dt .pbf-ic")].map((i) => i.getAttribute("data-icon"))).toEqual([
    "checklist",
    "hand",
    "eye",
    "clock",
  ])
  expect([...host.querySelectorAll(".pbf-ic")].every((i) => i.getAttribute("aria-hidden") === "true")).toBe(true)

  // Run it on a playbook that is not here yet: install, then hand over the run command.
  ;(host.querySelector("[data-slot='iris-playbook-install'] button") as HTMLButtonElement).click()
  await new Promise((r) => setTimeout(r, 20))
  expect(installs).toEqual([false])
  expect(copied).toEqual(["iris playbook run pathways-intake-review"])
  expect(host.querySelector("[data-slot='pbf-run-note']")?.textContent).toContain(
    "iris playbook run pathways-intake-review",
  )
  dispose()
  host.remove()
})
