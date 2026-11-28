// mobile-audit — the IRIS interface at phone width, measured (#194511).
//
// The iPhone app runs this package inside a ~390 px web view. A layout that only ever ran in a
// desktop window breaks there in ways nobody sees until it is on a phone: the IRIS panel laid out
// beside Home crushed Home into a 60 px sliver with words cut mid-letter (build 0.2.0 (29)). This
// walks the app in WebKit with an iPhone profile, screenshots every state, and measures what a
// person would see:
//
//   narrow    a visible main column narrower than 300 px
//   overflow  the document, or an element nothing clips, wider than the viewport
//   clipped   text cut by an ancestor that clips (overflow hidden), not ellipsised, not a scroller
//   target    an interactive element smaller than 32×32 px
//   overlap   two visible interactive elements on top of each other
//
// Runs against a real engine and the app (vite dev or a compiled build), like script/perf:
//
//   node packages/app/script/mobile-audit.mjs "<app-url>?auth_token=…" [state,state…]
//
// Writes $MOBILE_AUDIT_OUT (default <os tmp>/iris-mobile-audit): one PNG per state, contact-sheet.png
// (every state, labelled), failures.json and failures.md. Exits 1 when anything fails
// (MOBILE_AUDIT_REPORT_ONLY=1 exits 0). Needs Playwright's WebKit (`playwright install webkit`).
//
// Waits and evaluates never return elements: a returned element is a handle that pins its page,
// which once made a suite here report a leak it was causing. Everything returns plain data.
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const [URL_, ONLY] = process.argv.slice(2)
if (!URL_) {
  console.error('usage: node mobile-audit.mjs "<app-url>?auth_token=…" [state,state…]')
  process.exit(2)
}
const W = process.env.MOBILE_AUDIT_WORKTREE ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..")
const require = createRequire(W + "/package.json")
const pwDir = fs.readdirSync(W + "/node_modules/.bun").find((d) => d.startsWith("playwright@"))
const { webkit, devices } = require(`${W}/node_modules/.bun/${pwDir}/node_modules/playwright`)
const OUT = process.env.MOBILE_AUDIT_OUT ?? path.join(os.tmpdir(), "iris-mobile-audit")
fs.mkdirSync(OUT, { recursive: true })
const BASE = new URL(URL_)
const TOKEN = BASE.searchParams.get("auth_token")
const [USER, PASS] = TOKEN ? Buffer.from(TOKEN, "base64").toString().split(":") : []
const ENGINE = process.env.MOBILE_AUDIT_ENGINE ?? `${BASE.protocol}//${BASE.hostname}:4096`
// A throwaway project the engine may create a chat in. Never point this at real work.
const PROJECT = process.env.MOBILE_AUDIT_PROJECT ?? path.join(OUT, "proj")
fs.mkdirSync(PROJECT, { recursive: true })
// iPhone 15: 393 × 852 points. Scale 1 keeps the measurements in CSS px and the images small.
const DEVICE = {
  ...devices["iPhone 15"],
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: Number(process.env.MOBILE_AUDIT_SCALE ?? 1),
}
const MIN_MAIN = 300
const MIN_TARGET = 32

