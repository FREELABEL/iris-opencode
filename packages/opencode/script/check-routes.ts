#!/usr/bin/env bun
/**
 * Every endpoint the CLI calls must exist.
 *
 * WHY THIS EXISTS. `iris content delete` called DELETE /api/v1/tracks/{id} for months.
 * fl-api has never served that path — the real one is /api/v1/content/{type}/{id}. Six
 * commands were broken for all three content types and nobody reported it, because a 404
 * reads as "that content does not exist", not "this command is wrong". A census then found
 * 27 more dead endpoints across 22 command files (#181136), and 15 of them fail SILENTLY:
 * the 404 is swallowed by a try/catch or an `.ok` guard and the user is shown advice about
 * their own account. The clearest one told people "Could not detect your default board"
 * when the endpoint behind it simply did not exist.
 *
 * Runtime tests cannot catch that class — a swallowed 404 produces no error and often a
 * plausible-looking result. Only a static check sees it.
 *
 * HOW IT WORKS. Extracts every irisFetch() path from src/cli/cmd and matches it against a
 * committed snapshot of both services' real route tables (php artisan route:list --json).
 * Offline, deterministic, no auth, no network, no fixtures, and immune to the failure that
 * bit the first runtime attempt at this — grepping output for "404" matched item IDs inside
 * the response data. This never reads a payload.
 *
 * BASELINE, NOT A CLIFF. 21 known-dead endpoints predate this check. Failing on them would
 * make the hook permanently red and it would be disabled within a day. So the check fails
 * only on endpoints that are NEW, and it also reports baseline entries that now pass so the
 * list ratchets down instead of rotting.
 *
 * WHAT IT CANNOT SEE. A path that exists can still be wrong: wrong verb, wrong params, or a
 * fallback that returns 200 with nothing. `iris content list` matched a real route and still
 * failed on the METHOD. This is a floor, not a proof.
 */
import { readFileSync, readdirSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CMD_DIR = join(HERE, "..", "src", "cli", "cmd")
const SNAPSHOT = join(HERE, "routes.snapshot.json")
const BASELINE = join(HERE, "routes.baseline.json")

interface Route { method: string; uri: string; service: string }
interface Site { method: string; path: string; file: string }

const snapshot: { routes: Route[] } = JSON.parse(readFileSync(SNAPSHOT, "utf8"))
const known = new Set(snapshot.routes.map((r) => `${r.method} ${r.uri}`))

const baseline: { allowed: { method: string; path: string; why: string }[] } = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : { allowed: [] }
const allowed = new Set(baseline.allowed.map((a) => `${a.method} ${a.path}`))

/** Grab the whole irisFetch(...) argument region so `method:` survives into the match. */
const CALL = /irisFetch\(\s*([`"'])(.*?)\1(.*?)(?=\n\s*(?:const|let|if|return|await|\}|\/\/)|\)\s*\n)/gs

function normalise(raw: string): string | null {
  // Two traps, both of which inflated the original census by 40% before they were found:
  //   1. an unterminated capture leaves a bare `${qs` on the end
  //   2. `?${params}` interpolates WHOLE, so split("?") never fires and a trailing {}
  //      survives that no route has
  let p = raw.replace(/\$\{[^}]*$/, "")
  p = p.replace(/\$\{[^}]*\}/g, "{}").split("?")[0].replace(/\/$/, "")
  return p.startsWith("/") ? p || "/" : null
}

const sites: Site[] = []
for (const file of readdirSync(CMD_DIR).sort()) {
  if (!file.endsWith(".ts")) continue
  const src = readFileSync(join(CMD_DIR, file), "utf8")
  for (const m of src.matchAll(CALL)) {
    const path = normalise(m[2])
    if (!path) continue
    const method = (/method:\s*"(\w+)"/.exec(m[3])?.[1] ?? "GET").toUpperCase()
    sites.push({ method, path, file })
  }
}

function exists(method: string, path: string): boolean {
  const variants = [path]
  // trap 2 again, in its second form: `?${qs}` leaves a trailing {} that is NOT preceded by
  // a slash — /api/v1/partials{} rather than /api/v1/partials/{}. Missing this reported 17
  // live endpoints as dead on the first run of this very check.
  if (/[A-Za-z]\{\}$/.test(path)) variants.push(path.slice(0, -2))
  if (path.endsWith("/{}")) variants.push(path.slice(0, -3))
  for (const v of variants) if (known.has(`${method} ${v}`)) return true
  // a literal in the CLI may sit where the route declares a parameter, and vice versa
  for (const r of snapshot.routes) {
    if (r.method !== method) continue
    for (const v of variants) {
      const rx = new RegExp("^" + r.uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\}/g, "[^/]+") + "$")
      if (rx.test(v)) return true
      const rx2 = new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\}/g, "[^/]+") + "$")
      if (rx2.test(r.uri)) return true
    }
  }
  return false
}

const seen = new Map<string, Set<string>>()
for (const s of sites) {
  if (exists(s.method, s.path)) continue
  const key = `${s.method} ${s.path}`
  if (!seen.has(key)) seen.set(key, new Set())
  seen.get(key)!.add(s.file)
}

const fresh = [...seen.entries()].filter(([k]) => !allowed.has(k))
const healed = baseline.allowed.filter((a) => !seen.has(`${a.method} ${a.path}`))

console.log(`checked ${sites.length} call sites against ${snapshot.routes.length} routes`)
console.log(`  dead: ${seen.size}   baselined: ${allowed.size}   new: ${fresh.length}`)

if (healed.length) {
  console.log(`\n  ${healed.length} baselined endpoint(s) now resolve — remove them from routes.baseline.json:`)
  for (const h of healed) console.log(`    ${h.method} ${h.path}`)
}

if (fresh.length) {
  console.error(`\n  NEW dead endpoint(s) — the CLI calls a route that does not exist:\n`)
  for (const [key, files] of fresh) {
    console.error(`    ${key}`)
    console.error(`      ${[...files].sort().join(", ")}`)
  }
  console.error(`
  Fix the path, or if the 404 is deliberate (a probe), add it to
  script/routes.baseline.json with a reason.

  If the route is NEW and this snapshot is stale, refresh it:
    bun run script/refresh-routes.sh
`)
  process.exit(1)
}

if (allowed.size) {
  console.log(`\n  ok — no NEW dead endpoints. ${allowed.size} still baselined in routes.baseline.json; that list should shrink.`)
} else {
  console.log("\n  ok — every endpoint the CLI calls exists")
}
