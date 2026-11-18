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
      { sessionId: "cc2", provider: "claude_code", label: "Deploy check", status: "needs_you", activity: null, model: null, branch: "main", updatedAt: iso(120_000), question: "Deploy to prod?", questions: [{ question: "Deploy to prod?", header: "Deploy", options: [{ n: 1, label: "Yes" }, { n: 2, label: "Not yet" }] }], readOnly: null },
      { sessionId: "cx1", provider: "codex", label: "codex audit", status: "idle", activity: null, model: "gpt-5", branch: null, updatedAt: iso(600_000), question: null, readOnly: "Codex sessions are listed, not driven: the machine has no way to type into one" },
      { sessionId: "cc3", provider: "claude_code", label: "last week's refactor", status: "stale", activity: null, model: null, branch: "main", updatedAt: iso(7 * 86_400_000), question: null },
    ],
  },
]

function mount() {
  const calls: { path: string; init?: RequestInit }[] = []
  const doFetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
    if (path === "/iris/hive/sessions") return json({ measured: true, nodes: NODES, retired: [{ name: "MacBookPro", rows: 50, at: iso(43 * 86_400_000) }] })
    if (path.startsWith("/iris/hive/sessions/cc1/transcript")) {
      const asked = calls.some((c) => c.path === "/iris/hive/sessions/cc1/reply")
      return json({
        measured: true,
        ranOn: "iris-hive-001",
        offset: null,
        incremental: false,
        messages: asked
          ? [{ role: "user", type: "text", text: "[via iris · hive] reply with the word pong", tool: null, at: null }, { role: "assistant", type: "text", text: "pong", tool: null, at: null }]
          : [{ role: "user", type: "text", text: "read the launch thread", tool: null, at: null }],
      })
    }
    if (path === "/iris/hive/sessions/cc1/reply") return json({ measured: true, taskId: "t-2" })
    if (path.startsWith("/iris/hive/sessions/cc2/transcript") || path.startsWith("/iris/hive/sessions/cx1/transcript")) return json({ measured: true, ranOn: "iris-hive-001", offset: null, incremental: false, messages: [] })
    if (path === "/iris/hive/sessions/cc2/answer") return json({ measured: true, taskId: "t-3", status: "answered", via: "keystroke", answers: [{ question: "Deploy to prod?", answer: "Not yet" }], error: null })
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

  expect(host.querySelector(".hss-sum")?.textContent).toBe("6 sessions on 2 machines·1 working·1 needs you")
  expect(host.querySelector(".hss-note")?.textContent).toContain("1 machine has not reported recently")
  // an old record is named with what it holds, as `iris hive sessions` does — not silently dropped
  expect(host.querySelector(".hss-retired")?.textContent).toBe("MacBookPro: an older record last reported 43d ago — its 50 sessions are not shown.")

  const [first, second] = [...host.querySelectorAll(".hss-node")]
  expect(first.querySelector(".hss-nodename")?.textContent).toBe("iris-hive-001")
  expect(first.querySelector(".hss-dot")?.classList.contains("hss-dot--work")).toBe(true)
  expect(first.querySelector(".hss-count")?.textContent).toBe("5+") // a provider was cut: a floor, not a count
  // fresh machines open with needs-you first, then the working one
  expect([...first.querySelectorAll(".hss-label")].map((e) => e.textContent)).toEqual(["Deploy check (main)", "Fix the login page (main)", "codex audit", "reading a launch thread (main)"])
  // each row carries the CLI's columns: status, provider, model, age
  const row = [...first.querySelectorAll(".hss-row")].find((r) => r.textContent?.includes("reading a launch thread"))!
  expect(row.querySelector(".hss-status")?.textContent).toBe("idle")
  expect(row.querySelector(".hss-prov")?.textContent).toBe("Claude Code")
  expect(row.querySelector(".hss-model")?.textContent).toBe("claude-opus-5-5")
  expect(row.querySelector(".hss-age")?.textContent).toBe("1h")
  // a session untouched for over a day is behind a count, not in the list
  const more = first.querySelector<HTMLButtonElement>(".hss-older")!
  expect(more.textContent).toBe("Show 1 older (untouched for over a day)")
  more.click()
  await wait(() => first.querySelectorAll(".hss-label").length === 5)
  expect(first.querySelectorAll(".hss-label")[4].textContent).toBe("last week's refactor (main)")

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

test("Sessions: a Claude Code session waiting on a question shows its choices, and answering sends the CLI's answer", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hss-row").length > 0)
  ;[...host.querySelectorAll<HTMLButtonElement>(".hss-row")].find((r) => r.textContent?.includes("Deploy check"))!.click()
  await wait(() => !!host.querySelector(".hss-ask"))
  expect(host.querySelector(".hss-ask .hss-question")?.textContent).toContain("Deploy: Deploy to prod?")
  const opts = [...host.querySelectorAll<HTMLButtonElement>(".hss-opt")]
  expect(opts.map((o) => o.textContent)).toEqual(["1Yes", "2Not yet"])
  const go = host.querySelector<HTMLButtonElement>(".hss-answerbtn")!
  expect(go.disabled).toBe(true)
  opts[1].click()
  await wait(() => opts[1].getAttribute("aria-checked") === "true")
  go.click()
  await wait(() => !!host.querySelector(".hss-ask .hss-sent"))
  const sent = calls.find((c) => c.path === "/iris/hive/sessions/cc2/answer")!
  expect(JSON.parse(String(sent.init?.body))).toEqual({ nodeId: "box", provider: "claude_code", choices: ["Not yet"] })
  expect(host.querySelector(".hss-ask .hss-sent")?.textContent).toBe("Answered with a keystroke in its terminal on iris-hive-001.")
  // a Claude Code session also takes a message
  expect(host.querySelector(".hss-input")).not.toBeNull()
  dispose()
})

