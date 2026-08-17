import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, printKV, dim, bold, resolveUserId, IRIS_API, writeJson } from "./iris-api"

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

/** One place, normalized across the shapes the tool returns (Serper and Hive differ). */
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
  }
}

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
  const places: any[] = result?.results ?? result?.places ?? []
  return places.slice(0, limit).map(normalizePlace)
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
      const places = await searchPlaces(String(args.query), args.location as string | undefined, Number(args.limit) || 10)
      spinner?.stop(`${places.length} place(s)`)

      if (args.json) { await writeJson({ query: args.query, source: "searchPlaces", places }); return }

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
      console.log(`  ${dim("Source: open web (Google Maps). These are not your saved venues.")}`)
      console.log(`  ${dim("Your venues:")} iris venues search "${args.query}"`)
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
      const places = await searchPlaces(String(args.address), undefined, 1)
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
        await writeJson({ input: args.address, resolved: match, confident, missing_terms: missing })
        return
      }

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

export const PlatformGeoCommand = cmd({
  command: "geo <command>",
  aliases: ["places"],
  describe: "look up and resolve real-world places and addresses",
  builder: (yargs) => yargs.command(SearchCommand).command(ResolveCommand).demandCommand(1),
  async handler() {},
})
