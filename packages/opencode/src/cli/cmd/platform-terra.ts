import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, printKV, dim, bold, resolveUserId, IRIS_API, writeJson } from "./iris-api"

/**
 * iris terra — places, addresses and your own geo index (EPIC #193384, T4 #193389).
 *
 * Replaces `iris geo` (kept as an alias, with every old verb). The old command asked the
 * `searchPlaces` tool, which fell back to WEB SEARCH when its places provider was down:
 * `geo resolve "121 Pickle Rd, Austin, TX"` returned a Yelp page with no coordinates
 * (2026-11-13, red evidence on the epic). Terra asks real geocoders only and says not found
 * when they fail (ADR-04).
 *
 * Every answer says where it came from:
 *   cache    hit | miss | stale-refreshed | bypassed | off: <why>   — Atlas is the cache (ADR-03)
 *   source   the source slug, and source_ref — the URL that re-fetches the full record
 *   tried    each source asked and what it said
 *
 * Which sources, in what order: your terra-sources Atlas dataset (`iris terra sources`).
 */

type Flags = { fresh?: boolean; offline?: boolean; source?: string; json?: boolean }

async function terraGet(path: string, params: Record<string, string | number | boolean | undefined | null>) {
  const userId = await resolveUserId()
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue
    qs.set(k, v === true ? "1" : String(v))
  }
  if (userId) qs.set("user_id", String(userId))
  const res = await irisFetch(`/api/v1/terra/${path}?${qs.toString()}`, {}, IRIS_API)
  return readTerra(res, path)
}

async function readTerra(res: Response, what: string) {
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    // Say WHICH call failed and why: "failed" alone reads like "no such place".
    const msg = body?.message ?? body?.error ?? text.slice(0, 200)
    throw new Error(`terra ${what} → ${res.status}${msg ? `: ${msg}` : ""}`)
  }
  return body
}

function flagOptions(yargs: any) {
  return yargs
    .option("fresh", { describe: "skip the Atlas cache and ask the sources again", type: "boolean", default: false })
    .option("offline", { describe: "answer from the Atlas cache only — no outside calls", type: "boolean", default: false })
    .option("source", { describe: "ask only this source (see: iris terra sources)", type: "string" })
    .option("json", { describe: "JSON output", type: "boolean", default: false })
}

function ageText(s: number | undefined | null): string {
  if (s === undefined || s === null) return ""
  if (s < 90) return `${s}s old`
  if (s < 5400) return `${Math.round(s / 60)}m old`
  if (s < 172800) return `${Math.round(s / 3600)}h old`
  return `${Math.round(s / 86400)}d old`
}

function cacheLine(r: any): string {
  const state = String(r?.cache ?? "")
  return state === "hit" || state === "stale" ? `from Atlas (${ageText(r.age_seconds)})` : state ? `cache: ${state}` : ""
}

function printTried(tried: any[] | undefined) {
  if (!tried?.length) return
  for (const t of tried) {
    const tail = t.error ? dim(` — ${t.error}`) : t.ms ? dim(` (${t.ms} ms)`) : ""
    console.log(`  ${dim("·")} ${t.source.padEnd(18)} ${t.status}${tail}`)
  }
}

function printPlace(r: any) {
  printKV("Address", r.address)
  if (r.name) printKV("Name", r.name)
  printKV("Coordinates", `${Number(r.lat).toFixed(6)}, ${Number(r.lon).toFixed(6)}`)
  printKV("Source", `${r.source}${r.cache ? dim(`  ${cacheLine(r)}`) : ""}`)
  if (r.source_ref) printKV("Full record", dim(r.source_ref))
}

/** Shared "nothing found" output. Not found is an ANSWER: it lists what was asked. */
function notFound(args: Flags & Record<string, any>, r: any, what: string) {
  process.exitCode = 1
  if (args.json) return writeJson(r)
  prompts.log.warn(`${what}: ${r?.reason ?? "not found"}`)
  printTried(r?.tried)
  if (String(r?.cache ?? "").startsWith("off")) console.log(`  ${dim(r.cache)}`)
  prompts.outro("Not found")
}

