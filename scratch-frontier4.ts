import { PageSession } from "./packages/opencode/src/iris/browser-driver"
import { describeChange } from "./packages/opencode/src/iris/browser-verbs"
const p = new PageSession({ headless: true, timeoutMs: 45000 })
try {
  await p.open(process.argv[2])
  await new Promise((r) => setTimeout(r, 12000))
  const els = await p.elements(400)
  const fares = els.filter((e: any) => e.area && /Standard fare/.test(e.name))
  console.log("fares", fares.length, fares.slice(0, 4).map((e: any) => e.ref + " " + e.name.slice(0, 70)).join(" | "))
  const before = await p.state()
  const checked = `(() => { const r = [...document.querySelectorAll('input.js-fare')].filter(x => x.checked); return r.map(x => x.getAttribute('aria-label').slice(0,50)).join(' / ') || 'none' })()`
  console.log("checked before:", await (p as any).evaluate(checked))
  console.log("click:", await p.clickRef(fares[0].ref))
  await new Promise((r) => setTimeout(r, 3000))
  const after = await p.state()
  console.log("change:", describeChange(before, after).slice(0, 200))
  console.log("checked after:", await (p as any).evaluate(checked))
  console.log("text:", (await (p as any).evaluate(`document.body.innerText.match(/Total[^\\n]{0,40}|\\$\\d+\\.\\d\\d/g)?.slice(0,6).join(' ; ')`)))
} catch (e) { console.log("ERR", String(e)) } finally { await p.close() }
