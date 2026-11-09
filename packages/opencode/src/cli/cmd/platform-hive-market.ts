import { cmd } from "./cmd"
import * as prompts from "./clack"
import { requireAuth, requireUserId, writeJson, dim, bold, success, warn, highlight, isJsonMode, emitJsonError } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { fleet, readSettings, checkedAgo } from "./platform-hive-models"
import { asArray } from "../../util/array"

/**
 * `iris hive market` — the Hive marketplace (#192752).
 *
 * A member lists a serving machine at a price per hour; any IRIS member can then run its models
 * as `iris/hive/@<owner user id>/<model>`. Machine time is billed per minute, held until IRIS's
 * checks of that machine pass, then paid to the owner minus IRIS's fee — or refunded if the
 * machine fails a check. Amounts on the wire are IRIS credits: 1 credit = $0.01.
 */

export const MAX_PRICE_CREDITS = 100_000

export interface Listing {
  id: string
  owner_user_id: number
  owner_name: string
  node_id: string
  node_name: string
  title: string | null
  description: string | null
  models: string[]
  price_credits_per_hour: number
  status: "online" | "offline" | string
  hardware: { cores: number | null; ram_gb: number | null; gpu: string | null }
  checks: { last_pass_at: string | null; last_fail_at: string | null; passed: number; failed: number }
  jobs_done: number
  active?: boolean
}

/**
 * Pure: a price someone typed, in dollars ("0.45", "$0.45") or cents ("45c"), as whole credits.
 * Rounds to the nearest credit. Refuses negatives, zero, nonsense and anything over $1,000.
 */
export function parsePrice(input: string | number | undefined | null): { credits: number } | { error: string } {
  const raw = String(input ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/\/(hr|hour|h)$/, "")
  if (!raw) return { error: "give a price, e.g. 0.45 (dollars per hour)" }
  let credits: number
  const cents = raw.match(/^(-?\d+(?:\.\d+)?)(?:c|¢|cents?)$/)
  if (cents) credits = Number(cents[1])
  else if (/^-?\$?-?\d*\.?\d+$/.test(raw)) credits = Number(raw.replace("$", "")) * 100
  else return { error: `"${input}" is not a price — use dollars per hour, e.g. 0.45 or $0.45, or cents, e.g. 45c` }
  if (!Number.isFinite(credits)) return { error: `"${input}" is not a price` }
  if (credits < 0) return { error: "a price cannot be negative" }
  credits = Math.round(credits)
  if (credits < 1) return { error: "the lowest price is $0.01/hr" }
  if (credits > MAX_PRICE_CREDITS) return { error: `the highest price is ${dollars(MAX_PRICE_CREDITS)}/hr` }
  return { credits }
}

