// iris-perf — stress and performance suite for the IRIS desktop app (#192535).
//
// Runs real Chrome against a COMPILED build (one bundle, same origin as the engine — the way the
// desktop app loads), so the numbers are the app's, not Vite's. Each scenario starts from a saved
// signed-in state in a fresh browser; memory is read from Chrome after a forced GC; chats a
// scenario creates are deleted when it ends.
//
//   node packages/app/script/perf/iris-perf.mjs "<app-url>?auth_token=…" <setup|cold|nav|drag|churn|tabs|slow|split|all> [loops]
// See README.md next to this file for building, serving, and the environment variables.
//
// Waits never return elements (a returned element is a DevTools handle that pins its whole page,
// which once made this suite report a leak it was causing). Prints a pass/fail table and writes $IRIS_PERF_OUT/perf-<scenario>.json.
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const [URL_, WHICH = "all", LOOPS = "30"] = process.argv.slice(2)
if (!URL_) {
  console.error('usage: node iris-perf.mjs "<app-url>?auth_token=…" <scenarios|all> [loops]   (see README.md)')
  process.exit(2)
}
// The repo root, for the Playwright that bun installed (this file lives in packages/app/script/perf).
const W = process.env.IRIS_PERF_WORKTREE ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..")
const require = createRequire(W + "/package.json")
const pwDir = fs.readdirSync(W + "/node_modules/.bun").find((d) => d.startsWith("playwright@"))
const { chromium } = require(`${W}/node_modules/.bun/${pwDir}/node_modules/playwright`)
const CHROME = process.env.IRIS_PERF_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT = process.env.IRIS_PERF_OUT ?? path.join(os.tmpdir(), "iris-perf")
fs.mkdirSync(OUT, { recursive: true })
const BASE = new URL(URL_)
const STATE = path.join(OUT, `perf-state-${BASE.port}.json`)
const TOKEN = BASE.searchParams.get("auth_token")
const [USER, PASS] = Buffer.from(TOKEN, "base64").toString().split(":")
// The engine the app talks to (basic auth from the URL token). Defaults to the app URL's host on :4096.
const ENGINE = process.env.IRIS_PERF_ENGINE ?? `${BASE.protocol}//${BASE.hostname}:4096`
// A throwaway project folder the engine may create sessions in. Never point this at real work.
const PROJECT = process.env.IRIS_PERF_PROJECT ?? path.join(OUT, "proj")
fs.mkdirSync(PROJECT, { recursive: true })
const CHAT_A = "panel test"
const CHAT_B = "panel test two"

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? NaN
const results = []
const check = (scenario, metric, value, limit, pass, note = "") =>
  results.push({ scenario, metric, value, limit, pass, note })

async function engine(method, p, body) {
  const sep = p.includes("?") ? "&" : "?"
  const res = await fetch(`${ENGINE}${p}${sep}directory=${encodeURIComponent(PROJECT)}`, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text()
}
const sessionIds = async () => new Set(((await engine("GET", "/session")) ?? []).map((s) => s.id))
async function deleteNewSessions(before) {
  const now = await sessionIds()
  let n = 0
  for (const id of now) if (!before.has(id)) (await engine("DELETE", `/session/${id}`), n++)
  return n
}

// ONE Chrome for the whole run. Every chromium.launch on macOS wakes syspolicyd/tccd; ten launches
// in a row took a shared machine to a load of 47. A context is as clean as a new browser (its own
// storage, cache and cookies) without a new process.
let shared
const chrome = async () => (shared ??= await chromium.launch({ executablePath: CHROME }))
async function launch({ panel = true, viewport = { width: 1500, height: 900 }, state = true } = {}) {
  const context = await (
    await chrome()
  ).newContext({
    viewport,
    httpCredentials: { username: USER, password: PASS },
    storageState: state && fs.existsSync(STATE) ? STATE : undefined,
  })
  await context.addInitScript((panel) => {
    localStorage.setItem("iris.onboarding.v1", "skipped")
    localStorage.setItem("iris.home.panel", JSON.stringify({ open: panel }))
    if (!localStorage.getItem("iris.split")) localStorage.setItem("iris.split", "0.3333")
    window.__lt = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({
      type: "longtask",
      buffered: true,
    })
  }, panel)
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)))
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  // `browser.close()` in a scenario closes its context, never the shared Chrome.
  return { browser: { close: () => context.close() }, context, page, cdp, errors }
}
async function memory(cdp) {
  await cdp.send("HeapProfiler.collectGarbage")
  await sleep(300)
  await cdp.send("HeapProfiler.collectGarbage")
  const { metrics } = await cdp.send("Performance.getMetrics")
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners }
}
async function memoryOn(page, cdp) {
  const m = await memory(cdp)
  const attached = await page.evaluate(() => document.getElementsByTagName("*").length)
  return { ...m, attached, detached: m.nodes - attached }
}
const longTasks = (page, since = 0) =>
  page.evaluate((since) => window.__lt.filter((x) => x[0] >= since).map((x) => Math.round(x[1])), since)
