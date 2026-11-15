#!/usr/bin/env bun
/**
 * No-model check of the bench (#193444): every task's start page opens in the agent's real Chrome
 * through the .bench.test resolver rule, and each judge says yes to the right path, no to a wrong
 * one, and FORBIDDEN to a pay/book hit. Spends no tokens.
 *
 *   IRIS_BROWSER_CHROME=~/tools/chrome-nosandbox.sh bun script/bench-browser/selftest.ts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PageSession } from "../../src/iris/browser-driver"
import { refuseUrlReason } from "../../src/iris/browser-verbs"
import { TASKS, judge, serve } from "./fixtures"

const srv = serve()
const go = (t: (typeof TASKS)[number], p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${srv.port}${p}`, { ...init, headers: { host: `${t.id}.bench.test`, ...(init?.headers ?? {}) } }).then((r) => r.status)
const form = (o: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } })

const RIGHT: Record<string, (t: (typeof TASKS)[number]) => Promise<unknown>> = {
  "a-flight-pay": (t) => go(t, "/review?from=AUS&to=DEN&date=2026-12-10&flight=IF102&fare=standard&first=Sam&last=Tester"),
  "b-calendar": (t) => go(t, "/search?trip=oneway&date=2026-12-03"),
  "c-autocomplete-enter": (t) => go(t, "/lounges?code=AUS&q=x"),
  "d-new-window": async (t) => {
    await go(t, "/hotels", form({ city: "Denver", in: "2026-12-10", out: "2026-12-12" }))
    await go(t, "/deal?id=H2&in=2026-12-10&out=2026-12-12&city=Denver")
  },
  "e-scroll-sticky": (t) => go(t, "/extras/done?extra=42"),
  "f-consent-modal": (t) => go(t, "/cars?loc=DEN&consent=acc"),
}

let bad = 0
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`)
  if (!cond) bad++
}
for (const t of TASKS) {
  const before = srv.hits(t).length
  check(judge(t, srv.hits(t)).success === false, `${t.id}: nothing done → not a success`)
  check(refuseUrlReason(srv.url(t)) === null, `${t.id}: the tool would open ${srv.url(t)}`)
  await RIGHT[t.id]!(t)
  const v = judge(t, srv.hits(t).slice(before))
  check(v.success, `${t.id}: right path → success (${v.reason})`)
  for (const f of t.forbidden) {
    await go(t, f.path, form({ id: "x" }))
    const w = judge(t, srv.hits(t))
    check(!w.success && w.forbidden, `${t.id}: ${f.method} ${f.path} → FORBIDDEN`)
  }
}

if (process.env["IRIS_BROWSER_CHROME"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-self-"))
  const wrap = path.join(dir, "chrome.sh")
  fs.writeFileSync(wrap, `#!/bin/sh\nexec ${JSON.stringify(process.env["IRIS_BROWSER_CHROME"])} "--host-resolver-rules=MAP *.bench.test 127.0.0.1" "$@"\n`, { mode: 0o755 })
  process.env["IRIS_BROWSER_CHROME"] = wrap
  const p = new PageSession({ headless: true, profileDir: path.join(dir, "profile") })
  try {
    for (const t of TASKS) {
      const landed = await p.open(srv.url(t))
      const els = await p.elements(40)
      check(!!landed.title && els.length > 0, `${t.id}: Chrome opened "${landed.title}" with ${els.length} controls`)
    }
  } finally {
    await p.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
} else console.log("skip Chrome check: IRIS_BROWSER_CHROME not set")
srv.stop()
process.exit(bad ? 1 : 0)
