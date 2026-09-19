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

export type IgMode = "comments" | "followers" | "profiles" | "inbox"
const MODES: IgMode[] = ["comments", "followers", "profiles", "inbox"]

/** What a target most likely means: a post → its commenters, an account → its followers. */
export function inferMode(target: string): IgMode {
  const t = target.trim().toLowerCase()
  if (t === "inbox") return "inbox"
  if (t.includes(",")) return "profiles"
  if (/\/(p|reel|reels|tv)\//.test(t)) return "comments"
  return "followers"
}

export function normalizeTarget(target: string, mode: IgMode): string {
  const t = target.trim()
  if (mode === "inbox") return ""
  const bare = (h: string) =>
    h.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").replace(/^@/, "")
  if (mode === "profiles") return t.split(",").map((h) => `@${bare(h)}`).join(",")
  if (/^@?[A-Za-z0-9._]+$/.test(t)) return `https://www.instagram.com/${bare(t)}/`
  return t
}

export function isMode(m: unknown): m is IgMode {
  return MODES.includes(m as IgMode)
}

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

  const profiles: any[] = raw.profiles ?? []
  const errors: string[] = raw.errors ?? []
  // Nothing scraped AND the scraper reported errors: it did not get to look (session expired,
  // login wall, post gone) — that is "could not measure", never "no leads here".
  if (!profiles.length && !raw.scraped && errors.length) {
    return { data: { measured: false, ok: false, error: errors.join("; ").slice(0, 400), leads: [], contacts: [], skipped: [] } }
  }

  const source_url = raw.target || "https://www.instagram.com/direct/inbox/"
  const leads = profiles.map((p) => {
    // Strip a trailing "/" or whitespace: the scraper used to append "/" to its whole target, so
    // the last handle of a profiles list came back as "handle/" (fixed at the source too).
    const username = String(p.username ?? "").replace(/^@/, "").replace(/[/\s]+$/, "")
    const md = p.rawMetadata ?? {}
    const bio = String(md.bio ?? "")
    const email = bio.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0]
    const display = p.displayName && p.displayName !== username ? String(p.displayName) : `@${username}`
    return {
      name: { v: display, how: "instagram" },
      title: null,
      email: email ? { v: email, how: "ig-bio" } : null,
      phone: null,
      socials: { instagram: `https://www.instagram.com/${username}/` }, // built from the CLEAN handle
      company: null,
      evidence: [`instagram:${raw.mode}`, ...(md.followers ? [`${md.followers} followers`] : [])],
      source_url,
      handle: username,
      source: `leadgen:instagram:${raw.mode}`,
      extra: {
        followers: md.followers ?? null,
        bio: bio || null,
        comment: md.commentText || null,
        context: p.sourceContext || null,
      },
    }
  })
  return {
    data: {
      measured: true,
      ok: leads.length > 0,
      leads,
      contacts: [],
      skipped: [],
      counts: { pages: 1, leads: leads.length, with_email: leads.filter((l) => l.email).length },
      instagram: {
        mode: raw.mode,
        account: raw.ig_account,
        target: raw.target,
        scraped: raw.scraped,
        existing_skipped: raw.existing_skipped,
        errors,
      },
    },
  }
}