async function engine(method, p, body) {
  const sep = p.includes("?") ? "&" : "?"
  const res = await fetch(`${ENGINE}${p}${sep}directory=${encodeURIComponent(PROJECT)}`, {
    method,
    headers: {
      ...(USER ? { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") } : {}),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text()
}
const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

// ---------- the measurement, run in the page; returns plain data only ----------
function measure({ MIN_MAIN, MIN_TARGET }) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const failures = []
  const shown = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false
    const s = getComputedStyle(el)
    return s.visibility !== "hidden" && s.opacity !== "0"
  }
  const describe = (el) => {
    const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
    const id = el.getAttribute("data-component") || el.getAttribute("data-testid") || el.id
    const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean).slice(0, 2)
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls.length ? "." + cls.join(".") : ""}${label ? ` "${label}"` : ""}`
  }
  // Is any part of el the top thing on screen? Sample a 3×3 grid inside its visible box.
  const onTop = (el) => {
    const r = el.getBoundingClientRect()
    const x0 = Math.max(0, r.left),
      x1 = Math.min(vw, r.right)
    const y0 = Math.max(0, r.top),
      y1 = Math.min(vh, r.bottom)
    if (x1 - x0 < 1 || y1 - y0 < 1) return false
    for (const fx of [0.5, 0.2, 0.8])
      for (const fy of [0.5, 0.2, 0.8]) {
        const hit = document.elementFromPoint(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy)
        if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return true
      }
    return false
  }
  const clips = (s) => s.overflowX !== "visible"
  const scrolls = (el, s) => (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1
  // The part of el a person can see: its box cut by every ancestor that clips (a tab scrolled
  // half out of its strip is only the half that is left).
  const visRect = (el) => {
    const r = el.getBoundingClientRect()
    let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom]
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowX === "visible" && s.overflowY === "visible") continue
      const pr = p.getBoundingClientRect()
      if (s.overflowX !== "visible") ((l = Math.max(l, pr.left)), (rt = Math.min(rt, pr.right)))
      if (s.overflowY !== "visible") ((t = Math.max(t, pr.top)), (b = Math.min(b, pr.bottom)))
    }
    return { left: l, top: t, right: rt, bottom: b }
  }

  // (a) the page column. The shell marks it; without the shell, <main>.
  const columns = [...document.querySelectorAll('[data-component="iris-shell-page"]')]
  // Builds from before the marker: the shell's page column is the panel's previous sibling.
  if (columns.length === 0)
    for (const p of document.querySelectorAll('[data-component="iris-shell-panel"]'))
      if (p.previousElementSibling) columns.push(p.previousElementSibling)
  if (columns.length === 0) columns.push(...document.querySelectorAll("main"))
  for (const col of columns) {
    if (!shown(col) || !onTop(col)) continue
    const r = col.getBoundingClientRect()
    const width = Math.min(vw, r.right) - Math.max(0, r.left)
    if (width < MIN_MAIN)
      failures.push({ check: "narrow", what: describe(col), value: Math.round(width), limit: MIN_MAIN })
  }

  // (b) horizontal overflow: the document, then the outermost element nothing clips.
  const docW = document.scrollingElement?.scrollWidth ?? 0
  if (docW > vw + 1) failures.push({ check: "overflow", what: "document", value: docW, limit: vw })
  const all = [...document.body.querySelectorAll("*")]
  const flagged = new Set()
  for (const el of all) {
    if (!shown(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right <= vw + 1 && r.left >= -1) continue
    // Clipped by an ancestor inside the viewport? Then nothing spills off screen.
    let clipped = false
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.position === "fixed" || !clips(s)) continue
      const pr = p.getBoundingClientRect()
      if (pr.right <= vw + 1 && pr.left >= -1) {
        clipped = true
        break
      }
    }
    if (clipped) continue
    let parentFlagged = false
    for (let p = el.parentElement; p; p = p.parentElement) if (flagged.has(p)) parentFlagged = true
    flagged.add(el)
    if (parentFlagged) continue
    failures.push({
      check: "overflow",
      what: describe(el),
      value: Math.round(r.right > vw ? r.right - vw : -r.left),
      limit: 0,
    })
  }

  // (c) text cut by a clipping ancestor (the "Goo" of "Good afternoon").
  const seen = new Set()
  for (const el of all) {
    if (!shown(el)) continue
    const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
    if (texts.length === 0) continue
    const range = document.createRange()
    range.setStartBefore(texts[0])
    range.setEndAfter(texts[texts.length - 1])
    const tr = range.getBoundingClientRect()
    if (tr.width < 1) continue
    let ellipsis = false
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.textOverflow === "ellipsis" || (s.webkitLineClamp !== "none" && s.webkitLineClamp)) ellipsis = true
      if (p === el && !clips(s)) continue
      if (!clips(s)) continue
      if (scrolls(p, s)) break // a scroller is meant to hide what is scrolled away
      if (ellipsis) break
      const pr = p.getBoundingClientRect()
      const cut = Math.max(tr.right - pr.right, pr.left - tr.left)
      // A 1 px box is visually-hidden text for screen readers, clipped on purpose.
      if (cut > 2 && pr.width > 2 && pr.height > 2) {
        const key = describe(el)
        if (!seen.has(key)) {
          seen.add(key)
          failures.push({ check: "clipped", what: key, value: Math.round(cut), limit: 0 })
        }
      }
      break
    }
  }

  // (b, continued) a control cut off by a box that clips and does not scroll (a titlebar whose
  // right end — the panel toggle — is past the phone's edge) cannot be reached at all.
  const interactive =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"]'
  for (const el of document.querySelectorAll(interactive)) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (getComputedStyle(el).visibility === "hidden") continue
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (!clips(s)) continue
      if (scrolls(p, s)) break
      const pr = p.getBoundingClientRect()
      if (pr.width < 2 || pr.height < 2) break
      if (pr.right < 0 || pr.left > vw || pr.bottom < 0 || pr.top > vh) break // the box itself is off screen
      const cut = Math.max(r.right - pr.right, pr.left - r.left)
      if (cut > r.width / 2 && r.top < pr.bottom && r.bottom > pr.top)
        failures.push({
          check: "overflow",
          what: `${describe(el)} cut off by ${describe(p).slice(0, 40)}`,
          value: Math.round(cut),
          limit: 0,
        })
      break
    }
  }

  // (d) small targets and (e) overlapping targets, among the interactive elements a person can hit.
  const targets = [...document.querySelectorAll(interactive)].filter((el) => shown(el) && onTop(el))
  // An element inside another target is part of it (an icon in a button), not a second target.
  const outer = targets.filter((el) => !targets.some((o) => o !== el && o.contains(el)))
  for (const el of outer) {
    const r = el.getBoundingClientRect()
    if (r.width < MIN_TARGET || r.height < MIN_TARGET)
      failures.push({
        check: "target",
        what: describe(el),
        value: `${Math.round(r.width)}×${Math.round(r.height)}`,
        limit: `${MIN_TARGET}×${MIN_TARGET}`,
      })
  }
  // A menu, dialog or floating bar over the page is a layer on purpose; only targets in the same
  // layer can collide. A layer is the nearest fixed, sticky or popup ancestor.
  const layer = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (p.matches('[role="menu"],[role="dialog"],[role="listbox"],[role="tooltip"]')) return p
      const pos = getComputedStyle(p).position
      if (pos === "fixed" || pos === "sticky") return p
    }
    return document.body
  }
  const layers = new Map(outer.map((el) => [el, layer(el)]))
  for (let i = 0; i < outer.length; i++)
    for (let j = i + 1; j < outer.length; j++) {
      if (layers.get(outer[i]) !== layers.get(outer[j])) continue
      const a = visRect(outer[i])
      const b = visRect(outer[j])
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (w > 2 && h > 2)
        failures.push({
          check: "overlap",
          what: `${describe(outer[i])} ⨯ ${describe(outer[j])}`,
          value: `${Math.round(w)}×${Math.round(h)}`,
          limit: 0,
        })
    }
  return failures
}

// ---------- the walk ----------
const fail = []
const shots = []
async function audit(page, state) {
  // Let layout and any open/close transition finish: two animation frames after fonts.
  await page.evaluate(() =>
    document.fonts.ready.then(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))),
    ),
  )
  const file = path.join(OUT, `${state}.png`)
  await page.screenshot({ path: file })
  const found = await page.evaluate(measure, { MIN_MAIN, MIN_TARGET })
  for (const f of found) fail.push({ state, ...f })
  shots.push({ state, file, count: found.length })
  console.log(`${state.padEnd(22)} ${found.length ? found.length + " failing" : "ok"}`)
}

const states = []
const cleanup = []
const step = (name, run) => states.push({ name, run })
const want = (name) => !ONLY || ONLY.split(",").some((s) => name.startsWith(s))

// Waits on locators, never on returned elements.
const ready = (loc, timeout = 30_000) => loc.waitFor({ state: "visible", timeout })
const panelToggle = (page) => page.getByRole("button", { name: "Toggle the IRIS panel" })
const panel = (page) => page.locator('aside[aria-label="IRIS"]')
async function openPanel(page) {
  if (await panel(page).isVisible()) return
  await panelToggle(page).click()
  await ready(panel(page).getByRole("tablist").first())
}
async function home(page) {
  const newChat = page.getByRole("button", { name: "New chat", exact: true })
  // On Home the Home button goes back to the last chat; press it only from somewhere else.
  if (!(await newChat.isVisible())) await page.getByRole("button", { name: "Home", exact: true }).click()
  await ready(newChat)
}

step("home", async (page) => home(page))
// The way people reach the panel on a phone: a Home number or a titlebar pill, not the toggle.
// A "New" callout waiting for its moment shows now; the panel's close must still take one tap.
step("panel-via-pill", async (page) => {
  await page.getByRole("button", { name: /^Hive machines/ }).click()
  await ready(panel(page).getByRole("tablist").first())
  await page
    .locator(".iris-callout[data-ready]")
    .waitFor({ timeout: 4_000 })
    .catch(() => {})
})
step("panel-via-pill-closed", async (page) => {
  await panel(page).getByRole("button", { name: "Close the panel" }).click({ timeout: 5_000 })
  await panel(page).waitFor({ state: "detached" })
})
step("sidebar-open", async (page) => {
  await page.getByRole("button", { name: "All chats" }).first().click()
  await ready(page.locator('[role="dialog"]').first())
})
step("sidebar-closed", async (page) => {
  await page.keyboard.press("Escape")
  await page.locator('[role="dialog"]').first().waitFor({ state: "hidden" })
})
step("new-chat", async (page) => {
  await home(page)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await ready(page.locator('[data-component="prompt-input"]').first())
})
step("session", async (page) => {
  const s = await engine("POST", "/session", { title: "mobile audit chat" })
  await page.goto(new URL(`/${b64url(PROJECT)}/session/${s.id}${BASE.search}`, BASE).toString())
  await page.waitForURL(/\/server\/.+\/session\//, { timeout: 30_000 })
  await ready(page.locator('[data-component="prompt-input"]').first())
  cleanup.push(() => engine("DELETE", `/session/${s.id}`))
})
// The panel and each of its tabs, from Home (where the titlebar toggle lives).
const TABS = (process.env.MOBILE_AUDIT_TABS ?? "Browser,Drives,Hive,Atlas").split(",")
const HIVE = ["Machines", "Sessions", "Scripts", "Peers"]
step("panel", async (page) => {
  await home(page)
  await openPanel(page)
})
for (const tab of TABS) {
  const open = async (page) => {
    await openPanel(page)
    const t = panel(page).getByRole("tab", { name: tab })
    if ((await t.count()) === 0) {
      // Not pinned: open it from the + menu.
      await panel(page).getByRole("button", { name: "Add a tab" }).click()
      const item = page.getByRole("menuitem", { name: tab })
      if ((await item.count()) === 0) return page.keyboard.press("Escape").then(() => false)
      await item.first().click()
    } else await t.first().click()
    await panel(page).getByRole("tab", { name: tab, selected: true }).first().waitFor({ timeout: 15_000 })
    return true
  }
  if (tab === "Hive")
    for (const sub of HIVE)
      step(`panel-hive-${sub.toLowerCase()}`, async (page) => {
        if (!(await open(page))) return "skip"
        await panel(page)
          .getByRole("button", { name: sub, exact: true })
          .or(panel(page).getByRole("tab", { name: sub, exact: true }))
          .first()
          .click()
      })
  else step(`panel-${tab.toLowerCase()}`, async (page) => ((await open(page)) ? undefined : "skip"))
}
step("panel-add-menu", async (page) => {
  await openPanel(page)
  await panel(page).getByRole("button", { name: "Add a tab" }).click()
  await ready(page.getByRole("menu"))
})
// One tap on the panel's own close, with nothing in the way. Not Escape first: Escape also
// dismisses a "New" callout, which on a phone sat over this very button (#194511).
step("panel-closed", async (page) => {
  await panel(page).getByRole("button", { name: "Add a tab" }).click()
  await page.getByRole("menu").waitFor({ state: "hidden" })
  await panel(page).getByRole("button", { name: "Close the panel" }).click({ timeout: 5_000 })
  await panel(page).waitFor({ state: "detached" })
})
step("settings", async (page) => {
  await home(page)
  await page.getByRole("button", { name: "Settings", exact: true }).first().click()
  // Settings is its own chunk; under vite dev its first load can take ~40 s.
  await ready(page.locator('[role="dialog"]').first(), 120_000)
})

// ---------- run ----------
const browser = await webkit.launch()
const context = await browser.newContext({ ...DEVICE })
await context.addInitScript((dir) => {
  localStorage.setItem("iris.onboarding.v1", "skipped")
  localStorage.setItem("iris.home.panel", JSON.stringify({ open: false }))
  localStorage.setItem(
    "opencode.global.dat:server",
    JSON.stringify({
      list: [],
      projects: { local: [{ worktree: dir, expanded: true }] },
      lastProject: { local: dir },
      recentlyClosed: {},
    }),
  )
}, PROJECT)
const page = await context.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)))
await page.goto(URL_)
await ready(page.getByRole("button", { name: "Home", exact: true }), 90_000)
for (const s of states) {
  if (!want(s.name)) continue
  try {
    if ((await s.run(page)) === "skip") {
      console.log(`${s.name.padEnd(22)} skipped (not on this build)`)
      continue
    }
    await audit(page, s.name)
  } catch (e) {
    fail.push({
      state: s.name,
      check: "walk",
      what: String(e.message ?? e)
        .split("\n")[0]
        .slice(0, 200),
      value: "",
      limit: "",
    })
    console.log(`${s.name.padEnd(22)} could not reach: ${String(e.message ?? e).split("\n")[0]}`)
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`) }).catch(() => {})
  }
}

