import fs from "fs"
import os from "os"
import path from "path"
import { runSpec } from "./reachr-playwright"

/**
 * The Instagram lane of `iris reachr scrape` — a front door onto the lead scraper that already
 * exists (tests/e2e/leadgen-scraper.spec.ts: commenters, followers, profile lists, the DM inbox),
 * rather than a second implementation of it.
 *
 * ALWAYS DRY. The scraper is run with DRY_RUN=1 and asked for a result file; any writing is done
 * by `iris reachr scrape`'s own write path, so Instagram leads get the same board dedupe, upsert
 * detection and PUBLIC-not-confirmed provenance note as leads from the web.
 *
 * WHERE IT CAN RUN. It needs the Freelabel checkout (the spec and its providers live there) and a
 * saved Instagram session for the account doing the browsing. Both are checked up front and a
 * missing one is reported as what to do, not as "no leads". It opens a VISIBLE browser, as the
 * existing runner does — Instagram is hostile to headless ones.
 */

import { mapInstagramResult, type IgMode } from "./reachr-core"
export { inferMode, normalizeTarget, isMode, type IgMode } from "./reachr-core"

const SPEC = path.join("tests", "e2e", "leadgen-scraper.spec.ts")

/** The Freelabel checkout that holds the scraper: FREELABEL_PATH, config, the cwd's ancestors, ~/sites/freelabel. */
export function findFreelabelRoot(): string | null {
  const has = (d?: string | null) => !!d && fs.existsSync(path.join(d, SPEC))
  const fromConfig = (() => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".iris", "config.json"), "utf8"))
      return c.freelabel_path || c.freelabelPath || null
    } catch {
      return null
    }
  })()
  const ancestors: string[] = []
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    ancestors.push(d)
    if (path.dirname(d) === d) break
  }
  const candidates = [process.env.FREELABEL_PATH, fromConfig, ...ancestors, path.join(os.homedir(), "sites", "freelabel")]
  return candidates.find((d) => has(d)) ?? null
}

/** Instagram accounts with a saved session in this checkout (tests/e2e/instagram-auth-<account>.json). */
export function savedSessions(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, "tests", "e2e"))
      .map((f) => f.match(/^instagram-auth-(.+)\.json$/)?.[1])
      .filter((x): x is string => !!x)
      .sort()
  } catch {
    return []
  }
}

export interface InstagramRun {
  root: string
  account: string
  mode: IgMode
  target: string
  max: number
  bloqId: number
  token: string
  userId: number
}

/** Run the scraper (dry) and return data in the same shape scrape-leads.sh produces for the web. */
export async function runInstagramScrape(r: InstagramRun): Promise<{ data?: any; error?: string }> {
  const resultFile = path.join(os.tmpdir(), `reachr-ig-${process.pid}-${Date.now()}.json`)
  const timeoutMs = Math.max(10 * 60_000, r.max * 20_000)
  const env = {
    ...process.env,
    DRY_RUN: "1",
    RESULT_FILE: resultFile,
    DISCOVERY_MODE: r.mode,
    TARGET_URL: r.target,
    LIMIT: String(r.max),
    BOARD_ID: String(r.bloqId),
    IG_ACCOUNT: r.account,
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
    return { error: `the Instagram scraper produced no result (exit ${output.code}, ${output.attempts} attempt(s)): ${tail || "no output"}` }
  }

  return { data: mapInstagramResult(raw) }
}
