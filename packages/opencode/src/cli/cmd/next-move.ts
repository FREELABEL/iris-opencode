// #187930: `iris next` — the first screen is ONE next move.
//
// A new account faces ~1,300 commands. The fix is not a better index; it is a single
// card that names one move, who does it, how long it takes, and the exact command to
// run. This file is the pure part (state → move) so the rules are testable without
// the network; platform-next.ts gathers the state and prints the card.

/** What we could learn about the account. `null` = couldn't tell (fetch failed). */
export interface AccountState {
  bloqs: number | null
  firstBloqId: number | null
  /** business_context already carries a brand or website. */
  hasBrand: boolean | null
  website: string | null
  integrations: number | null
  pages: number | null
}

export interface NextMove {
  id: string
  title: string
  command: string
  who: string
  minutes: number
  why: string
}

export const SITE_PLACEHOLDER = "https://your-site.com"

/**
 * Exactly one move, always. Rules run in onboarding order and the first gap wins.
 * An UNKNOWN signal (null) never fires a rule: recommending "create a workspace" to
 * someone whose bloq list merely failed to load is worse than moving on.
 */
export function recommendNext(s: AccountState): NextMove {
  if (s.bloqs === 0) {
    return {
      id: "create-workspace",
      title: "Already have a site? Paste the URL — IRIS sets up your workspace from it",
      command: `iris next --site ${SITE_PLACEHOLDER}`,
      who: "IRIS reads your site; you paste one URL",
      minutes: 1,
      why: "Your brand and context come from the site you already own instead of a blank form. No site? Run: iris bloqs create --name \"My Business\"",
    }
  }
  if (s.hasBrand === false) {
    return {
      id: "brand-from-site",
      title: "Already have a site? Paste the URL",
      command: `iris next --site ${SITE_PLACEHOLDER}`,
      who: "IRIS reads your site; you paste one URL",
      minutes: 1,
      why: "IRIS reads your real site for brand and context instead of rebuilding a page you own.",
    }
  }
  if (s.integrations === 0) {
    return {
      id: "connect-integration",
      title: "Connect your inbox so IRIS can act on real conversations",
      command: "iris integrations connect gmail",
      who: "you (one OAuth click)",
      minutes: 2,
      why: "Nothing IRIS does for you reaches a customer until one channel is connected.",
    }
  }
  if (s.pages === 0 && s.website) {
    return {
      id: "first-page",
      title: "Publish a Genesis page from your site",
      command: `iris onboard ${s.website} --no-publish`,
      who: "IRIS drafts it; you approve",
      minutes: 3,
      why: "A draft built from your own brand, ready to review before anything goes live.",
    }
  }
  return {
    id: "say-what-you-want",
    title: "Say what you want done — IRIS picks the command",
    command: 'iris intent "what I want to get done today"',
    who: "you, in one sentence",
    minutes: 1,
    why: "Setup is done; from here the fastest path is describing the outcome, not browsing commands.",
  }
}

/** Normalise a pasted URL; null if it isn't one. Bare domains get https://. */
export function normalizeSiteUrl(raw: string | undefined | null): string | null {
  const t = (raw ?? "").trim()
  if (!t) return null
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname.includes(".") || u.hostname === "your-site.com") return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * The slice of a websiteBrandExtractor result worth keeping as account context.
 * Stored under business_context.brand so every later agent run reads the real brand.
 */
export function brandContextFromExtraction(result: any, url: string): Record<string, unknown> {
  const b = result?.brand ?? {}
  return {
    source_url: url,
    name: b.brand_name ?? new URL(url).hostname,
    tagline: b.tagline ?? null,
    description: result?.page_description ?? null,
    colors: b.colors ?? {},
    fonts: b.font_families ?? [],
    logo: b.logo_urls?.[0]?.src ?? null,
    theme_mode: b.theme_mode ?? null,
    social_links: b.social_links ?? {},
    extracted_at: new Date().toISOString(),
  }
}

/** Does a business_context already say who this business is? */
export function contextHasBrand(ctx: Record<string, any> | null | undefined): boolean {
  if (!ctx) return false
  const brand = ctx.brand
  return Boolean((brand && (brand.name || brand.source_url)) || ctx.website)
}
