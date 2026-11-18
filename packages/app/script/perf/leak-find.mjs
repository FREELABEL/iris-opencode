// leak-find — what holds a page after you leave it? (#192623)
// Tags each Home root, chat root and tooltip trigger with a named marker object, runs Home ⇄ chat
// loops, takes a heap snapshot, and prints the shortest retainer path from a GC root to each marker
// on a page that is no longer on screen. The first non-DOM step on that path is the leak.
//   node --max-old-space-size=8192 leak-find.mjs <repo-root> "<app-url>?auth_token=…" [loops] [snapshot-file]
// Needs a project with chats titled "panel test" and "panel test two" (run iris-perf.mjs setup first).
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const [W, URL_, LOOPS = "6", SNAP = path.join(os.tmpdir(), "iris-perf/leak.heapsnapshot")] = process.argv.slice(2)
const require = createRequire(W + "/package.json")
const pwDir = fs.readdirSync(W + "/node_modules/.bun").find((d) => d.startsWith("playwright@"))
const { chromium } = require(`${W}/node_modules/.bun/${pwDir}/node_modules/playwright`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROJECT = process.env.IRIS_PERF_PROJECT ?? path.join(os.tmpdir(), "iris-perf/proj")
const base = new URL(URL_)
const [username, password] = Buffer.from(base.searchParams.get("auth_token"), "base64").toString().split(":")
const STATE = path.join(os.tmpdir(), `iris-perf/perf-state-${base.port}.json`)

if (process.env.ANALYZE_ONLY !== "1") {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })
  const context = await browser.newContext({
    viewport: { width: 1500, height: 900 },
    httpCredentials: { username, password },
    storageState: fs.existsSync(STATE) ? STATE : undefined,
  })
  await context.addInitScript(() => {
    localStorage.setItem("iris.onboarding.v1", "skipped")
    localStorage.setItem("iris.home.panel", JSON.stringify({ open: true }))
    // Named classes survive into the heap snapshot as constructor names.
    class LeakHomeRoot {}
    class LeakChatRoot {}
    class LeakTooltipTrigger {}
    const tag = () => {
      const home = document.querySelector(".ihd-stat")?.closest("div.self-stretch")
      if (home && !home.__leak) home.__leak = new LeakHomeRoot()
      const composer = location.pathname.startsWith("/server/")
        ? document.querySelector("[contenteditable=true]")
        : null
      const chat = composer?.closest("[data-component=session-split-column], .size-full")
      if (chat && !chat.__leak) chat.__leak = new LeakChatRoot()
      for (const t of document.querySelectorAll("[data-component=tooltip-v2-trigger]"))
        if (!t.__leak) t.__leak = new LeakTooltipTrigger()
    }
    setInterval(tag, 200)
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 180000 })
  await page.locator(".ihd-stat").first().waitFor({ timeout: 180000 })
  if (!(await page.locator('text="panel test"').count())) {
    await page.locator("text=Add project").first().click()
    await sleep(1200)
    await page.locator("[role=dialog] input").first().fill(PROJECT)
    await page.locator("[role=dialog] >> text=preview").first().waitFor({ timeout: 60000 }) // the dev server is slow to search
    await sleep(800)
    await page.keyboard.press("Enter")
    await page.locator('text="panel test"').first().waitFor({ timeout: 60000 })
    await context.storageState({ path: STATE })
  }
  await sleep(3000)
  const home = async () => {
    if ((await page.evaluate(() => location.pathname)) !== "/")
      await page.locator('button:has(use[href*="icon-home"])').first().click()
    await page.waitForFunction(() => location.pathname === "/" && !!document.querySelector(".ihd-stat"), null, {
      timeout: 60000,
    })
    await sleep(600)
  }
  const chat = async (title) => {
    await page.locator(`text="${title}"`).first().click()
    await page.waitForFunction(
      () => location.pathname.startsWith("/server/") && !!document.querySelector("[contenteditable=true]"),
      null,
      { timeout: 60000 },
    )
    await sleep(600)
  }
  for (let i = 0; i < Number(LOOPS); i++) {
    await chat("panel test")
    await home()
    await chat("panel test two")
    await home()
    console.log(`loop ${i + 1}`)
  }
  await sleep(1500)
  for (let i = 0; i < 3; i++) (await cdp.send("HeapProfiler.collectGarbage"), await sleep(300))
  const out = fs.createWriteStream(SNAP)
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => out.write(chunk))
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false })
  await new Promise((r) => out.end(r))
  console.log("snapshot", (fs.statSync(SNAP).size / 1048576).toFixed(0), "MB")
  await browser.close()
}

