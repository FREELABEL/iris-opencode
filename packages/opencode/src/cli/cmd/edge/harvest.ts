/**
 * Close the last gap in an export by asking the BROWSER what the page still loads from us.
 *
 * WHY THIS REPLACED A REGEX. The exporter used to pattern-match asset URLs out of the HTML. That
 * works until a page references a host you did not think of. Two pages used cdn.heyiris.io; the
 * third pulled its logo from freelabel.net/img/brands/... and the regex never saw it. Guessing URL
 * shapes is a losing game — every new page is a new shape.
 *
 * Runs on a throwaway headless Chrome over CDP — no browser dependency, so this ports into the CLI
 * unchanged.
 *
 * So don't guess. Load the exported page, record every request that still goes to our origins,
 * fetch exactly those, rewrite exactly those, and repeat until the number is zero. The browser
 * already knows the answer; this just writes it down.
 *
 * Ported from scripts/genesis-edge/harvest.mjs (default passes 3; origin was --origin, default
 * https://freelabel.net).
 */
import fs from "fs"
import path from "path"
import { launch, inspect } from "./cdp"
import { startStaticServer } from "./serve"
import { isAppDataPath } from "./export-data"
import { isOurs } from "./hosts"


// A local path that mirrors the remote one, so two files named logo.png cannot collide.
const localFor = (url: string, origin: string): string => {
  const u = new URL(url)
  // An asset pulled from the page's OWN origin keeps its path, so the runtime request that asked
  // for /js/iris-sdk-1.0.3.js finds it at /js/iris-sdk-1.0.3.js. Only foreign hosts get namespaced.
  if (origin && u.origin === new URL(origin).origin) return u.pathname
  const host = u.hostname.replace(/[^\w.-]/g, "")
  return "/_ext/" + host + u.pathname.replace(/\/{2,}/g, "/")
}

export async function harvest(
  dir: string,
  opts: { origin: string; passes?: number },
): Promise<{ pulled: number; log: string[] }> {
  const root = path.resolve(dir || ".")
  const passes = Number(opts.passes ?? 3)
  const origin = opts.origin
  const pageFile = path.join(root, "index.html")
  const log: string[] = []

  let total = 0
  for (let pass = 1; pass <= passes; pass++) {
    const srv = await startStaticServer(root)

    const found = new Set<string>()
    const missingLocal = new Set<string>()

    let session: Awaited<ReturnType<typeof launch>> | undefined
    try {
      session = await launch()
      const seen = await inspect(session, `${srv.url}/`, { evaluate: "return 1;" })
      for (const url of seen.requests) {
        // Data paths are deliberately excluded: mirroring a collection here would bypass ADR-02
        // (per-viewer scoping) and ADR-03 (PHI). export-data.mjs owns those, refusals and all.
        if (isOurs(url) && !isAppDataPath(url)) found.add(url)
      }
      for (const f of seen.failures) {
        // A same-origin 404 is an asset the page asks for at RUNTIME that no static scrape can see —
        // /js/iris-sdk-*.js is injected by the renderer itself. Pull those from the origin too.
        const m = f.match(/^404 (http:\/\/localhost:\d+(\/\S*))/)
        // /favicon.ico is Chrome's own implicit request, not something the page asks for. Chasing it
        // 404s at the origin too, so `found` is never empty, so the loop never breaks early and every
        // export burns all three passes re-proving the same nothing.
        if (m && !isAppDataPath(m[2]) && !/^\/favicon\.ico$/.test(m[2])) missingLocal.add(m[2])
      }
    } finally {
      if (session) await session.close()
      await srv.stop()
    }

    for (const p of missingLocal) found.add(origin + p)

    if (found.size === 0) {
      log.push(`  harvest pass ${pass}: nothing missing, nothing calling home`)
      break
    }

    let html = fs.readFileSync(pageFile, "utf8")
    let saved = 0
    for (const url of found) {
      const rel = localFor(url, origin)
      const dest = path.join(root, rel)
      try {
        const res = await fetch(url)
        if (!res.ok) {
          log.push(`  ! ${res.status} ${url.slice(0, 80)}`)
          continue
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
        saved++
      } catch (e: any) {
        log.push(`  ! fetch failed ${url.slice(0, 70)}: ${e?.message}`)
        continue
      }
      // Rewrite both encodings: plain in markup, and JSON-escaped inside the inline page payload.
      html = html.split(url).join(rel)
      html = html.split(url.replace(/\//g, "\\/")).join(rel.replace(/\//g, "\\/"))
    }
    fs.writeFileSync(pageFile, html)
    total += saved
    log.push(`  harvest pass ${pass}: mirrored ${saved}/${found.size} remote asset(s)`)
  }

  log.push(`  ${total} asset(s) pulled in by harvest`)
  return { pulled: total, log }
}