// ---------- contact sheet: the screenshots laid out in a page, screenshotted ----------
const tiles = shots
  .map(
    (s) =>
      `<figure><img src="data:image/png;base64,${fs.readFileSync(s.file).toString("base64")}"><figcaption><b>${s.state}</b> ${s.count ? `<span class=f>${s.count} failing</span>` : "<span class=o>ok</span>"}</figcaption></figure>`,
  )
  .join("")
const sheet = await browser.newPage({ viewport: { width: 4 * 213 + 40, height: 600 }, deviceScaleFactor: 1 })
await sheet.setContent(
  `<style>body{margin:0;padding:16px;font:12px system-ui;background:#111;color:#eee;display:grid;grid-template-columns:repeat(4,205px);gap:8px}
   figure{margin:0}img{width:205px;display:block;border:1px solid #333}figcaption{padding:4px 0}.f{color:#ff6b6b}.o{color:#7bd389}
   h1{grid-column:1/-1;font-size:14px;margin:0 0 4px}</style><h1>IRIS mobile audit · ${DEVICE.viewport.width}×${DEVICE.viewport.height} · ${new Date().toISOString().slice(0, 16)}</h1>${tiles}`,
)
await sheet.screenshot({ path: path.join(OUT, "contact-sheet.png"), fullPage: true })
await browser.close()
for (const run of cleanup) await run().catch(() => {})