/** Pure: credits as dollars, "$0.45", "$1,234.50". */
export function dollars(credits: number | null | undefined): string {
  const c = Number(credits) || 0
  const sign = c < 0 ? "-" : ""
  return `${sign}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Pure: a listing's price, "$0.45/hr". */
export function formatPrice(creditsPerHour: number | null | undefined): string {
  return `${dollars(creditsPerHour)}/hr`
}

/** Pure: what IRIS's checks say about a machine — the newer of the last pass and last fail wins. */
export function checksSummary(checks: Listing["checks"] | null | undefined, now = Date.now()): string {
  const pass = checks?.last_pass_at ? Date.parse(checks.last_pass_at) : NaN
  const fail = checks?.last_fail_at ? Date.parse(checks.last_fail_at) : NaN
  if (!Number.isNaN(fail) && (Number.isNaN(pass) || fail >= pass)) return "failed a check"
  if (!Number.isNaN(pass)) return checkedAgo(checks!.last_pass_at, now)
  return "not checked yet"
}

/** Pure: the exact command a buyer runs for one of a listing's models. */
export function runLine(l: Pick<Listing, "owner_user_id" | "models">, model?: string): string | null {
  const m = model ?? asArray<string>(l.models)[0]
  if (!m) return null
  return `iris run -m iris/hive/@${l.owner_user_id}/${m} "…"`
}

/** Pure: the browse list — optionally only listings serving `model`, online first, cheapest first. */
export function browseRows(listings: Listing[], model?: string): Listing[] {
  const want = model?.trim().toLowerCase()
  return listings
    .filter((l) => !want || asArray<string>(l.models).some((m) => m.toLowerCase() === want || m.toLowerCase().startsWith(want + ":")))
    .sort(
      (a, b) =>
        Number(b.status === "online") - Number(a.status === "online") ||
        (a.price_credits_per_hour ?? 0) - (b.price_credits_per_hour ?? 0) ||
        String(a.title ?? a.node_name).localeCompare(String(b.title ?? b.node_name)),
    )
}

/** Pure: the listing a person means, by full id, unique id prefix, node name or title. */
export function pickListing(listings: Listing[], ref: string): Listing | { error: string } {
  const r = String(ref ?? "").trim().toLowerCase()
  if (!r) return { error: "say which listing — see yours with: iris hive market listings" }
  const exact = listings.filter((l) => String(l.id).toLowerCase() === r)
  if (exact.length === 1) return exact[0]
  const hits = listings.filter(
    (l) =>
      String(l.id).toLowerCase().startsWith(r) ||
      String(l.node_name ?? "").toLowerCase() === r ||
      String(l.title ?? "").toLowerCase() === r,
  )
  if (hits.length === 1) return hits[0]
  if (!hits.length) return { error: `none of your listings matches "${ref}" — see them with: iris hive market listings` }
  return { error: `"${ref}" matches ${hits.length} listings — use more of the id` }
}

/** Pure: the machine a person means in their own fleet, by id, unique id prefix, or name. */
export function pickNode(nodes: any[], ref: string): any | { error: string } {
  const r = String(ref ?? "").trim().toLowerCase()
  const exact = nodes.filter((n) => String(n?.id ?? "").toLowerCase() === r || String(n?.name ?? "").toLowerCase() === r)
  if (exact.length === 1) return exact[0]
  const hits = exact.length ? exact : nodes.filter((n) => String(n?.id ?? "").toLowerCase().startsWith(r))
  if (hits.length === 1) return hits[0]
  if (!hits.length) return { error: `none of your machines matches "${ref}" — see them with: iris hive nodes list` }
  return { error: `"${ref}" matches ${hits.length} machines — use its id` }
}

export interface Earnings {
  held: number
  released: number
  refunded: number
  fee_percent: number
  charges: { id: string; buyer_name: string; model: string; seconds: number; amount: number; fee: number; net: number; status: string; created_at: string; settled_at: string | null }[]
}

/** Pure: the earnings screen, as lines (uncoloured, so it is tested as text). */
export function earningsLines(e: Partial<Earnings> | null | undefined, limit = 10): string[] {
  const charges = asArray<Earnings["charges"][number]>(e?.charges)
  const out = [
    `Held ${dollars(e?.held)}   ·   Paid ${dollars(e?.released)}   ·   Refunded ${dollars(e?.refunded)}   ·   IRIS fee ${Number(e?.fee_percent ?? 0)}%`,
  ]
  if (!charges.length) {
    out.push("No charges yet — nobody has run a model on your listed machines.")
    return out
  }
  out.push("")
  for (const c of charges.slice(0, limit))
    out.push(
      `${String(c.created_at ?? "").slice(0, 10)}  ${String(c.buyer_name ?? "?").padEnd(18)} ${String(c.model ?? "").padEnd(22)} ${minutes(c.seconds).padStart(7)}  ${dollars(c.amount).padStart(8)}  net ${dollars(c.net).padStart(8)}  ${statusWord(c.status)}`,
    )
  if (charges.length > limit) out.push(`… and ${charges.length - limit} more (--json for all)`)
  return out
}

export interface Spend {
  total: number
  charges: { id: string; owner_name: string; model: string; seconds: number; amount: number; status: string; created_at: string }[]
}

/** Pure: the spend screen, as lines. */
export function spendLines(s: Partial<Spend> | null | undefined, limit = 10): string[] {
  const charges = asArray<Spend["charges"][number]>(s?.charges)
  const out = [`Spent ${dollars(s?.total)} on other members' machines`]
  if (!charges.length) {
    out.push("Nothing yet. Browse machines: iris hive market")
    return out
  }
  out.push("")
  for (const c of charges.slice(0, limit))
    out.push(
      `${String(c.created_at ?? "").slice(0, 10)}  ${String(c.owner_name ?? "?").padEnd(18)} ${String(c.model ?? "").padEnd(22)} ${minutes(c.seconds).padStart(7)}  ${dollars(c.amount).padStart(8)}  ${statusWord(c.status)}`,
    )
  if (charges.length > limit) out.push(`… and ${charges.length - limit} more (--json for all)`)
  return out
}

