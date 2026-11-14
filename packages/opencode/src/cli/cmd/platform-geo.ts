import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, printKV, dim, bold, resolveUserId, IRIS_API, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

/**
 * Place lookup as a first-class verb (#180699).
 *
 * The capability was already live and already paid for — `venues enrich` calls
 * POST /api/v1/tools/execute { tool: "searchPlaces" } to fill in a venue's rating, phone,
 * address and photos. But it was reachable ONLY through that one command, on a venue that
 * already exists, one row at a time. Wanting to resolve an address, or check whether a place
 * exists before creating anything, meant either creating a throwaway venue or not doing it.
 *
 * That is a distribution failure rather than a missing feature: nothing here is new work, it is
 * the same tool call with a name a person would look for.
 *
 * SCOPE: search and resolve. The original proposal also listed distance, nearby and attach.
 * Those are left out deliberately rather than stubbed — distance and nearby need a geocoding
 * round-trip this tool does not return today (no lat/lng in the payload), and `attach` belongs
 * to whichever entity is being attached to, not to a generic geo namespace. Shipping two verbs
 * that work beats five where three return "not implemented".
 */

/**
 * One place, normalized across the shapes the tool returns (Serper and Hive differ).
 *
 * `latitude`/`longitude`/`source` are carried through because they are the difference between
 * a place record and a web page — see the degradation note on searchPlaces below. Without
 * them `distance` cannot be computed and a fallback result cannot be told apart from a real one.
 */
function normalizePlace(p: any) {
  return {
    name: p.title ?? p.name ?? null,
    address: p.address ?? null,
    phone: p.phone ?? null,
    website: p.website ?? p.website_url ?? null,
    rating: p.rating ?? null,
    rating_count: p.ratingCount ?? p.rating_count ?? null,
    place_id: p.cid ?? p.place_id ?? null,
    maps_url: p.mapsUrl ?? p.maps_url ?? null,
    latitude: typeof p.latitude === "number" ? p.latitude : null,
    longitude: typeof p.longitude === "number" ? p.longitude : null,
    source: p.source ?? null,
  }
}

type NormalizedPlace = ReturnType<typeof normalizePlace>

function hasCoords(p: NormalizedPlace): boolean {
  return typeof p.latitude === "number" && typeof p.longitude === "number"
}

const DEGRADED_NOTE =
  "the structured places provider (Serper) is unavailable, so these are web search results — no verified address, phone, rating or coordinates"

/**
 * THE PROVIDER IS OFTEN DEGRADED, AND THE API HIDES IT.
 *
 * iris-api's searchPlaces tries Serper /places (structured: address, phone, rating, lat/lng) and
 * falls back to a Tavily WEB search when Serper is dead or out of credits. That fallback is
 * honest where it is written — it sets source=tavily_web, degraded=true and an explanatory note.
 * /api/v1/tools/execute then forwards only {success, results}, dropping degraded, note, source
 * and total. So the caller sees objects of type "place" and a success flag either way.
 *
 * Measured on production 2026-08-17: 9/9 results source=tavily_web, 0 with an address, none with
 * coordinates. That is the same finding as #180716's "objects labelled place with a null address
 * are not places", and it is why `structured` is DERIVED here rather than read: nothing upstream
 * of this function will tell us.
 *
 * Both conditions matter. A future provider that stops setting `source` is still caught by the
 * missing coordinates; a provider mixing real records and web pages is not something to average.
 */
async function searchPlaces(query: string, location: string | undefined, limit: number) {
  const userId = await resolveUserId()
  const res = await irisFetch(
    "/api/v1/tools/execute",
    {
      method: "POST",
      body: JSON.stringify({
        tool: "searchPlaces",
        params: { query, ...(location ? { location } : {}) },
        user_id: userId || 193,
      }),
    },
    IRIS_API,
  )

  if (!res.ok) {
    // Say WHICH call failed and with what. A bare "search failed" here is indistinguishable
    // from "no such place", which is the failure this whole ticket family is about.
    throw new Error(`searchPlaces returned ${res.status} ${res.statusText}`)
  }

  const raw = (await res.json()) as any
  const result = raw?.result ?? raw?.data ?? raw
  const rows: any[] = firstArray(result?.results, result?.places)
  const places = rows.slice(0, limit).map(normalizePlace)

  const webDerived = places.some((p) => String(p.source ?? "").includes("tavily"))
  const structured = places.length > 0 && !webDerived && places.some(hasCoords)
  const provider =
    (typeof result?.source === "string" && result.source) ||
    places.find((p) => p.source)?.source ||
    (structured ? "places" : "unknown")

  return { places, structured, provider: String(provider) }
}

/** Shared banner so a degraded answer never reads like a clean one. */
function reportProvider(structured: boolean, provider: string) {
  if (structured) {
    console.log(`  ${dim(`provider: ${provider}`)}`)
    return
  }
  console.log(`  ${bold("⚠ DEGRADED")} ${dim(`— ${DEGRADED_NOTE}`)}`)
  console.log(`  ${dim(`provider: ${provider}`)}`)
}

