/**
 * Discover which data collections a page ACTUALLY requests, by loading it and watching.
 *
 * A static scrape finds only endpoints the page payload names. Components that default their
 * endpoint in code (CaseListTable.vue:18 is one) are invisible to it — two real dashboards scraped
 * as "no bound collections". The browser knows. Runs over CDP, so it needs nothing installed.
 *
 * Returns slug/collection strings (ported from scripts/genesis-edge/discover-collections.mjs,
 * which printed one per line).
 */
import path from "path"
import { launch, inspect } from "./cdp"
import { startStaticServer } from "./serve"

export async function discoverCollections(dir: string): Promise<string[]> {
  const root = path.resolve(dir || ".")
  const srv = await startStaticServer(root)

  const seen = new Set<string>()
  let session: Awaited<ReturnType<typeof launch>> | undefined
  try {
    session = await launch()
    const res = await inspect(session, `${srv.url}/`, { evaluate: "return 1;" })
    for (const url of res.requests) {
      const m = url.match(/\/api\/v1\/app-data\/([\w-]+)\/([\w-]+)/)
      if (m) seen.add(`${m[1]}/${m[2]}`)
    }
    // A collection the page asked for that is missing locally shows up as a 404 too.
    for (const f of res.failures) {
      const m = f.match(/\/api\/v1\/app-data\/([\w-]+)\/([\w-]+)/)
      if (m) seen.add(`${m[1]}/${m[2]}`)
    }
  } finally {
    if (session) await session.close()
    await srv.stop()
  }

  return [...seen]
}