function minutes(seconds: number | null | undefined): string {
  return `${Math.max(1, Math.ceil((Number(seconds) || 0) / 60))} min`
}

function statusWord(s: string): string {
  return s === "released" ? "paid" : s === "held" ? "held" : s === "refunded" ? "refunded" : String(s ?? "")
}

// ---------------------------------------------------------------------------------------------
// HTTP: every failure is a sentence, never a stack trace.

export const MARKET_MISSING = "this IRIS server doesn't have the marketplace yet"

class MarketError extends Error {}

async function market(path: string, init: RequestInit = {}, notFound = MARKET_MISSING): Promise<any> {
  let res: Response
  try {
    res = await hiveFetch(`/api/v6/hive/market${path}`, init)
  } catch (e: any) {
    throw new MarketError(`could not reach IRIS: ${e?.message ?? e}`)
  }
  const body: any = await res.json().catch(() => ({}))
  if (res.status === 404) throw new MarketError(notFound)
  if (res.status === 401) throw new MarketError("not signed in — run: iris auth login")
  if (!res.ok) throw new MarketError(body?.message || body?.error || `HTTP ${res.status}`)
  return body
}

function fail(what: string, e: unknown) {
  const why = e instanceof Error ? e.message : String(e)
  if (isJsonMode()) emitJsonError(`${what}: ${why}`)
  else console.log(`\n${highlight("✗")} ${what}: ${why}`)
  process.exitCode = 1
}

async function myListings(): Promise<Listing[]> {
  return asArray<Listing>((await market("/listings"))?.data)
}

function listingLine(l: Listing, now = Date.now(), model?: string): string[] {
  const lamp = l.status === "online" ? success("●") : dim("○")
  const name = String(l.title || l.node_name || l.node_id)
  const checks = checksSummary(l.checks, now)
  const hw = [l.hardware?.gpu, l.hardware?.cores ? `${l.hardware.cores} cores` : null, l.hardware?.ram_gb ? `${l.hardware.ram_gb} GB` : null]
    .filter(Boolean)
    .join(", ")
  const run = runLine(l, model)
  return [
    `  ${lamp} ${bold(name.padEnd(28))} ${formatPrice(l.price_credits_per_hour).padStart(10)}  ${dim(`by ${l.owner_name ?? "?"}`)}  ${checks === "failed a check" ? warn(checks) : dim(checks)}${l.active === false ? warn("  paused") : ""}`,
    `      ${asArray<string>(l.models).join(", ") || dim("no models")}${hw ? dim(`   ·   ${hw}`) : ""}${l.jobs_done ? dim(`   ·   ${l.jobs_done} jobs`) : ""}   ${dim(String(l.id).slice(0, 8))}`,
    ...(run ? [`      ${dim(run)}`] : []),
  ]
}

// ---------------------------------------------------------------------------------------------

const BrowseCommand = cmd({
  command: "$0",
  describe: "browse machines other members rent out, cheapest first",
  builder: (yargs) =>
    yargs
      .option("model", { type: "string", describe: "only machines serving this model" })
      .option("json", { type: "boolean", default: false })
      .example("$0 hive market", "every listed machine")
      .example("$0 hive market --model llama3.2:3b", "only machines serving that model")
      .example('$0 run -m iris/hive/@193/llama3.2:3b "…"', "use one — billed per minute of machine time"),
  async handler(argv) {
    let rows: Listing[]
    try {
      rows = asArray<Listing>((await market(""))?.data)
    } catch (e) {
      return fail("could not load the marketplace", e)
    }
    rows = browseRows(rows, argv.model as string | undefined)
    if (argv.json) return void (await writeJson(rows))
    console.log()
    if (!rows.length) {
      console.log(dim(argv.model ? `  No listed machine serves ${argv.model}.` : "  No machines are listed yet."))
      console.log(dim("  List yours: iris hive market sell <machine> --price 0.45"))
      return
    }
    const now = Date.now()
    for (const l of rows) console.log(listingLine(l, now, argv.model as string | undefined).join("\n"))
    console.log()
    console.log(dim("  Billed per minute of machine time. Held until IRIS's checks pass; refunded if the machine fails one."))
    console.log(dim("  The machine's owner can read what you send. Patient data is refused on listed machines."))
  },
})