test("Sessions: a message to a Claude Code session brings its reply back into the pane", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hss-row").length > 0)
  ;[...host.querySelectorAll<HTMLButtonElement>(".hss-row")].find((r) => r.textContent?.includes("reading a launch thread"))!.click()
  await wait(() => host.querySelectorAll(".hss-msg").length === 1)
  const box = host.querySelector<HTMLTextAreaElement>("footer .hss-input")!
  box.value = "reply with the word pong"
  box.dispatchEvent(new Event("input", { bubbles: true }))
  host.querySelector<HTMLButtonElement>("footer .hss-send")!.click()
  await wait(() => !!host.querySelector(".hss-answer"))
  expect(JSON.parse(String(calls.find((c) => c.path === "/iris/hive/sessions/cc1/reply")!.init?.body))).toEqual({
    nodeId: "box",
    provider: "claude_code",
    label: "reading a launch thread",
    message: "reply with the word pong",
  })
  // the follow loop reads again (5 s gap); the reply is anchored on what was sent
  await wait(() => !!host.querySelector(".hss-answertext"), 8000)
  expect(host.querySelector(".hss-answertext")?.textContent).toBe("pong")
  dispose()
}, 10_000)

test("Sessions: a Codex row is read-only and says why", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hss-row").length > 0)
  ;[...host.querySelectorAll<HTMLButtonElement>(".hss-row")].find((r) => r.textContent?.includes("codex audit"))!.click()
  await wait(() => !!host.querySelector(".hss-readonly"))
  expect(host.querySelector(".hss-readonly")?.textContent).toBe("Read-only — Codex sessions are listed, not driven: the machine has no way to type into one.")
  expect(host.querySelector("footer .hss-input")).toBeNull()
  expect(calls.some((c) => c.path.endsWith("/reply"))).toBe(false)
  dispose()
})

test("Sessions: a stale machine offers no reply and says why it cannot read", async () => {
  const { host, dispose, calls } = mount()
  await wait(() => host.querySelectorAll(".hss-row").length > 0)

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

test("Sessions: a failed read says so, and the refresh control reads again", async () => {
  let n = 0
  const doFetch = async (path: string) => {
    n++
    return new Response(JSON.stringify({ measured: false, reason: "iris-api 502", nodes: [] }), { headers: { "Content-Type": "application/json" } })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(IrisHiveSessions, { doFetch, now: () => NOW }), host)
  await wait(() => !!host.querySelector(".hss-topbar .hsc-warn"))
  expect(host.querySelector(".hss-topbar .hsc-warn")?.textContent).toBe("Could not read your sessions — iris-api 502")
  expect(host.querySelector(".hss-empty")).toBeNull() // an error is not "no machines"
  const before = n
  host.querySelector<HTMLButtonElement>(".hss-refresh")!.click()
  await wait(() => n > before)
  dispose()
})
