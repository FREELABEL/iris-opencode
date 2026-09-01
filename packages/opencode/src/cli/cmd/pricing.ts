import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, printDivider, dim, writeJson } from "./iris-api"

/**
 * `iris pricing` — where to sign up, answered on the machine the agent is running on.
 *
 * IRIS's conversion event is an install: someone downloads the CLI or the desktop app and the
 * agent is meant to hand them everything after that. Until now it could not hand them the one
 * thing that closes the loop. There was no pricing, plans, billing, account or subscribe verb;
 * `packages` is operator tooling for EDITING the catalogue, not a way for a user to buy.
 *
 * Two properties this command must have, both learned from live bugs:
 *
 * 1. It works SIGNED OUT. The user who needs it most has just installed and has no account —
 *    gating pricing behind auth fails exactly the person it exists for. The catalogue endpoint
 *    is public; if it cannot be reached for any reason we still print the pricing URL, because
 *    a URL with no table beats a table nobody can reach.
 *
 * 2. It never prints the other brand's URL. heyiris.io/pricing and heyiris.io/register both
 *    shipped redirects to freelabel.net — an IRIS visitor sent to another company's page. An
 *    agent repeating that in a terminal is trusted more than a web page, and no analytics will
 *    catch it. Filtering is on each package's own `brand` field.
 *
 * See /p/epic-entry-points (ADR-02) and bug #183182.
 */

type Brand = "iris" | "freelabel"

/**
 * The catalogue's own brand values are "iris" and "elon" — NOT "freelabel". Filtering on
 * "freelabel" matches zero of the 24 live packages and renders an empty list, which is what
 * the first version of this file did. The user-facing word is FREELABEL; the stored value is
 * a legacy product name. Mapping them here keeps the CLI's vocabulary honest without asking
 * the catalogue to migrate.
 */
const BRAND_VALUES: Record<Brand, string[]> = {
  iris: ["iris"],
  freelabel: ["elon", "freelabel"],
}

const SITE: Record<Brand, { name: string; pricing: string; install: string }> = {
  iris: {
    name: "IRIS",
    pricing: "https://web.heyiris.io/pricing",
    install: "https://heyiris.io/downloads",
  },
  freelabel: {
    name: "FREELABEL",
    pricing: "https://web.freelabel.net/pricing",
    install: "https://freelabel.net/p/freelabel-start",
  },
}

/** The CLI is an IRIS product, so IRIS is the default. --brand switches it. */
const DEFAULT_BRAND: Brand = "iris"

function brandOf(pkg: any): string {
  return String(pkg?.brand ?? "").toLowerCase()
}

function money(pkg: any): string {
  const price = pkg?.price ?? 0
  const period = pkg?.billing_period ?? "month"
  if (Number(price) === 0) return "free"
  return `$${price}/${period === "once" ? "once" : period}`
}

/**
 * Public catalogue read. Deliberately tolerant: any failure returns [] rather than throwing,
 * because the URL below it is the part the user actually needs.
 */
async function fetchPackages(): Promise<any[]> {
  try {
    const res = await irisFetch("/api/v1/platform/packages")
    if (!res.ok) return []
    const data = (await res.json()) as { data?: any[] }
    return data?.data ?? (Array.isArray(data) ? (data as any) : [])
  } catch {
    return []
  }
}

function sellable(pkgs: any[], brand: Brand): any[] {
  const accepted = BRAND_VALUES[brand]
  return pkgs
    .filter((p) => accepted.includes(brandOf(p)))
    .filter((p) => p?.public !== false)
    .sort((a, b) => Number(a?.price ?? 0) - Number(b?.price ?? 0))
}

const ListCmd = cmd({
  command: "$0 [slug]",
  describe: "show plans and where to sign up",
  builder: (y: any) =>
    y
      .positional("slug", { describe: "a single package slug", type: "string" })
      .option("brand", {
        describe: "which brand's plans (iris | freelabel)",
        type: "string",
        choices: ["iris", "freelabel"],
        default: DEFAULT_BRAND,
      })
      .option("url", { describe: "print only the signup URL", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const brand: Brand = (args.brand as Brand) ?? DEFAULT_BRAND
    const site = SITE[brand]

    // --url is for piping and for the agent. No chrome, no spinner, no auth, one line.
    if (args.url) {
      console.log(site.pricing)
      return
    }

    const all = await fetchPackages()
    const plans = sellable(all, brand)
    const one = args.slug ? plans.find((p) => p?.slug === args.slug) : null

    if (args.json) {
      await writeJson({
        brand,
        pricing_url: site.pricing,
        install_url: site.install,
        packages: one ? [one] : plans,
      })
      return
    }

    UI.empty()
    prompts.intro(`◈  ${site.name} pricing`)

    if (args.slug && !one) {
      console.log(`  No public ${site.name} plan with slug "${args.slug}".`)
      console.log(dim(`  Run 'iris pricing' to see the list.`))
      prompts.outro(site.pricing)
      return
    }

    const show = one ? [one] : plans

    if (show.length === 0) {
      // The catalogue was unreachable or empty. Still answer the question that was asked.
      console.log(`  Could not read the plan list just now.`)
      console.log(`  Plans and signup:  ${site.pricing}`)
      prompts.outro(dim("Nothing else is needed to sign up."))
      return
    }

    printDivider()
    for (const p of show) {
      const star = p?.popular ? "  ★" : ""
      console.log(`  ${p.slug ?? "?"}  ${dim(`#${p.id ?? "?"}`)}  ${money(p)}${star}`)
      if (p?.title) console.log(`    ${p.title}`)
      if (p?.subtitle) console.log(dim(`    ${p.subtitle}`))
      if (one) {
        const feats = p?.features?.displayFeatures
        if (Array.isArray(feats)) for (const f of feats.slice(0, 8)) console.log(dim(`      · ${f}`))
      }
      console.log()
    }
    printDivider()

    console.log(`  Sign up:  ${site.pricing}`)
    console.log(dim(`  New here? ${site.install}`))
    prompts.outro(dim("iris pricing <slug> for one plan · --url to pipe it · --json for the agent"))
  },
})

export const PricingCommand = cmd({
  command: "pricing",
  aliases: ["plans"],
  describe: "plans and where to sign up — works signed out",
  builder: (y: any) => y.command(ListCmd).help(),
  async handler() {},
})
