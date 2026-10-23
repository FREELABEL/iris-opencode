import { plugin } from "bun"
import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"

// Hive › Sessions (#189446): the fleet as it was measured on 2026-10-14 — one always-on box
// reporting live work, one MacBook whose daemon went quiet 31 days earlier.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = req("@babel/core")
plugin({
  name: "solid-jsx-hive-sessions",
  setup(build) {
    build.onLoad({ filter: /iris-hive-sessions\.tsx$/ }, async ({ path }) => {
      const out = await babel.transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [req.resolve("babel-preset-solid"), { generate: "dom" }],
          [req.resolve("@babel/preset-typescript"), {}],
        ],
      })
      return { contents: out.code, loader: "js" }
    })
    build.onLoad({ filter: /iris-hive-(scripts|sessions)\.css$/ }, () => ({ contents: "", loader: "js" }))
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
const { IrisHiveSessions } = await import("../src/components/session/iris-hive-sessions")

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the panel")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const NOW = Date.parse("2026-10-14T22:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const NODES = [
  {
    id: "mac",
    name: "MacBook",
    online: false,
    lastHeartbeat: iso(31 * 86_400_000),
    report: "stale",
    reportedAt: iso(31 * 86_400_000),
    incomplete: [],
    sessions: [
      { sessionId: "old1", provider: "claude_code", label: "speech-to-text service", status: "unknown", activity: null, model: null, branch: "master", updatedAt: iso(31 * 86_400_000), question: null },
    ],
  },
  {
    id: "box",
    name: "iris-hive-001",
    online: true,
    lastHeartbeat: iso(30_000),
    report: "fresh",
    reportedAt: iso(30_000),
    incomplete: ["claude_code"],
    sessions: [
      { sessionId: "cc1", provider: "claude_code", label: "reading a launch thread", status: "idle", activity: null, model: "claude-opus-5-5", branch: "main", updatedAt: iso(3_600_000), question: null },
      { sessionId: "oc1", provider: "opencode", label: "Fix the login page", status: "active", activity: "working", model: "iris/gpt-4.1-nano", branch: "main", updatedAt: iso(60_000), question: null },
      { sessionId: "cc2", provider: "claude_code", label: "Deploy check", status: "needs_you", activity: null, model: null, branch: "main", updatedAt: iso(120_000), question: "Deploy to prod?" },
      { sessionId: "cc3", provider: "claude_code", label: "last week's refactor", status: "stale", activity: null, model: null, branch: "main", updatedAt: iso(7 * 86_400_000), question: null },
    ],
  },
]

function mount() {
  const calls: { path: string; init?: RequestInit }[] = []
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path === "/iris/hive/sessions") return json({ measured: true, nodes: NODES })
    if (path.startsWith("/iris/hive/sessions/oc1/transcript")) {
      return json({ measured: true, ranOn: "iris-hive-001", offset: 120, incremental: false, messages: [{ role: "user", type: "text", text: "fix the login page", tool: null, at: null }, { role: "assistant", type: "tool_use", text: null, tool: "edit", at: null }] })
    }
    if (path.startsWith("/iris/hive/sessions/old1/transcript")) return json({ measured: false, reason: "No machine named \"MacBook\" is reachable", ranOn: null, offset: null, incremental: false, messages: [] })
    if (path === "/iris/hive/sessions/oc1/reply") return json({ measured: true, taskId: "t-1" })
    return json({ measured: false, reason: "unexpected " + path })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHiveSessions, { doFetch, now: () => NOW }), host)
  return { host, dispose, calls }
}