const ListingsCommand = cmd({
  command: "listings",
  describe: "your own listed machines",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    let rows: Listing[]
    try {
      rows = await myListings()
    } catch (e) {
      return fail("could not load your listings", e)
    }
    if (argv.json) return void (await writeJson(rows))
    console.log()
    if (!rows.length) return void console.log(dim("  You have no listings. List a machine: iris hive market sell <machine> --price 0.45"))
    const now = Date.now()
    for (const l of rows) console.log(listingLine(l, now).join("\n"))
    console.log()
    console.log(dim("  Change: iris hive market price|pause|resume|remove <listing>   ·   money: iris hive market earnings"))
  },
})

const SellCommand = cmd({
  command: "sell <node>",
  describe: "list one of your serving machines for other IRIS members to run models on, at a price per hour",
  builder: (yargs) =>
    yargs
      .positional("node", { type: "string", describe: "your machine, by name or id", demandOption: true })
      .option("price", { type: "string", describe: "dollars per hour, e.g. 0.45", demandOption: true })
      .option("models", { type: "string", describe: "only these models, comma-separated (default: all it serves)" })
      .option("title", { type: "string" })
      .option("description", { type: "string" })
      .option("yes", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" })
      .example("$0 hive market sell studio-mac --price 0.45", "list a machine at $0.45 an hour")
      .example("$0 hive market sell studio-mac --price 0.45 --models llama3.2:3b,qwen3:14b --yes", "only two models, no prompt"),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const price = parsePrice(argv.price as string)
    if ("error" in price) return fail("bad price", new Error(price.error))
    let nodes: any[]
    try {
      nodes = await fleet(userId)
    } catch (e) {
      return fail("could not load your machines", e)
    }
    const node = pickNode(nodes, String(argv.node))
    if ("error" in node) return fail("which machine?", new Error(node.error))
    const name = String(node.name ?? node.id)
    const models = argv.models ? String(argv.models).split(",").map((m) => m.trim()).filter(Boolean) : undefined

    if (!argv.yes) {
      console.log()
      console.log(`${highlight("!")} ${bold(`List ${name} at ${formatPrice(price.credits)}?`)}`)
      console.log(dim("  Any IRIS member can then run models on this machine, at your electricity."))
      console.log(dim("  You can read every prompt they send. Patient data is refused on listed machines."))
      console.log(dim("  Their money is held until IRIS's checks of this machine pass, then paid to you minus IRIS's fee."))
      console.log(dim("  If the machine fails a check, they are refunded."))
      const ok = await prompts.confirm({ message: `List ${name}?`, initialValue: true })
      if (ok !== true) return void console.log(dim("\n  Not listed."))
    }

    let listing: Listing
    try {
      const body = await market("/listings", {
        method: "POST",
        body: JSON.stringify({
          node_id: node.id,
          price_credits_per_hour: price.credits,
          ...(models ? { models } : {}),
          ...(argv.title ? { title: String(argv.title) } : {}),
          ...(argv.description ? { description: String(argv.description) } : {}),
        }),
      })
      listing = body?.data
    } catch (e) {
      return fail("could not list it", e)
    }
    if (argv.json) return void (await writeJson(listing))
    console.log(`\n${success("●")} listed ${bold(name)} at ${bold(formatPrice(listing?.price_credits_per_hour ?? price.credits))}  ${dim(String(listing?.id ?? "").slice(0, 8))}`)
    const run = runLine({ owner_user_id: userId, models: asArray<string>(listing?.models).length ? listing.models : (models ?? []) })
    if (run) console.log(dim(`  Members use: ${run}`))
    console.log(dim("  See it: iris hive market listings   ·   money: iris hive market earnings"))
    const serving = node?.inference ? node.inference.enabled === true : readSettings().enabled
    if (!serving) console.log(warn(`  ! ${name} is not serving models, so nobody can use it yet. On it, run: `) + bold("iris hive models serve on"))
  },
})

