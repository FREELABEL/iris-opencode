import { PageSession } from "./packages/opencode/src/iris/browser-driver"
const p = new PageSession({ headless: true, timeoutMs: 45000 })
try {
  await p.open(process.argv[2])
  await new Promise((r) => setTimeout(r, 12000))
  const out = await (p as any).evaluate(`(() => {
    const box = document.querySelector(".ibe-farebox-fare-basic"); const res = [];
    const m = (n, el) => { if (!el) return res.push(n+" none"); const r = el.getBoundingClientRect(), c = getComputedStyle(el); res.push(n+" "+Math.round(r.left)+","+Math.round(r.top)+" "+Math.round(r.width)+"x"+Math.round(r.height)+" display="+c.display+" vis="+c.visibility+" op="+c.opacity+" pos="+c.position+" inner="+JSON.stringify((el.innerText||"").slice(0,40))) }
    m("box", box); m("select", box.querySelector(".ibe-farebox-fare-select")); m("radiobtn", box.querySelector(".ibe-radio-btn")); m("label", box.querySelector("label")); m("input", box.querySelector("input")); res.push("inner H "+innerHeight+" W "+innerWidth);
    return res
  })()`)
  console.log((out as string[]).join("\n"))
} catch (e) { console.log("ERR", String(e)) } finally { await p.close() }