const now = (page) => page.evaluate(() => performance.now())
async function openApp(page) {
  const t0 = Date.now()
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.locator(".ihd-stat").first().waitFor({ timeout: 120000 })
  return Date.now() - t0
}
async function tagShell(page) {
  return page.evaluate(() => {
    const aside = document.querySelector("aside[aria-label=IRIS]")
    // The shell names its right-hand container; nesting is not a contract (a wrapper once moved the aside).
    const box =
      document.querySelector("[data-perf-shell]") ??
      document.querySelector("[data-component=iris-shell-panel]") ??
      aside?.parentElement
    box?.setAttribute("data-perf-shell", "1")
    return !!box
  })
}
const shellAlive = (page) => page.evaluate(() => !!document.querySelector("[data-perf-shell]"))
async function goHome(page) {
  const t0 = Date.now()
  if ((await page.evaluate(() => location.pathname)) !== "/")
    await page.locator('button:has(use[href*="icon-home"])').first().click()
  await page.waitForFunction(() => location.pathname === "/" && !!document.querySelector(".ihd-stat"), null, {
    timeout: 30000,
  })
  return Date.now() - t0
}
async function openChat(page, title) {
  const t0 = Date.now()
  const row = page.locator(`text="${title}"`).first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await page.waitForFunction(
    () => location.pathname.startsWith("/server/") && !!document.querySelector("[contenteditable=true]"),
    null,
    { timeout: 30000 },
  )
  return Date.now() - t0
}