/** Wraps intro / auth / spinner / errors so each verb is just its own logic. */
async function run(args: Flags & Record<string, any>, title: string, body: (spin: ReturnType<typeof prompts.spinner> | null) => Promise<void>) {
  if (!args.json) {
    UI.empty()
    prompts.intro(`◈  ${title}`)
  }
  const token = await requireAuth()
  if (!token) {
    if (!args.json) prompts.outro("Done")
    return
  }
  const spin = args.json ? null : prompts.spinner()
  try {
    await body(spin)
  } catch (err) {
    spin?.stop("Failed", 1)
    const msg = err instanceof Error ? err.message : String(err)
    if (args.json) await writeJson({ error: msg })
    else {
      prompts.log.error(msg)
      prompts.outro("Done")
    }
    process.exitCode = 1
  }
}

const common = (a: any) => ({ fresh: a.fresh, offline: a.offline, source: a.source })

const ResolveCommand = cmd({
  command: "resolve <address>",
  describe: "address → coordinates, from real geocoders (two, side by side) — never a web page",
  builder: (y) => flagOptions(y.positional("address", { type: "string", demandOption: true, describe: "e.g. '121 Pickle Rd, Austin, TX'" })),
  async handler(args) {
    await run(args, "Resolve", async (spin) => {
      spin?.start("Resolving…")
      const r = await terraGet("resolve", { q: String(args.address), ...common(args) })
      if (!r?.found) {
        spin?.stop("No match", 1)
        return notFound(args, r, `Could not place "${args.address}"`)
      }
      spin?.stop(r.confidence >= 0.9 ? "Resolved — sources agree" : r.confidence >= 0.6 ? "Resolved" : "Resolved — low confidence")
      if (args.json) return writeJson(r)
      printDivider()
      printPlace(r)
      if (r.confidence !== undefined && r.confidence !== null) printKV("Confidence", `${r.confidence}${r.note ? dim(`  ${r.note}`) : ""}`)
      for (const a of r.alternates ?? []) console.log(`  ${dim(`also: ${a.source} → ${a.address} (${a.distance_m} m away)`)}`)
      printDivider()
      printTried(r.tried)
      if (r.agreement && !r.agreement.agree) prompts.log.warn("The sources disagree on where this is. Check before relying on it.")
      prompts.outro("Done")
    })
  },
})

const ReverseCommand = cmd({
  command: "reverse <lat> <lon>",
  describe: "coordinates → the address there (an address is not a business identity)",
  builder: (y) =>
    flagOptions(
      y.positional("lat", { type: "number", demandOption: true }).positional("lon", { type: "number", demandOption: true }),
    ),
  async handler(args) {
    await run(args, "Reverse", async (spin) => {
      spin?.start("Looking up…")
      const r = await terraGet("reverse", { lat: Number(args.lat), lon: Number(args.lon), ...common(args) })
      if (!r?.found) {
        spin?.stop("No match", 1)
        return notFound(args, r, `Nothing known at ${args.lat}, ${args.lon}`)
      }
      spin?.stop("Found")
      if (args.json) return writeJson(r)
      printDivider()
      printPlace(r)
      if (r.distance_m !== undefined) printKV("Distance", `${r.distance_m} m from the point`)
      if (r.note) console.log(`  ${dim(r.note)}`)
      prompts.outro("Done")
    })
  },
})

async function searchAndPrint(args: any, query: string, near: string | undefined, title: string) {
  await run(args, title, async (spin) => {
    spin?.start("Searching…")
    const r = await terraGet("search", { q: query, near, limit: Number(args.limit) || 10, ...common(args) })
    const places: any[] = Array.isArray(r?.places) ? r.places : []
    spin?.stop(`${places.length} place(s)${r?.source ? ` from ${r.source}` : ""}`)
    if (args.json) {
      if (!places.length) process.exitCode = 1
      return writeJson(r)
    }
    printDivider()
    if (r?.center) console.log(`  ${dim(`near ${r.center.address} (${r.center.source})`)}`)
    if (!places.length) {
      process.exitCode = 1
      console.log(`  ${r?.reason ?? `Nothing found for "${query}"`}`)
    }
    for (const p of places) {
      const dist = p.distance_m !== undefined ? dim(`  ${p.distance_m >= 1000 ? (p.distance_m / 1000).toFixed(1) + " km" : p.distance_m + " m"}`) : ""
      console.log(`  ${bold(String(p.name ?? p.address ?? "(unnamed)"))}${p.rating ? dim(`  ${p.rating}★`) : ""}${dist}`)
      if (p.name && p.address) console.log(`      ${dim(p.address)}`)
    }
    printDivider()
    printTried(r?.tried)
    prompts.outro("Done")
  })
}

const SearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "find places by name or kind, optionally --near an address",
  builder: (y) =>
    flagOptions(
      y
        .positional("query", { type: "string", demandOption: true, describe: "e.g. 'coffee' or 'Cosmic Coffee'" })
        .option("near", { type: "string", describe: "search around this place (resolved through Terra)" })
        .option("location", { type: "string", describe: "alias of --near (old `geo search` flag)", hidden: true })
        .option("limit", { type: "number", default: 10 }),
    ),
  async handler(args) {
    const near = (args.near ?? args.location) as string | undefined
    await searchAndPrint(args, String(args.query), near, `Search — "${args.query}"`)
  },
})

const NearbyCommand = cmd({
  command: "nearby <address>",
  describe: "places of a kind near an address, nearest first (pediatrician, urgent care, coffee)",
  builder: (y) =>
    flagOptions(
      y
        .positional("address", { type: "string", demandOption: true })
        .option("type", { alias: "t", type: "string", demandOption: true, describe: "what to look for" })
        .option("limit", { type: "number", default: 10 }),
    ),
  async handler(args) {
    await searchAndPrint(args, String(args.type), String(args.address), `Nearby — ${args.type}`)
  },
})

const LookupCommand = cmd({
  command: "lookup <place>",
  describe: "resolve a place (or lat,lon) and add elevation, sky and imagery",
  builder: (y) => flagOptions(y.positional("place", { type: "string", demandOption: true })),
  async handler(args) {
    await run(args, "Lookup", async (spin) => {
      spin?.start("Looking up…")
      const r = await terraGet("lookup", { q: String(args.place), ...common(args) })
      if (!r?.found) {
        spin?.stop("No match", 1)
        return notFound(args, r, `Could not place "${args.place}"`)
      }
      spin?.stop("Done")
      if (args.json) return writeJson(r)
      printDivider()
      printPlace(r)
      if (r.elevation_m !== null && r.elevation_m !== undefined) printKV("Elevation", `${r.elevation_m} m`)
      if (r.cloud_cover_now_pct !== null && r.cloud_cover_now_pct !== undefined) printKV("Cloud cover now", `${r.cloud_cover_now_pct}%`)
      if (r.clear_window) printKV("Next clear sky", `${r.clear_window.from} → ${r.clear_window.to} UTC`)
      for (const [k, u] of Object.entries(r.imagery ?? {})) printKV(k === "aerial_highres" ? "Aerial" : "Satellite", dim(String(u)))
      prompts.outro("Done")
    })
  },
})

