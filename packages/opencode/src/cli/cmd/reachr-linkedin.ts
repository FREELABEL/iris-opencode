import fs from "fs"
import os from "os"
import path from "path"
import { runSpec } from "./reachr-playwright"

/**
 * The LinkedIn lane of `iris reachr scrape` — a front door onto the scraper that already exists
 * (tests/e2e/linkedin-scraper.spec.ts: people search, or the people in your LinkedIn inbox), the
 * same way the Instagram lane fronts leadgen-scraper.spec.ts.
 *
 * ALWAYS DRY. The scraper runs with DRY_RUN=1 and writes a result file; any writing is done by
 * `iris reachr scrape`'s own write path, so LinkedIn leads get the same board dedupe, upsert
 * detection and PUBLIC-not-confirmed provenance note as every other source.
 *
 * IT BROWSES AS YOU. The saved session (tests/e2e/linkedin-auth.json) is a real LinkedIn login,
 * and LinkedIn restricts accounts that pull too many profiles too fast — so the profile count is
 * capped well below what the scraper allows, and a visible browser is used, as the runner does.
 */

export type LiMode = "search" | "inbox"

export const LI_MAX_PROFILES = 100

const SPEC = path.join("tests", "e2e", "linkedin-scraper.spec.ts")

export function liSessionFile(root: string): string | null {
  const f = process.env.BROWSER_SESSION_FILE || path.join(root, "tests", "e2e", "linkedin-auth.json")
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"))
    const liAt = (s.cookies ?? []).find((c: any) => c?.name === "li_at")
    if (!liAt) return null
    // An expired login cookie browses to the login wall and scrapes nothing — say so up front.
    if (liAt.expires && liAt.expires > 0 && liAt.expires * 1000 < Date.now()) return null
    return f
  } catch {
    return null
  }
}

/** "https://www.linkedin.com/in/jane-doe-123/?x" → "jane-doe-123" */
export function liSlug(v: unknown): string {
  const m = String(v ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i)
  return m ? decodeURIComponent(m[1]).toLowerCase() : ""
}

export interface LinkedInRun {
  root: string
  mode: LiMode
  query: string
  location: string
  max: number
  bloqId: number
  token: string
  userId: number
}

/** Run the scraper (dry) and return data in the same shape scrape-leads.sh produces for the web. */
export async function runLinkedInScrape(r: LinkedInRun): Promise<{ data?: any; error?: string }> {
  const resultFile = path.join(os.tmpdir(), `reachr-li-${process.pid}-${Date.now()}.json`)
  const timeoutMs = Math.max(10 * 60_000, r.max * 20_000)
  const env = {
    ...process.env,
    DRY_RUN: "1",
    RESULT_FILE: resultFile,
    DISCOVERY_MODE: r.mode,
    SEARCH_QUERY: r.query,
    SEARCH_LOCATION: r.location,
    LIMIT: String(r.max),
    BOARD_ID: String(r.bloqId),
    HEYIRIS_TOKEN: r.token,
    USER_ID: String(r.userId),
    CAMPAIGN_LABEL: "ReachR scrape",
  }
  const output = await runSpec({ root: r.root, spec: SPEC, env, timeoutMs, resultFile })

  let raw: any = null
  try {
    raw = JSON.parse(fs.readFileSync(resultFile, "utf8"))
  } catch {
    raw = null
  } finally {
    fs.rmSync(resultFile, { force: true })
  }
  if (!raw) {
    const tail = output.text.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(-400)
    return { error: `the LinkedIn scraper produced no result (exit ${output.code}): ${tail || "no output"}` }
  }

  const profiles: any[] = raw.profiles ?? []
  const errors: string[] = raw.errors ?? []
  // Nothing scraped AND errors: it never got to look (login wall, checkpoint, rate limit) —
  // "could not measure", never "no leads".
  if (!profiles.length && !raw.scraped && errors.length) {
    return { data: { measured: false, ok: false, error: errors.join("; ").slice(0, 400), leads: [], contacts: [], skipped: [] } }
  }

  const source_url = raw.target || "https://www.linkedin.com/"
  const leads = profiles
    .map((p) => {
      const url = String(p.profileUrl ?? "")
      const slug = liSlug(url)
      const md = p.rawMetadata ?? {}
      const name = String(p.displayName || p.username || "").trim()
      if (!name || !slug) return null
      // A headline is usually "Title at Company"; split it only when it says so.
      const headline = String(md.headline ?? "").trim()
      // "CEO at Blu Creative Agency" → title + company. Only the first clause: headlines run on
      // ("Owner @ Artscape Creative | Dallas Custom Screen Printing, …").
      const first = headline.split(/\s+\|\s+|\.\s/)[0]
      const at = first.match(/^(.{2,80}?)\s+(?:at|@)\s+(.{2,80})$/i)
      // LinkedIn's own one-line summary states the company when the headline does not:
      // "Founder & CEO at Blu Creative Agency in Dallas since December 2018, …".
      const fromSummary = String(md.summary ?? "").match(/\b(?:at|of)\s+(.{2,80}?)\s+in\s+[A-Z][\w .'-]{1,40}?\s+since\b/)
      const company = at ? at[2] : fromSummary?.[1]
      return {
        name: { v: name, how: "linkedin" },
        title: headline ? { v: (at ? at[1] : first).slice(0, 120), how: "linkedin-headline" } : null,
        email: null,
        phone: null,
        socials: { linkedin: `https://www.linkedin.com/in/${slug}/` },
        company,
        company_how: at ? "linkedin-headline" : company ? "linkedin-summary" : undefined,
        evidence: [`linkedin:${raw.mode}`, ...(md.location ? [String(md.location)] : [])],
        source_url,
        platform: "linkedin" as const,
        handle: slug,
        source: `leadgen:linkedin:${raw.mode}`,
        extra: {
          headline: headline || null,
          location: md.location || null,
          summary: md.summary || null,
          // no `context`: for a search it is the search URL, already the note's Source line
        },
      }
    })
    .filter(Boolean)
  return {
    data: {
      measured: true,
      ok: leads.length > 0,
      leads,
      contacts: [],
      skipped: [],
      counts: { pages: 1, leads: leads.length, with_email: 0 },
      linkedin: { mode: raw.mode, query: raw.query, location: raw.location, target: raw.target, scraped: raw.scraped, errors },
    },
  }
}