test("Sessions: summary, machines ordered by what needs you, a stale machine is dashed and says so", async () => {
  const { host, dispose } = mount()
  await wait(() => host.querySelectorAll(".hss-node").length === 2)

  expect(host.querySelector(".hss-sum")?.textContent).toBe("5 sessions on 2 machines·1 working·1 needs you")
  expect(host.querySelector(".hss-note")?.textContent).toContain("1 machine has not reported recently")

  const [first, second] = [...host.querySelectorAll(".hss-node")]
  expect(first.querySelector(".hss-nodename")?.textContent).toBe("iris-hive-001")
  expect(first.querySelector(".hss-dot")?.classList.contains("hss-dot--work")).toBe(true)
  expect(first.querySelector(".hss-count")?.textContent).toBe("4+") // a provider was cut: a floor, not a count
  // fresh machines open with needs-you first, then the working one
  expect([...first.querySelectorAll(".hss-label")].map((e) => e.textContent)).toEqual(["Deploy check", "Fix the login page", "reading a launch thread"])
  // a session untouched for over a day is behind a count, not in the list
  const more = first.querySelector<HTMLButtonElement>(".hss-older")!
  expect(more.textContent).toBe("Show 1 older (untouched for over a day)")
  more.click()
  await wait(() => first.querySelectorAll(".hss-label").length === 4)
  expect(first.querySelectorAll(".hss-label")[3].textContent).toBe("last week's refactor")

  expect(second.getAttribute("data-report")).toBe("stale")
  expect(second.querySelector(".hss-report")?.textContent).toBe("last report 31 days ago — not current")
  expect(second.querySelector(".hss-dot")?.classList.contains("hss-dot--work")).toBe(false)
  dispose()
})

test("Sessions: open an opencode session, read it, reply into it", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hss-row").length > 0)
  const row = [...host.querySelectorAll<HTMLButtonElement>(".hss-row")].find((r) => r.textContent?.includes("Fix the login page"))!
  row.click()
  await wait(() => host.querySelectorAll(".hss-msg").length === 2)
  expect(host.querySelector(".hss-text")?.textContent).toBe("fix the login page")
  expect(host.querySelector(".hss-tool")?.textContent).toBe("edit")
  const read = calls.find((c) => c.path.startsWith("/iris/hive/sessions/oc1/transcript"))!
  expect(read.path).toContain("machine=iris-hive-001")
  expect(read.path).toContain("provider=opencode")
  expect(read.path).not.toContain("since=") // first read is a page, not a cursor

  const box = host.querySelector<HTMLTextAreaElement>(".hss-input")!
  box.value = "also check the signup page"
  box.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector<HTMLButtonElement>(".hss-send")!.click()
  await wait(() => !!host.querySelector(".hss-sent"))
  const sent = calls.find((c) => c.path === "/iris/hive/sessions/oc1/reply")!
  expect(JSON.parse(String(sent.init?.body))).toEqual({ nodeId: "box", provider: "opencode", label: "Fix the login page", message: "also check the signup page" })
  expect(host.querySelector(".hss-sent")?.textContent).toContain("Sent to iris-hive-001")
  dispose()
})

test("Sessions: a Claude Code session points to Claude; a stale machine offers no reply and says why it cannot read", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hss-row").length > 0)
  ;[...host.querySelectorAll<HTMLButtonElement>(".hss-row")].find((r) => r.textContent?.includes("Deploy check"))!.click()
  await wait(() => !!host.querySelector(".hss-hint"))
  expect(host.querySelector(".hss-input")).toBeNull()
  expect(host.querySelector(".hss-hint")?.textContent).toContain("Remote Control")
  expect(host.querySelector(".hss-question")?.textContent).toContain("Deploy to prod?")

  // the stale machine starts collapsed; open it
  const stale = [...host.querySelectorAll(".hss-node")].find((n) => n.getAttribute("data-report") === "stale")!
  stale.querySelector<HTMLButtonElement>(".hss-nodehead")!.click()
  await wait(() => !!stale.querySelector(".hss-row"))
  stale.querySelector<HTMLButtonElement>(".hss-row")!.click()
  await wait(() => !!host.querySelector(".hss-transcript .hsc-warn"))
  expect(host.querySelector(".hss-transcript .hsc-warn")?.textContent).toContain("is reachable")
  expect(host.querySelector(".hss-input")).toBeNull()
  expect(host.querySelector(".hss-hint")?.textContent).toContain("not current")
  expect(calls.some((c) => c.path.endsWith("/reply"))).toBe(false)
  dispose()
})