/** Straight-line distance between two RESOLVED points. Refuses rather than estimating. */
const DistanceCommand = cmd({
  command: "distance <from> <to>",
  describe: "straight-line distance between two addresses — refuses rather than estimating",
  builder: (y) =>
    flagOptions(y.positional("from", { type: "string", demandOption: true }).positional("to", { type: "string", demandOption: true })),
  async handler(args) {
    await run(args, "Distance", async (spin) => {
      spin?.start("Resolving both ends…")
      const [a, b] = await Promise.all([
        terraGet("resolve", { q: String(args.from), ...common(args) }),
        terraGet("resolve", { q: String(args.to), ...common(args) }),
      ])
      if (!a?.found || !b?.found) {
        spin?.stop("Cannot compute", 1)
        process.exitCode = 1
        const missing = [!a?.found ? `from ("${args.from}")` : null, !b?.found ? `to ("${args.to}")` : null].filter(Boolean).join(" and ")
        if (args.json) return writeJson({ from: args.from, to: args.to, computed: false, missing, tried: { from: a?.tried, to: b?.tried } })
        console.log(`  ${bold("No distance computed.")} ${dim(`Could not place ${missing}.`)}`)
        return prompts.outro("Unresolved")
      }
      const km = haversineKm(a.lat, a.lon, b.lat, b.lon)
      spin?.stop("Computed")
      const out = {
        from: args.from, to: args.to, computed: true, straight_line: true,
        kilometers: Number(km.toFixed(2)), miles: Number((km / 1.609344).toFixed(2)),
        origin: { address: a.address, lat: a.lat, lon: a.lon, source: a.source },
        destination: { address: b.address, lat: b.lat, lon: b.lon, source: b.source },
      }
      if (args.json) return writeJson(out)
      printDivider()
      printKV("From", a.address)
      printKV("To", b.address)
      printKV("Distance", `${out.miles} mi  ${dim(`(${out.kilometers} km, straight line — not a driving distance)`)}`)
      prompts.outro("Done")
    })
  },
})

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371.0088
  const r = (d: number) => (d * Math.PI) / 180
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const SourcesListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "which sources Terra asks, in what order — your terra-sources dataset over the defaults",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    await run(args, "Terra sources", async () => {
      const r = await terraGet("sources", {})
      if (args.json) return writeJson(r)
      printDivider()
      for (const s of r?.sources ?? []) {
        const on = !s.adapter ? dim("—  ") : s.enabled ? "on " : dim("off")
        const kinds = (s.kinds ?? []).join(",")
        const status = s.status ? ` ${s.status}` : ""
        const why = s.unavailable ? dim(`  (${s.unavailable})`) : ""
        console.log(`  ${on} ${String(s.priority).padStart(2)}  ${s.slug.padEnd(24)} ${dim(kinds.padEnd(16))}${status}${why}`)
      }
      printDivider()
      console.log(`  ${dim("Change order or turn one off: edit its row in your terra-sources dataset (iris atlas:datasets records …).")}`)
      prompts.outro("Done")
    })
  },
})

const SourcesCheckCommand = cmd({
  command: "check",
  describe: "probe every source now and record the result in your terra-sources dataset",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    await run(args, "Terra sources — check", async (spin) => {
      spin?.start("Probing…")
      const userId = await resolveUserId()
      const res = await irisFetch(`/api/v1/terra/sources/check${userId ? `?user_id=${userId}` : ""}`, { method: "POST", body: "{}" }, IRIS_API)
      const r = await readTerra(res, "sources/check")
      const rows: any[] = Array.isArray(r?.results) ? r.results : []
      const bad = rows.filter((x) => x.enabled && x.status !== "verified" && x.status !== "no-adapter")
      spin?.stop(bad.length ? `${bad.length} enabled source(s) not answering` : "All enabled sources answered")
      if (bad.length) process.exitCode = 1
      if (args.json) return writeJson(rows)
      printDivider()
      for (const x of rows) {
        if (x.status === "no-adapter") continue
        const ms = x.latency_ms ? dim(` ${x.latency_ms} ms`) : ""
        console.log(`  ${x.status === "verified" ? "✓" : "✗"} ${x.slug.padEnd(20)} ${x.status}${ms}${x.detail ? dim(`  ${x.detail}`) : ""}`)
      }
      prompts.outro("Done")
    })
  },
})

const SourcesCommand = cmd({
  command: "sources",
  describe: "the sources Terra asks — list (default) or check",
  builder: (y) => y.command(SourcesListCommand).command(SourcesCheckCommand).option("json", { type: "boolean", default: false }),
  // bare `iris terra sources` = list; yargs runs this only when no subcommand matched
  async handler(args) {
    await (SourcesListCommand as any).handler(args)
  },
})

export const PlatformTerraCommand = cmd({
  command: "terra <command>",
  aliases: ["geo", "places"],
  describe: "places, addresses and your own geo index — resolve, search, nearby, lookup, sources",
  builder: (yargs) =>
    yargs
      .command(ResolveCommand)
      .command(ReverseCommand)
      .command(SearchCommand)
      .command(NearbyCommand)
      .command(LookupCommand)
      .command(DistanceCommand)
      .command(SourcesCommand)
      .demandCommand(1),
  async handler() {},
})