// ---------- report ----------
const checks = ["narrow", "overflow", "clipped", "target", "overlap", "walk"]
const counts = Object.fromEntries(checks.map((c) => [c, fail.filter((f) => f.check === c).length]))
// The same element failing in every state (a titlebar button) is one thing to fix, not twelve.
const unique = Object.fromEntries(
  checks.map((c) => [c, new Set(fail.filter((f) => f.check === c).map((f) => f.what)).size]),
)
fs.writeFileSync(
  path.join(OUT, "failures.json"),
  JSON.stringify({ device: DEVICE.viewport, counts, unique, failures: fail, pageErrors: errors }, null, 2),
)
const md = [
  `# IRIS mobile audit (${DEVICE.viewport.width}×${DEVICE.viewport.height})`,
  "",
  "| check | failures | distinct elements |",
  "|---|---|---|",
  ...checks.map((c) => `| ${c} | ${counts[c]} | ${unique[c]} |`),
  "",
  "| state | check | what | measured | limit |",
  "|---|---|---|---|---|",
  ...fail.map((f) => `| ${f.state} | ${f.check} | ${String(f.what).replace(/\|/g, "\\|")} | ${f.value} | ${f.limit} |`),
  "",
]
fs.writeFileSync(path.join(OUT, "failures.md"), md.join("\n"))
console.log(`\n${checks.map((c) => `${c} ${counts[c]} (${unique[c]} distinct)`).join(" · ")}\n${OUT}/contact-sheet.png`)
if (errors.length) console.log(`page errors: ${errors.length} (in failures.json)`)
process.exit(fail.length && process.env.MOBILE_AUDIT_REPORT_ONLY !== "1" ? 1 : 0)
