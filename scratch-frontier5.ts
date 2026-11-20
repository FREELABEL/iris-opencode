import { PageSession } from "./packages/opencode/src/iris/browser-driver"
const p = new PageSession({ headless: true, timeoutMs: 45000 })
try {
  await p.open(process.argv[2])
  await new Promise((r) => setTimeout(r, 12000))
  const js = String.raw`(() => {
    const res = []
    for (const box of [...document.querySelectorAll('[name=ibe-farebox-fare]')].slice(0, 4)) {
      const ps = box.previousElementSibling, par = box.parentElement
      const t = (e) => (e && e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      res.push(box.className.slice(0, 32) + ' | prev=' + (ps ? ps.tagName + '.' + String(ps.className).slice(0, 30) + ' "' + t(ps) + '" w=' + Math.round(ps.getBoundingClientRect().width) : 'none') + ' | parent=' + String(par.className).slice(0, 30) + ' kids=' + par.children.length + ' "' + t(par).slice(0, 40) + '" | box "' + t(box) + '"')
    }
    return res
  })()`
  console.log(((await (p as any).evaluate(js)) as string[]).join("\n"))
} catch (e) { console.log("ERR", String(e)) } finally { await p.close() }
