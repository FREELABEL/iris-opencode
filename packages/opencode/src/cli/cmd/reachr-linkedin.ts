import fs from "fs"
import os from "os"
import path from "path"
import { runSpec } from "./reachr-playwright"
import { mapLinkedInResult } from "./reachr-core"

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

export { liSlug } from "./reachr-core"

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
    return { error: `the LinkedIn scraper produced no result (exit ${output.code}, ${output.attempts} attempt(s)): ${tail || "no output"}` }
  }

  return { data: mapLinkedInResult(raw) }
}