/** Straight-line distance. Only ever called with two real coordinate pairs. */
function haversineMiles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.7613 // mean Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const SearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "look up places by name or description (Google Maps data)",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "what to look for, e.g. 'day care in Hutto TX'", type: "string", demandOption: true })
      .option("location", { describe: "bias results to a place, e.g. 'Austin, TX'", type: "string" })
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Places — "${args.query}"`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Looking up…")

    try {
      const { places, structured, provider } = await searchPlaces(String(args.query), args.location as string | undefined, Number(args.limit) || 10)
      spinner?.stop(`${places.length} place(s)`)

      // structured/provider ride along in --json BECAUSE the upstream envelope drops them; a
      // machine caller must be able to tell a place record from a web page.
      if (args.json) { await writeJson({ query: args.query, source: "searchPlaces", provider, structured, note: structured ? undefined : DEGRADED_NOTE, places }); return }

      if (!places.length) {
        prompts.log.warn(`Nothing found for "${args.query}"`)
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const p of places) {
        console.log(`  ${bold(String(p.name ?? "(unnamed)"))}${p.rating ? dim(`  ${p.rating}★`) : ""}`)
        if (p.address) console.log(`      ${dim(p.address)}`)
        if (p.phone) console.log(`      ${dim(p.phone)}`)
      }
      printDivider()
      // These are open-web results, said out loud — the mistake #180716 was filed for.
      console.log(`  ${dim("Source: open web. These are not your saved venues.")}`)
      console.log(`  ${dim("Your venues:")} iris venues search "${args.query}"`)
      // ...and WHICH open-web source, because "Google Maps data" is only true when Serper
      // answered. When it has not, these are Tavily web pages with every place-shaped field null.
      reportProvider(structured, provider)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
    }
  },
})

const ResolveCommand = cmd({
  command: "resolve <address>",
  describe: "resolve a partial or messy address to its full form",
  builder: (yargs) =>
    yargs
      .positional("address", { describe: "address to resolve, e.g. '211 Swenson Dr Hutto'", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Resolve address") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Resolving…")

    try {
      const { places, structured, provider } = await searchPlaces(String(args.address), undefined, 1)
      const match = places[0]

      if (!match) {
        spinner?.stop("No match", 1)
        if (args.json) { await writeJson({ input: args.address, resolved: null }); return }
        // An unresolvable address is a real answer, not an error — #180698 exists because an
        // address with no city was accepted silently. Say so plainly.
        prompts.log.warn(`Could not resolve "${args.address}" — it may be incomplete or not a real place.`)
        prompts.outro("Done")
        return
      }

      // CONFIDENCE, because this is a web lookup and not a geocoder.
      //
      // Measured while building this: `geo resolve "211 Swenson Drive Hutto"` came back with
      // "211 Estate Dr, Hutto, TX 78634" — a Zillow listing on a DIFFERENT STREET — and the
      // command reported it as resolved. A wrong address returned confidently is worse than no
      // answer, because the caller has no reason to check it.
      //
      // So compare the distinctive words of the input against the match. Numbers and short
      // filler words are dropped: "211" and "dr" match almost anything.
      const distinctive = (s: string) =>
        new Set(
          s.toLowerCase().split(/[^a-z]+/i).filter((w) => w.length > 3 && !["drive", "road", "street", "lane", "court", "avenue"].includes(w)),
        )
      const want = distinctive(String(args.address))
      const got = distinctive(`${match.name ?? ""} ${match.address ?? ""}`)
      const missing = [...want].filter((w) => !got.has(w))
      const confident = missing.length === 0

      spinner?.stop(confident ? String(match.name ?? "resolved") : "low confidence")

      if (args.json) {
        await writeJson({ input: args.address, resolved: match, confident, missing_terms: missing, provider, structured, note: structured ? undefined : DEGRADED_NOTE })
        return
      }

      printDivider()
      reportProvider(structured, provider)
      printDivider()
      printKV("Input", args.address)
      printKV("Name", match.name)
      printKV("Address", match.address)
      printKV("Phone", match.phone)
      printKV("Website", match.website)
      printKV("Place ID", match.place_id)
      printDivider()

      if (!confident) {
        prompts.log.warn(
          `Low confidence — the match is missing: ${missing.join(", ")}. ` +
            `This is an open-web lookup, not a geocoder; it returns the closest thing it found, ` +
            `which may be a different address entirely. Verify before saving it anywhere.`,
        )
      }
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
    }
  },
})

/**
 * distance and nearby — the two verbs the first cut of this file left out.
 *
 * The reasoning for leaving them out was right about the facts and, I think, wrong about the
 * conclusion. The facts: the tool returns no coordinates today, so neither verb can do its job,
 * and a stub that answers "not implemented" is worse than an absent command.
 *
 * But there is a third option between stubbing and omitting, and it is the one the reporter
 * actually needs. #180699 came from measuring an Austin→Hutto distance BY HAND. Omitting the
 * verb does not remove that need; it just sends the person back to Google, which is the exact
 * complaint the ticket was filed about. These verbs do the real computation whenever the
 * provider supplies coordinates — which is what Serper /places returns when it is up — and
 * REFUSE, loudly and with the reason, when it does not.
 *
 * Refusal is the feature. A wrong distance is worse than no distance because it is actionable
 * and silently false: nobody re-checks a number that looks plausible. So there is no fallback
 * estimate here, no "approximately", no straight-line-from-city-centroid guess.
 */
const DistanceCommand = cmd({
  command: "distance <from> <to>",
  describe: "straight-line miles between two addresses — refuses rather than estimating",
  builder: (yargs) =>
    yargs
      .positional("from", { describe: "origin address", type: "string", demandOption: true })
      .positional("to", { describe: "destination address", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const from = String(args.from)
    const to = String(args.to)

    if (!args.json) { UI.empty(); prompts.intro("◈  Distance") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Resolving both ends…")

    try {
      const [a, b] = await Promise.all([searchPlaces(from, undefined, 5), searchPlaces(to, undefined, 5)])
      const pa = a.places.find(hasCoords) ?? null
      const pb = b.places.find(hasCoords) ?? null

      if (!pa || !pb) {
        spinner?.stop("Cannot compute", 1)
        const missing = [!pa ? `from ("${from}")` : null, !pb ? `to ("${to}")` : null].filter(Boolean).join(" and ")

        if (args.json) {
          await writeJson({ from, to, computed: false, reason: "no coordinates", missing, provider: a.provider, structured: a.structured && b.structured, note: DEGRADED_NOTE })
          return
        }

        printDivider()
        reportProvider(a.structured && b.structured, a.provider)
        printDivider()
        console.log(`  ${bold("No distance computed.")} ${dim(`No coordinates for ${missing}.`)}`)
        console.log(`  ${dim("This is not an estimate that was rounded off — there is no coordinate to measure from.")}`)
        prompts.outro("Unresolved")
        return
      }

      const miles = haversineMiles(pa.latitude!, pa.longitude!, pb.latitude!, pb.longitude!)
      spinner?.stop("Computed")

      if (args.json) {
        await writeJson({
          from, to, computed: true,
          miles: Number(miles.toFixed(2)),
          kilometers: Number((miles * 1.609344).toFixed(2)),
          straight_line: true,
          origin: { address: pa.address, latitude: pa.latitude, longitude: pa.longitude },
          destination: { address: pb.address, latitude: pb.latitude, longitude: pb.longitude },
          provider: a.provider,
        })
        return
      }

      printDivider()
      printKV("From", String(pa.address ?? from))
      printKV("To", String(pb.address ?? to))
      printKV("Distance", `${miles.toFixed(1)} mi  ${dim(`(${(miles * 1.609344).toFixed(1)} km, straight line)`)}`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
    }
  },
})

const NearbyCommand = cmd({
  command: "nearby <address>",
  describe: "find places of a kind near an address (pediatrician, urgent care, daycare)",
  builder: (yargs) =>
    yargs
      .positional("address", { describe: "the address to search around", type: "string", demandOption: true })
      .option("type", { alias: "t", describe: "what to look for", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const address = String(args.address)
    const kind = String(args.type)

    if (!args.json) { UI.empty(); prompts.intro(`◈  Nearby — ${kind}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start(`Searching for ${kind}…`)

    try {
      const { places, structured, provider } = await searchPlaces(kind, address, Number(args.limit) || 10)
      spinner?.stop(`${places.length} result(s)`)

      if (args.json) {
        await writeJson({ address, type: kind, provider, structured, note: structured ? undefined : DEGRADED_NOTE, places })
        return
      }

      printDivider()
      reportProvider(structured, provider)
      printDivider()
      if (!places.length) console.log(`  ${dim(`Nothing found for "${kind}" near ${address}`)}`)
      for (const p of places) {
        console.log(`  ${bold(String(p.name ?? "(unnamed)"))}${p.rating ? dim(`  ${p.rating}★`) : ""}`)
        if (p.address) console.log(`      ${dim(p.address)}`)
        if (p.phone) console.log(`      ${dim(p.phone)}`)
      }

      // "Nearby" is a proximity claim. Without coordinates this is a text search that happened
      // to mention the address, so say which one the user is looking at rather than letting the
      // verb's name make the claim for it.
      if (!structured) {
        printDivider()
        console.log(`  ${dim("Not ranked by distance — no coordinates were returned to rank by.")}`)
      }
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
    }
  },
})

export const PlatformGeoCommand = cmd({
  command: "geo <command>",
  aliases: ["places"],
  describe: "look up and resolve real-world places and addresses",
  builder: (yargs) =>
    yargs.command(SearchCommand).command(ResolveCommand).command(DistanceCommand).command(NearbyCommand).demandCommand(1),
  async handler() {},
})
