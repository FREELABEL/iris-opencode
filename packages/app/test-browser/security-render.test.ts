import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createRenderEffect } from "solid-js"
import { createComponent, render } from "solid-js/web"

// Settings › Security (#189589), rendered from the body fl-iris-api's SecurityController returns,
// through the engine's /iris/security shape. Compiled the way vite does (babel-preset-solid) —
// see iris-panel-boundary.test.ts. Asserts what a person reads, not what the code meant.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-settings-security",
  setup(build) {
    build.onLoad({ filter: /settings-v2\/(security|parts\/row|parts\/list)\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /settings-v2\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

const calls: { path: string; method: string; body?: unknown }[] = []
let body: any
let gateAnswer: (sent: { enabled: boolean }) => any = () => ({ measured: false, reason: "not set" })
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    fetch: async (url: string, init?: RequestInit) => {
      const path = url.replace("http://engine", "")
      calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
      if (path === "/iris/security") return json(body)
      if (path === "/iris/security/gate") return json(gateAnswer(JSON.parse(String(init?.body))))
      if (path.startsWith("/iris/security/gate/events/")) return json({ measured: true, event: null })
      return json({}, 404)
    },
  }),
}))
mock.module("@/context/server", () => ({ useServer: () => ({ current: { http: { url: "http://engine/" } } }) }))
mock.module("@opencode-ai/ui/v2/button-v2", () => ({
  ButtonV2: (props: any) => {
    const el = document.createElement("button")
    el.textContent = typeof props.children === "function" ? props.children() : String(props.children ?? "")
    el.addEventListener("click", () => props.onClick?.())
    return el
  },
}))
mock.module("@opencode-ai/ui/v2/switch-v2", () => ({
  Switch: (props: any) => {
    const el = document.createElement("input")
    el.type = "checkbox"
    createRenderEffect(() => {
      el.checked = Boolean(props.checked)
      el.disabled = Boolean(props.disabled)
    })
    el.addEventListener("change", () => props.onChange?.(el.checked))
    return el
  },
}))
const { SettingsSecurityV2 } = await import("../src/components/settings-v2/security")

const ON = {
  measured: true,
  gate: {
    enabled: true,
    reason: "allowlisted",
    choice: null,
    canChange: true,
    explanation: "Gate screens what reaches the model on your account and records what it finds. It does not change your conversations yet.",
    mode: "shadow",
    org: "iris",
    sensitivity: "balanced",
    categories: ["prompt_injection", "credential"],
    segments: ["tool", "user"],
    failOpen: true,
    availableChecks: ["prompt_injection", "pii", "phi", "credential"],
    sensitivities: ["strict", "balanced", "permissive"],
    stats: { windowDays: 30, scanned: 1284, clean: 1267, flagged: 12, held: 5, errors: 0, reportedFalse: 1, reportedFalsePct: 0.1, p50LatencyMs: 480, billableTokens: 90000 },
    recent: [
      { id: 41, at: "2026-10-15T20:00:00Z", segment: "tool", action: "flagged", mode: "shadow", verdict: "block", score: 0.98, reasonCode: "prompt_injection", detected: [], sensitivity: "balanced", latencyMs: 512, cached: false, errorCode: null, reportedFalse: false },
      { id: 40, at: "2026-10-15T19:58:00Z", segment: "user", action: "clean", mode: "shadow", verdict: "allow", score: 0.02, reasonCode: null, detected: [], sensitivity: "balanced", latencyMs: 470, cached: false, errorCode: null, reportedFalse: false },
    ],
  },
  phiGuard: { active: false, mode: "report", explanation: "None of your workspaces is marked as holding health data." },
}

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the panel")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function mount(state: any) {
  body = state
  calls.length = 0
  const root = document.createElement("div")
  document.body.appendChild(root)
  const dispose = render(() => createComponent(SettingsSecurityV2, {}), root)
  return { root, dispose }
}

test("an account Gate screens: state, reason, mode, checks, the month and the scans", async () => {
  const { root, dispose } = mount(ON)
  await wait(() => root.textContent!.includes("Recent scans"))
  const text = root.textContent!

  expect(root.querySelector('[data-action="gate-status"]')!.textContent).toContain("On · watching")
  expect(text).toContain("does not change your conversations")
  expect(text).toContain("Watching only")
  expect(root.querySelector('[data-action="gate-sensitivity"] [data-selected]')!.textContent).toBe("balanced")
  expect([...root.querySelectorAll('[data-action="gate-checks"] [data-on]')].map((e) => e.textContent)).toEqual(["Prompt injection", "Credentials"])
  expect(text).toContain("needs a health-data agreement (BAA)")
  expect(root.querySelector('[data-action="gate-stats"]')!.textContent).toContain("1,284")
  expect(root.querySelector('[data-action="gate-stats"]')!.textContent).toContain("0.48s")
  expect(text).toContain("risk 0.98")
  dispose()
})