// ---------- analysis ----------
const snap = JSON.parse(fs.readFileSync(SNAP, "utf8"))
const meta = snap.snapshot.meta
const NF = meta.node_fields.length,
  EF = meta.edge_fields.length
const { nodes, edges, strings } = snap
const nType = meta.node_fields.indexOf("type"),
  nName = meta.node_fields.indexOf("name"),
  nEC = meta.node_fields.indexOf("edge_count")
const nDet = meta.node_fields.indexOf("detachedness")
const eType = meta.edge_fields.indexOf("type"),
  eName = meta.edge_fields.indexOf("name_or_index"),
  eTo = meta.edge_fields.indexOf("to_node")
const nodeTypes = meta.node_types[nType],
  edgeTypes = meta.edge_types[eType]
const N = nodes.length / NF
const first = new Uint32Array(N + 1)
for (let i = 0, e = 0; i < N; i++) ((first[i] = e), (e += nodes[i * NF + nEC] * EF))
first[N] = edges.length
// reverse edges
const rc = new Uint32Array(N + 1)
for (let i = 0; i < N; i++) for (let e = first[i]; e < first[i + 1]; e += EF) rc[edges[e + eTo] / NF]++
const rstart = new Uint32Array(N + 1)
for (let i = 0; i < N; i++) rstart[i + 1] = rstart[i] + rc[i]
const rfrom = new Uint32Array(rstart[N]),
  redge = new Uint32Array(rstart[N]),
  fill = rstart.slice()
for (let i = 0; i < N; i++)
  for (let e = first[i]; e < first[i + 1]; e += EF) {
    const t = edges[e + eTo] / NF
    rfrom[fill[t]] = i
    redge[fill[t]++] = e
  }
const name = (i) => strings[nodes[i * NF + nName]]
const type = (i) => nodeTypes[nodes[i * NF + nType]]
const edgeLabel = (e) => {
  const t = edgeTypes[edges[e + eType]]
  const n = edges[e + eName]
  return t === "element" || t === "hidden" ? `[${n}]` : `${strings[n]}`
}
const isRoot = (i) =>
  i === 0 || (type(i) === "synthetic" && /GC roots|\(Strong roots|Global handles|Handle scope/.test(name(i)))

function pathToRoot(start) {
  const prev = new Int32Array(N).fill(-1),
    via = new Int32Array(N).fill(-1)
  const q = [start]
  prev[start] = start
  for (let h = 0; h < q.length; h++) {
    const n = q[h]
    if (isRoot(n) && n !== start) {
      const chain = []
      for (let c = n; c !== start; ) {
        const p = via[c]
        chain.push({ node: c, edge: p })
        c = prev[c]
      }
      return chain // root → … → start
    }
    for (let r = rstart[n]; r < rstart[n + 1]; r++) {
      const from = rfrom[r],
        e = redge[r]
      if (edgeTypes[edges[e + eType]] === "weak") continue
      if (prev[from] !== -1) continue
      prev[from] = n
      via[from] = e
      q.push(from)
    }
  }
  return null
}

const markers = {}
for (let i = 0; i < N; i++) {
  const n = name(i)
  if (type(i) === "object" && /^Leak(HomeRoot|ChatRoot|TooltipTrigger)$/.test(n)) (markers[n] ??= []).push(i)
}
console.log("\nmarkers alive after GC:", Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, v.length])))
const signatures = {}
for (const [kind, list] of Object.entries(markers)) {
  for (const m of list) {
    const chain = pathToRoot(m)
    if (!chain) continue
    const steps = chain.map(
      ({ node, edge }) => `${type(node) === "closure" ? "ƒ " : ""}${name(node).slice(0, 60)} —${edgeLabel(edge)}→`,
    )
    const attached = steps.some((s) => /HTMLDocument|Document \{|Window \/ http/.test(s) && !/Detached/.test(s))
    const sig = steps
      .filter((s) => !/^(HTML|Detached|Text|Comment|SVG)/.test(s))
      .slice(0, 12)
      .join("  ")
    const key = `${kind} | ${sig}`
    signatures[key] ??= { count: 0, attached, example: steps }
    signatures[key].count++
  }
}
const ranked = Object.entries(signatures).sort((a, b) => b[1].count - a[1].count)
for (const [key, v] of ranked.slice(0, 10)) {
  console.log(
    `\n=== ${v.count}× ${key.split(" | ")[0]}${v.attached ? "   (path through the document — probably the live page)" : ""}`,
  )
  for (const s of v.example) console.log("   " + s)
}
