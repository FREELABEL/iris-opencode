import { PageSession } from "./packages/opencode/src/iris/browser-driver"
const p = new PageSession({ headless: true, timeoutMs: 45000 })
try {
  await p.open(process.argv[2])
  await new Promise((r) => setTimeout(r, 12000))
  const out = await (p as any).evaluate(`(() => {
    const a = [...document.querySelectorAll("a,div,span")].filter(x => /12:22/.test(x.textContent + (x.getAttribute("aria-label")||""))).pop()
    if (!a) return ['no 12:22 link']
    let row = a; for (let i = 0; i < 8 && row; i++) { row = row.parentElement; if (/\\$\\d/.test(row.innerText) && row.innerText.length > 120) break }
    const res = ['ROW ' + row.tagName + '#' + row.id + '.' + String(row.className).slice(0,60) + ' text=' + row.innerText.replace(/\\s+/g,' ').slice(0,300)]
    for (const el of row.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      const t = (el.innerText || '').replace(/\\s+/g,' ').trim()
      const interesting = cs.cursor === 'pointer' || el.onclick || el.getAttribute('onclick') || el.tabIndex >= 0 || el.getAttribute('role') || /^(button|input|label|a)$/i.test(el.tagName)
      if (interesting && t && t.length < 80) res.push(el.tagName.toLowerCase() + (el.id?'#'+el.id:'') + '.' + String(el.className).slice(0,40) + ' role=' + el.getAttribute('role') + ' tab=' + el.tabIndex + ' ptr=' + (cs.cursor==='pointer') + ' onclick=' + !!(el.onclick||el.getAttribute('onclick')) + ' aria-hidden=' + el.closest('[aria-hidden=true]') + ' :: ' + t.slice(0,60))
    }
    return res.slice(0, 40)
  })()`)
  console.log((out as string[]).join("\n"))
} catch (e) { console.log("ERR", String(e)) } finally { await p.close() }