// ---------- scenarios ----------
const scenarios = {
  // Signed-in state with the test project open, saved once for every other scenario.
  async setup() {
    // The two chats nav and split walk between; created through the engine if this machine lacks them.
    const titles = new Set(((await engine("GET", "/session")) ?? []).map((x) => x.title))
    for (const t of [CHAT_A, CHAT_B]) if (!titles.has(t)) await engine("POST", "/session", { title: t })
    const { browser, context, page } = await launch({ state: false })
    await openApp(page)
    if (!(await page.locator(`text="${CHAT_A}"`).count())) {
      await page.locator("text=Add project").first().click()
      await sleep(1200)
      await page.locator("[role=dialog] input").first().fill(PROJECT)
      await page.locator("[role=dialog] >> text=proj").first().waitFor({ timeout: 60000 })
      await sleep(800)
      await page.keyboard.press("Enter")
      await sleep(3000)
      await goHome(page) // builds before #481 jumped into a chat here
      await page.locator(`text="${CHAT_A}"`).first().waitFor({ timeout: 30000 })
    }
    await context.storageState({ path: STATE })
    check("setup", "test project open", "yes", "yes", true)
    await browser.close()
  },

  // Launch to Home, panel open and closed, 5 runs each.
  async cold() {
    for (const panel of [true, false]) {
      const times = [],
        worst = [],
        total = []
      for (let i = 0; i < 5; i++) {
        const { browser, page } = await launch({ panel })
        times.push(await openApp(page))
        await sleep(3000)
        const lt = await longTasks(page)
        worst.push(Math.max(0, ...lt))
        total.push(lt.reduce((a, b) => a + b, 0))
        await browser.close()
      }
      const label = panel ? "panel open" : "panel closed"
      check(
        "cold",
        `Home visible, ${label} (median of 5)`,
        median(times),
        2500,
        median(times) <= 2500,
        `runs ${times.join("/")}`,
      )
      check(
        "cold",
        `worst freeze, ${label} (median)`,
        median(worst),
        400,
        median(worst) <= 400,
        `blocked total ${median(total)} ms`,
      )
    }
  },

  // Home → chat A → Home → chat B, N loops. The shell must never rebuild; memory must stay flat.
  async nav() {
    const loops = Number(LOOPS)
    const { browser, page, cdp, errors } = await launch({ panel: true })
    await openApp(page)
    await sleep(4000)
    await goHome(page) // builds before #481 redirect to the last tab on launch
    await tagShell(page)
    const toChat = [],
      toHome = [],
      mem = []
    let rebuilt = 0
    for (let i = 1; i <= loops; i++) {
      toChat.push(await openChat(page, CHAT_A))
      if (!(await shellAlive(page))) rebuilt++
      toHome.push(await goHome(page))
      toChat.push(await openChat(page, CHAT_B))
      toHome.push(await goHome(page))
      if (!(await shellAlive(page))) rebuilt++
      if (i === 5 || i % 5 === 0 || i === loops) mem.push({ loop: i, ...(await memoryOn(page, cdp)) })
    }
    const first = mem[0],
      last = mem[mem.length - 1]
    const heapGrowth = +(((last.heapMB - first.heapMB) / first.heapMB) * 100).toFixed(1)
    const nodeGrowth = +(((last.nodes - first.nodes) / first.nodes) * 100).toFixed(1)
    check("nav", `${loops * 4} switches: shell rebuilt`, rebuilt, 0, rebuilt === 0)
    check(
      "nav",
      "Home → chat, p50 / p95 ms",
      `${median(toChat)} / ${pct(toChat, 0.95)}`,
      "300 / 800",
      median(toChat) <= 300 && pct(toChat, 0.95) <= 800,
    )
    check(
      "nav",
      "chat → Home, p50 / p95 ms",
      `${median(toHome)} / ${pct(toHome, 0.95)}`,
      "300 / 800",
      median(toHome) <= 300 && pct(toHome, 0.95) <= 800,
    )
    check(
      "nav",
      `JS heap growth, loop ${first.loop} → ${last.loop}`,
      `${heapGrowth}%`,
      "≤ 15%",
      heapGrowth <= 15,
      mem.map((m) => `${m.loop}:${m.heapMB}MB`).join(" "),
    )
    check(
      "nav",
      `DOM nodes growth, loop ${first.loop} → ${last.loop}`,
      `${nodeGrowth}%`,
      "≤ 15%",
      nodeGrowth <= 15,
      mem.map((m) => `${m.loop}:${m.nodes}`).join(" "),
    )
    check(
      "nav",
      "nodes on the page vs detached (held in memory)",
      `${last.attached} / ${last.detached}`,
      "info",
      true,
      mem.map((m) => `${m.loop}:${m.attached}+${m.detached}`).join(" "),
    )
    check("nav", "event listeners", last.listeners, "info", true, mem.map((m) => `${m.loop}:${m.listeners}`).join(" "))
    try {
      await cdp.send("DOM.enable")
      await cdp.send("HeapProfiler.collectGarbage")
      const { detachedNodes } = await cdp.send("DOM.getDetachedDomNodes")
      const label = (n) => {
        const a = n.attributes ?? []
        const attr = (k) => {
          const i = a.indexOf(k)
          return i >= 0 ? a[i + 1] : ""
        }
        return `${n.nodeName.toLowerCase()}${attr("data-component") ? `[${attr("data-component")}]` : ""}${attr("data-slot") ? `{${attr("data-slot")}}` : ""}${attr("class") ? "." + attr("class").split(/\s+/).slice(0, 3).join(".") : ""}`
      }
      const tally = {}
      for (const d of detachedNodes) {
        const k = label(d.treeNode)
        tally[k] = tally[k] ?? { trees: 0, nodes: 0 }
        tally[k].trees++
        tally[k].nodes += d.retainedNodeIds?.length ?? 0
      }
      const top = Object.entries(tally)
        .sort((a, b) => b[1].nodes - a[1].nodes)
        .slice(0, 8)
      for (const [k, v] of top)
        check("nav", `detached root: ${k}`.slice(0, 120), `${v.trees} trees`, "info", true, `${v.nodes} nodes`)
    } catch (e) {
      check("nav", "detached-node report", "unavailable", "info", true, String(e).slice(0, 100))
    }
    check("nav", "page errors", errors.length, 0, errors.length === 0, errors[0] ?? "")
    await browser.close()
  },

  // Drag the split 200 times, fast. The page must keep up and the saved split must match the screen.
  async drag() {
    const { browser, page, cdp, errors } = await launch({ panel: true })
    await openApp(page)
    await sleep(2500)
    await tagShell(page)
    const handle = page
      .locator(
        "[data-perf-shell] > div > [data-component=resize-handle], [data-perf-shell] > [data-component=resize-handle], [data-perf-shell] > div > [role=separator], [data-perf-shell] > [role=separator]",
      )
      .first()
    const box = await handle.boundingBox()
    if (!box) return check("drag", "resize handle found", "no", "yes", false)
    const since = await now(page)
    // Layout and style time is what a drag costs, and unlike "worst freeze" it does not swing with
    // the machine's load (a freeze of 505 ms on a busy machine was 133 ms on a calm one).
    const perf = async () =>
      Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
    const p0 = await perf()
    const y = box.y + 300
    let x = box.x + box.width / 2
    for (let i = 0; i < 200; i++) {
      await page.mouse.move(x, y)
      await page.mouse.down()
      x += i % 2 ? -120 : 120
      await page.mouse.move(x, y, { steps: 4 })
      await page.mouse.up()
    }
    await sleep(500)
    const p1 = await perf()
    const layoutMs = Math.round((p1.LayoutDuration - p0.LayoutDuration) * 1000)
    const styleMs = Math.round((p1.RecalcStyleDuration - p0.RecalcStyleDuration) * 1000)
    const layouts = p1.LayoutCount - p0.LayoutCount
    const lt = await longTasks(page, since)
    const state = await page.evaluate(() => {
      const shell = document.querySelector("[data-perf-shell]")
      const row = shell?.parentElement
      return {
        share: Number(localStorage.getItem("iris.split")),
        panel: shell?.getBoundingClientRect().width,
        row: row?.getBoundingClientRect().width,
      }
    })
    const expected = (1 - state.share) * state.row
    const off = Math.abs(expected - state.panel) / state.row
    check(
      "drag",
      "200 drags: layout + style time",
      `${layoutMs + styleMs} ms`,
      "info",
      true,
      `layout ${layoutMs} ms over ${layouts} layouts (${(layoutMs / Math.max(1, layouts)).toFixed(1)} ms each), style ${styleMs} ms`,
    )
    check(
      "drag",
      "200 drags: worst freeze ms",
      Math.max(0, ...lt),
      150,
      Math.max(0, ...lt) <= 150,
      `${lt.length} long tasks`,
    )
    check(
      "drag",
      "saved split matches screen",
      `${(off * 100).toFixed(1)}% off`,
      "≤ 2%",
      off <= 0.02,
      `share ${state.share.toFixed(3)}`,
    )
    check("drag", "page errors", errors.length, 0, errors.length === 0, errors[0] ?? "")
    await browser.close()
  },

  // Open/close the panel and switch products 100 times. Closed = unloaded; memory back to baseline.
  async churn() {
    const { browser, page, cdp, errors } = await launch({ panel: true })
    let atlasWhileClosed = 0,
      closed = false,
      leftOpen = 0
    page.on("request", (r) => {
      if (closed && /\/iris\/atlas/.test(r.url())) atlasWhileClosed++
    })
    await openApp(page)
    await page.locator("aside[aria-label=IRIS] [role=tab]").first().waitFor({ timeout: 30000 })
    await sleep(2000)
    const base = await memory(cdp)
    const toggle = page.locator('button[aria-label="Toggle the IRIS panel"]').first()
    for (let i = 0; i < 50; i++) {
      closed = true
      await toggle.click()
      await sleep(150)
      if (await page.locator("aside[aria-label=IRIS]").count()) leftOpen++
      await sleep(250)
      closed = false
      await toggle.click()
      await page.locator("aside[aria-label=IRIS] [role=tab]").first().waitFor({ timeout: 30000 })
      const tabs = page.locator("aside[aria-label=IRIS] [role=tab]")
      await tabs.nth(i % Math.max(1, await tabs.count())).click()
      await sleep(250)
    }
    await sleep(1500)
    const end = await memory(cdp)
    const heap = +(((end.heapMB - base.heapMB) / base.heapMB) * 100).toFixed(1)
    const nodes = +(((end.nodes - base.nodes) / base.nodes) * 100).toFixed(1)
    check("churn", "panel still mounted after close", leftOpen, 0, leftOpen === 0)
    check("churn", "Atlas requests while closed", atlasWhileClosed, 0, atlasWhileClosed === 0)
    check("churn", "JS heap vs baseline", `${heap}%`, "≤ 15%", heap <= 15, `${base.heapMB} → ${end.heapMB} MB`)
    check("churn", "DOM nodes vs baseline", `${nodes}%`, "≤ 15%", nodes <= 15, `${base.nodes} → ${end.nodes}`)
    check("churn", "page errors", errors.length, 0, errors.length === 0, errors[0] ?? "")
    await browser.close()
  },

  // 20 chat tabs restored, then launch: still lands on Home, still fast.
  async tabs() {
    const before = await sessionIds()
    const titles = []
    for (let i = 1; i <= 18; i++) {
      const t = `perf tab ${String(i).padStart(2, "0")}`
      await engine("POST", "/session", { title: t })
      titles.push(t)
    }
    const { browser, context, page, errors } = await launch({ panel: true })
    try {
      await openApp(page)
      for (const t of [CHAT_A, CHAT_B, ...titles]) {
        await openChat(page, t)
        await goHome(page)
      }
      const statePath = path.join(OUT, "perf-state-tabs.json")
      await context.storageState({ path: statePath })
      await browser.close()
      // relaunch with every tab restored
      const c2 = await (
        await chrome()
      ).newContext({
        viewport: { width: 1500, height: 900 },
        httpCredentials: { username: USER, password: PASS },
        storageState: statePath,
      })
      const p2 = await c2.newPage()
      const t0 = Date.now()
      await p2.goto(URL_, { waitUntil: "domcontentloaded", timeout: 120000 })
      await p2.locator(".ihd-stat").first().waitFor({ timeout: 120000 })
      const home = Date.now() - t0
      const trail = []
      for (let i = 0; i < 10; i++) (trail.push(await p2.evaluate(() => location.pathname)), await sleep(1000))
      const restored = await p2.evaluate(
        (titles) => titles.filter((t) => document.body.innerText.includes(t)).length,
        titles,
      )
      check("tabs", "Home visible with 20 tabs restored", home, 3000, home <= 3000)
      check(
        "tabs",
        "stays on Home for 10 s",
        trail.every((p) => p === "/") ? "yes" : trail.join(","),
        "yes",
        trail.every((p) => p === "/"),
      )
      check("tabs", "restored chats visible", `${restored}/18`, "18/18", restored === 18)
      check("tabs", "page errors", errors.length, 0, errors.length === 0, errors[0] ?? "")
      await c2.close()
    } finally {
      await browser.close().catch(() => {})
      check("tabs", "test chats deleted", await deleteNewSessions(before), "all", true)
    }
  },

  // Every engine call 2 s slow (a struggling machine): Home draws progressively, nothing navigates.
  async slow() {
    const { browser, page, errors } = await launch({ panel: true })
    await page.route("**/*", async (route) => {
      const r = route.request()
      const api =
        ["fetch", "xhr", "eventsource"].includes(r.resourceType()) && !new URL(r.url()).pathname.startsWith("/assets/")
      if (api) await sleep(2000)
      await route.continue().catch(() => {})
    })
    const home = await openApp(page)
    const trail = []
    for (let i = 0; i < 15; i++) (trail.push(await page.evaluate(() => location.pathname)), await sleep(1000))
    check("slow", "Home visible with every call +2 s", home, 6000, home <= 6000)
    check(
      "slow",
      "stays on Home for 15 s",
      trail.every((p) => p === "/") ? "yes" : trail.join(","),
      "yes",
      trail.every((p) => p === "/"),
    )
    check("slow", "page errors", errors.length, 0, errors.length === 0, errors[0] ?? "")
    await browser.close()
  },

  // Split view: 2 columns, each with its own panel; the shell steps aside; survives a resize.
  async split() {
    const before = await sessionIds()
    const { browser, page, errors } = await launch({ panel: true })
    try {
      await openApp(page)
      await sleep(2500)
      await tagShell(page)
      await openChat(page, CHAT_A)
      await page.mouse.click(300, 300)
      await page.keyboard.press("Meta+Alt+Backslash")
      await page
        .locator("[data-component=session-split-column] >> nth=1")
        .first()
        .waitFor({ timeout: 45000 })
        .catch(() => {})
      await sleep(2500)
      const cols = await page.evaluate(() =>
        [...document.querySelectorAll("[data-component=session-split-column]")].map((c) =>
          Math.round(c.getBoundingClientRect().width),
        ),
      )
      const shellHidden = await page.evaluate(() =>
        document.querySelector("[data-perf-shell]")?.classList.contains("hidden"),
      )
      const narrow = await page.evaluate(() => /too narrow/i.test(document.body.innerText))
      await page.setViewportSize({ width: 1100, height: 900 })
      await sleep(1500)
      await page.setViewportSize({ width: 1500, height: 900 })
      await sleep(1500)
      const colsAfter = await page.evaluate(
        () => document.querySelectorAll("[data-component=session-split-column]").length,
      )
      check("split", "columns after split", cols.length, 2, cols.length === 2, `widths ${cols.join("/")}`)
      check("split", "shell panel steps aside", shellHidden ? "yes" : "no", "yes", !!shellHidden)
      check("split", "no 'too narrow' with room", narrow ? "shown" : "none", "none", !narrow)
      check("split", "columns after window resize", colsAfter, 2, colsAfter === 2)
      check("split", "page errors", errors.length, 0, errors.length === 0, errors[0] ?? "")
    } finally {
      await browser.close().catch(() => {})
      check("split", "test chats deleted", await deleteNewSessions(before), "all", true)
    }
  },
}

// ---------- run ----------
const order = WHICH === "all" ? ["setup", "cold", "nav", "drag", "churn", "tabs", "slow", "split"] : WHICH.split(",")
for (const name of order) {
  const t0 = Date.now()
  try {
    await scenarios[name]()
  } catch (e) {
    check(name, "scenario ran", "crashed", "ran", false, String(e).split("\n")[0].slice(0, 160))
  }
  console.log(`· ${name} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  fs.writeFileSync(
    path.join(OUT, `perf-${name}.json`),
    JSON.stringify(
      results.filter((r) => r.scenario === name),
      null,
      1,
    ),
  )
}
const pad = (s, n) => String(s).padEnd(n).slice(0, n)
console.log("\n" + pad("scenario", 8) + pad("check", 44) + pad("value", 18) + pad("limit", 12) + "result")
for (const r of results)
  console.log(
    pad(r.scenario, 8) +
      pad(r.metric, 44) +
      pad(r.value, 18) +
      pad(r.limit, 12) +
      (r.pass ? "PASS" : "FAIL") +
      (r.note ? `   ${r.note}` : ""),
  )
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
await shared?.close()
process.exitCode = failed ? 1 : 0
