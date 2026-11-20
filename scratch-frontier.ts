// Probe: what our elements() lists on Frontier's flight-select page, and what clickable fares exist.
import { PageSession } from "./packages/opencode/src/iris/browser-driver"
const url = process.argv[2]
const p = new PageSession({ headless: true, timeoutMs: 45000 })
try {
  console.log("open", JSON.stringify(await p.open(url)))
  await new Promise((r) => setTimeout(r, 12000))
  const st = await p.state()
  console.log("state", st.url, "|", st.title, "| text", st.textLength)
  console.log("head", st.head.slice(0, 300).replace(/\n/g, " "))
  const els = await p.elements(400)
  console.log("elements", els.length)
  for (const q of ["375", "Standard", "12:22", "Select", "$"]) {
    const hit = els.filter((e: any) => JSON.stringify(e).includes(q)).slice(0, 3)
    console.log("q", q, hit.length, JSON.stringify(hit).slice(0, 300))
  }
  // What does the page itself say is clickable around a fare price?
  const probe = await (p as any).evaluate(`(() => {
    const out = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walk.nextNode()) && out.length < 8) {
      if (/\\$\\s?\\d{2,4}/.test(n.textContent)) {
        let el = n.parentElement, chain = []
        for (let i = 0; el && i < 6; i++, el = el.parentElement) {
          const cs = getComputedStyle(el)
          chain.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') + (el.tabIndex >= 0 ? '[tab' + el.tabIndex + ']' : '') + (cs.cursor === 'pointer' ? '[ptr]' : '') + (el.onclick ? '[onclick]' : '') + '.' + String(el.className).slice(0, 30))
        }
        out.push(n.textContent.trim().slice(0, 30) + ' <- ' + chain.join(' < '))
      }
    }
    return out
  })()`)
  console.log("prices:\n" + (probe as string[]).join("\n"))
} catch (e) {
  console.log("ERR", String(e))
} finally {
  await p.close()
}