test("Report a mistake posts the event's id and marks it reported", async () => {
  const { root, dispose } = mount(ON)
  await wait(() => [...root.querySelectorAll("button")].some((b) => b.textContent === "Report a mistake"))

  const buttons = [...root.querySelectorAll("button")].filter((b) => b.textContent === "Report a mistake")
  expect(buttons).toHaveLength(1) // the clean scan cannot be reported
  buttons[0].click()
  await wait(() => root.textContent!.includes("Reported"))

  expect(calls).toContainEqual({ path: "/iris/security/gate/events/41/report", method: "POST" })
  dispose()
})

test("off for health data says why, and hides the scan sections", async () => {
  const { root, dispose } = mount({
    ...ON,
    gate: { ...ON.gate, enabled: false, reason: "phi_no_baa", explanation: "Gate is off for your account because you work with health data, and Gate is not yet covered by a health-data agreement (BAA).", recent: [] },
    phiGuard: { active: true, mode: "report", explanation: "You work in a workspace that holds health data." },
  })
  await wait(() => root.textContent!.includes("Health-data guard") && !root.textContent!.includes("Checking"))

  expect(root.querySelector('[data-action="gate-status"]')!.textContent).toContain("Off")
  expect(root.textContent).toContain("health-data agreement (BAA)")
  expect(root.textContent).not.toContain("Recent scans")
  expect(root.textContent).toContain("Active")
  dispose()
})

test("an unreachable server reads Unknown with Retry — never Off", async () => {
  const { root, dispose } = mount({ ...ON, measured: false, reason: "iris-api 502" })
  await wait(() => root.textContent!.includes("Couldn't reach IRIS"))

  expect(root.querySelector('[data-action="gate-status"]')!.textContent).not.toContain("Off")
  expect(root.textContent).toContain("not the same as Gate being off")
  expect([...root.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(true)
  dispose()
})

// #191083 — the person's own switch.
const gateSwitch = (root: HTMLElement) => root.querySelector('[data-action="gate-switch"] input') as HTMLInputElement

test("switching Gate off sends the choice and shows what the SERVER decided", async () => {
  gateAnswer = (sent) => ({
    ...ON,
    gate: { ...ON.gate, enabled: sent.enabled, reason: "user_off", choice: "off", explanation: "You turned Gate off. Your messages are not scanned." },
  })
  const { root, dispose } = mount(ON)
  await wait(() => !!gateSwitch(root) && !gateSwitch(root).disabled && gateSwitch(root).checked)
  expect(root.textContent).toContain("follows IRIS's rollout")

  gateSwitch(root).checked = false
  gateSwitch(root).dispatchEvent(new Event("change"))
  await wait(() => root.textContent!.includes("You turned Gate off"))

  expect(calls).toContainEqual({ path: "/iris/security/gate", method: "POST", body: { enabled: false } })
  expect(root.querySelector('[data-action="gate-status"]')!.textContent).toContain("Off")
  dispose()
})

test("a health-data account sees the switch locked", async () => {
  const { root, dispose } = mount({
    ...ON,
    gate: { ...ON.gate, enabled: false, reason: "phi_no_baa", canChange: false, explanation: "Gate is off for your account because you work with health data.", recent: [] },
  })
  await wait(() => !!gateSwitch(root) && root.textContent!.includes("can't change this"))

  expect(gateSwitch(root).disabled).toBe(true)
  dispose()
})

test("a refused switch says why and re-reads the server instead of trusting the click", async () => {
  gateAnswer = () => ({ measured: false, reason: "Gate is switched off for everyone right now." })
  const { root, dispose } = mount(ON)
  await wait(() => !!gateSwitch(root) && !gateSwitch(root).disabled)
  const before = calls.filter((c) => c.path === "/iris/security").length

  gateSwitch(root).checked = false
  gateSwitch(root).dispatchEvent(new Event("change"))
  await wait(() => root.textContent!.includes("Couldn't change it"))

  expect(root.textContent).toContain("switched off for everyone")
  await wait(() => calls.filter((c) => c.path === "/iris/security").length > before)
  dispose()
})

test("an unreachable server leaves the switch locked", async () => {
  const { root, dispose } = mount({ ...ON, measured: false, reason: "iris-api 502" })
  await wait(() => !!gateSwitch(root) && root.textContent!.includes("Available once IRIS answers"))

  expect(gateSwitch(root).disabled).toBe(true)
  dispose()
})
