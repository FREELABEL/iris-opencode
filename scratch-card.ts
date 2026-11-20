import { PageSession } from "./packages/opencode/src/iris/browser-driver"
import { writeFileSync } from "fs"
const [url, steps] = [process.argv[2], process.argv[3] ?? ""]
const p = new PageSession({ headless: true, timeoutMs: 60000 })
const ev = (js: string) => (p as any).evaluate(js)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
try {
  await p.open(url)
  await wait(10000)
  let n = 0
  for (const step of steps.split(";;").filter(Boolean)) {
    console.log("STEP", step.slice(0, 80), "=>", String(await ev(step)).slice(0, 400))
    await wait(3500)
    writeFileSync(`/tmp/card-${++n}.png`, await p.screenshot())
  }
  writeFileSync("/tmp/card-0.png", await p.screenshot())
  console.log(String(await ev(`document.body.innerText.slice(0,1500)`)))
} catch (e) { console.log("ERR", String(e)) } finally { await p.close() }