async function changeListing(ref: string, patch: Record<string, unknown> | null, done: (l: Listing) => string, json: boolean) {
  await requireAuth()
  let mine: Listing[]
  try {
    mine = await myListings()
  } catch (e) {
    return fail("could not load your listings", e)
  }
  const pick = pickListing(mine, ref)
  if ("error" in pick) return fail("which listing?", new Error(pick.error))
  let out: any
  try {
    out = patch
      ? await market(`/listings/${encodeURIComponent(pick.id)}`, { method: "PATCH", body: JSON.stringify(patch) }, "that listing no longer exists")
      : await market(`/listings/${encodeURIComponent(pick.id)}`, { method: "DELETE" }, "that listing no longer exists")
  } catch (e) {
    return fail("could not change it", e)
  }
  if (json) return void (await writeJson(out?.data ?? out))
  console.log(`\n${success("✓")} ${done({ ...pick, ...(out?.data ?? {}) })}`)
}

const PriceCommand = cmd({
  command: "price <listing> <price>",
  describe: "change a listing's price per hour",
  builder: (yargs) =>
    yargs
      .positional("listing", { type: "string", describe: "listing id (or its start), or the machine's name", demandOption: true })
      .positional("price", { type: "string", describe: "dollars per hour, e.g. 0.60", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const price = parsePrice(argv.price as string)
    if ("error" in price) return fail("bad price", new Error(price.error))
    await changeListing(String(argv.listing), { price_credits_per_hour: price.credits }, (l) => `${l.title || l.node_name} now costs ${formatPrice(l.price_credits_per_hour)}`, !!argv.json)
  },
})

function toggle(command: "pause" | "resume" | "remove", describe: string) {
  return cmd({
    command: `${command} <listing>`,
    describe,
    builder: (yargs) =>
      yargs
        .positional("listing", { type: "string", describe: "listing id (or its start), or the machine's name", demandOption: true })
        .option("json", { type: "boolean", default: false }),
    async handler(argv) {
      const name = (l: Listing) => l.title || l.node_name
      if (command === "remove") return changeListing(String(argv.listing), null, (l) => `${name(l)} is no longer listed`, !!argv.json)
      const active = command === "resume"
      await changeListing(
        String(argv.listing),
        { active },
        (l) => (active ? `${name(l)} is listed again` : `${name(l)} is paused — members cannot use it until you resume it`),
        !!argv.json,
      )
    },
  })
}

const EarningsCommand = cmd({
  command: "earnings",
  describe: "what members have paid to run models on your listed machines — held, paid, refunded",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    let data: Earnings
    try {
      data = (await market("/earnings"))?.data
    } catch (e) {
      return fail("could not load your earnings", e)
    }
    if (argv.json) return void (await writeJson(data))
    console.log()
    for (const line of earningsLines(data)) console.log(line ? `  ${line}` : "")
    console.log()
    console.log(dim("  Held money is paid once IRIS's checks of the machine pass, and refunded if it fails one."))
  },
})

const SpendCommand = cmd({
  command: "spend",
  describe: "what you have paid to run models on other members' machines",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    let data: Spend
    try {
      data = (await market("/spend"))?.data
    } catch (e) {
      return fail("could not load your spend", e)
    }
    if (argv.json) return void (await writeJson(data))
    console.log()
    for (const line of spendLines(data)) console.log(line ? `  ${line}` : "")
  },
})

export const HiveMarketCommand = cmd({
  command: "market",
  describe: "the Hive marketplace — browse machines to rent, sell time on yours, see earnings and spend",
  builder: (yargs) =>
    yargs
      .command(BrowseCommand)
      .command(ListingsCommand)
      .command(SellCommand)
      .command(PriceCommand)
      .command(toggle("pause", "stop members using a listing for now"))
      .command(toggle("resume", "let members use a paused listing again"))
      .command(toggle("remove", "take a listing off the marketplace"))
      .command(EarningsCommand)
      .command(SpendCommand),
  handler: () => {},
})
