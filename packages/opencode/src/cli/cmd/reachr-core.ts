/**
 * ReachR's decisions, with no I/O — what a scrape turns into, whether a person is already on the
 * board, what a written lead looks like, and whether a reply is already on a lead's thread.
 *
 * The commands (platform-reachr-scrape.ts, platform-reachr-inbox.ts) and the lane runners
 * (reachr-instagram.ts, reachr-linkedin.ts, reachr-playwright.ts) do the browsing and the HTTP;
 * every judgement they act on lives here so it can be tested as a scenario. See reachr-core.test.ts.
 */

// ── types ────────────────────────────────────────────────────────────────────

export interface Field {
  v: string
  how: string
}
export interface Lead {
  name: Field
  title?: Field | null
  email?: Field | null
  phone?: Field | null
  socials?: Record<string, string>
  company?: string
  company_how?: string
  evidence?: string[]
  source_url: string
  /** Instagram / LinkedIn lanes: the handle (IG @handle without @, or the LinkedIn /in/ slug). */
  platform?: "instagram" | "linkedin"
  handle?: string
  source?: string
  extra?: Record<string, unknown>
}

export const platformOf = (l: Lead) => l.platform ?? (l.handle ? "instagram" : undefined)
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase()
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10)

// ── Instagram targets ────────────────────────────────────────────────────────

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

// ── scrape results → leads ───────────────────────────────────────────────────

/** "https://www.linkedin.com/in/jane-doe-123/?x" → "jane-doe-123" */
export function liSlug(v: unknown): string {
  const m = String(v ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i)
  if (!m) return ""
  try {
    return decodeURIComponent(m[1]).toLowerCase()
  } catch {
    return m[1].toLowerCase()
  }
}

const couldNotLook = (errors: string[]) => ({
  measured: false,
  ok: false,
  error: errors.join("; ").slice(0, 400),
  leads: [] as Lead[],
  contacts: [],
  skipped: [],
})

/** The Instagram scraper's RESULT_FILE → the shape scrape-leads.sh produces for the web. */
export function mapInstagramResult(raw: any): any {
  const profiles: any[] = raw.profiles ?? []
  const errors: string[] = raw.errors ?? []
  // Nothing scraped AND the scraper reported errors: it did not get to look (session expired,
  // login wall, post gone) — that is "could not measure", never "no leads here".
  if (!profiles.length && !raw.scraped && errors.length) return couldNotLook(errors)

  const source_url = raw.target || "https://www.instagram.com/direct/inbox/"
  const leads: Lead[] = profiles.map((p) => {
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
      evidence: [`instagram:${raw.mode}`, ...(md.followers ? [`${md.followers} followers`] : [])],
      source_url,
      platform: "instagram" as const,
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
  }
}

/** The LinkedIn scraper's RESULT_FILE → the same shape. */
export function mapLinkedInResult(raw: any): any {
  const profiles: any[] = raw.profiles ?? []
  const errors: string[] = raw.errors ?? []
  // Nothing scraped AND errors: it never got to look (login wall, checkpoint, rate limit).
  if (!profiles.length && !raw.scraped && errors.length) return couldNotLook(errors)

  const source_url = raw.target || "https://www.linkedin.com/"
  const leads: Lead[] = []
  for (const p of profiles) {
    const slug = liSlug(p.profileUrl)
    const md = p.rawMetadata ?? {}
    const name = String(p.displayName || p.username || "").trim()
    if (!name || !slug) continue
    const headline = String(md.headline ?? "").trim()
    // "CEO at Blu Creative Agency" → title + company. Only the first clause: headlines run on
    // ("Owner @ Artscape Creative | Dallas Custom Screen Printing, …").
    const first = headline.split(/\s+\|\s+|\.\s/)[0]
    const at = first.match(/^(.{2,80}?)\s+(?:at|@)\s+(.{2,80})$/i)
    // LinkedIn's own one-line summary states the company when the headline does not:
    // "Founder & CEO at Blu Creative Agency in Dallas since December 2018, …".
    const fromSummary = String(md.summary ?? "").match(/\b(?:at|of)\s+(.{2,80}?)\s+in\s+[A-Z][\w .'-]{1,40}?\s+since\b/)
    const company = at ? at[2] : fromSummary?.[1]
    leads.push({
      name: { v: name, how: "linkedin" },
      title: headline ? { v: (at ? at[1] : first).slice(0, 120), how: "linkedin-headline" } : null,
      email: null,
      phone: null,
      socials: { linkedin: `https://www.linkedin.com/in/${slug}/` },
      company,
      company_how: at ? "linkedin-headline" : company ? "linkedin-summary" : undefined,
      evidence: [`linkedin:${raw.mode}`, ...(md.location ? [String(md.location)] : [])],
      source_url,
      platform: "linkedin",
      handle: slug,
      source: `leadgen:linkedin:${raw.mode}`,
      extra: {
        headline: headline || null,
        location: md.location || null,
        summary: md.summary || null,
        // no `context`: for a search it is the search URL, already the note's Source line
      },
    })
  }
  return {
    measured: true,
    ok: leads.length > 0,
    leads,
    contacts: [],
    skipped: [],
    counts: { pages: 1, leads: leads.length, with_email: 0 },
    linkedin: { mode: raw.mode, query: raw.query, location: raw.location, target: raw.target, scraped: raw.scraped, errors },
  }
}

// ── dedupe ───────────────────────────────────────────────────────────────────

/** Same person? The platform identity first, then email, then phone, then name (+ company). */
export function findExisting(l: Lead, onBoard: any[]): any | null {
  // An Instagram handle is the strongest identity a scraped IG lead has — and the one earlier
  // SOM leadgen runs stored (contact_info.instagram, nickname "@handle"), so match it first.
  // LinkedIn leads (the Playwright runner's and ours) keep the profile URL in contact_info.linkedin.
  const handle = l.handle ? norm(l.handle).replace(/^@/, "") : ""
  const byHandle = !handle
    ? null
    : platformOf(l) === "linkedin"
      ? onBoard.find((r) => liSlug(r?.contact_info?.linkedin) === handle || liSlug(r?.linkedin_url) === handle)
      : onBoard.find(
          (r) => norm(r?.contact_info?.instagram).replace(/^@/, "") === handle || norm(r?.nickname) === `@${handle}`,
        )
  // A name is the weakest evidence there is: two "Dana Reyes" in one city is ordinary. So a name
  // match is refused when both records carry an identity on the same platform and they differ —
  // the profiles are the evidence then, not the name. (Before: a second person with a known name
  // was reported "already on the board" and silently never written.)
  const conflicts = (r: any) => {
    if (!handle) return false
    if (platformOf(l) === "linkedin") {
      const theirs = liSlug(r?.contact_info?.linkedin) || liSlug(r?.linkedin_url)
      return !!theirs && theirs !== handle
    }
    // A nickname is an identity only when it is an @handle — "Danny" is just a nickname.
    const nick = norm(r?.nickname)
    const theirs = norm(r?.contact_info?.instagram).replace(/^@/, "") || (nick.startsWith("@") ? nick.slice(1) : "")
    return !!theirs && theirs !== handle
  }
  return (
    byHandle ??
    onBoard.find((r) => l.email && norm(r?.email) === norm(l.email.v)) ??
    onBoard.find((r) => l.phone && digits(r?.phone) && digits(r?.phone) === digits(l.phone.v)) ??
    onBoard.find(
      (r) =>
        norm(r?.name) === norm(l.name.v) &&
        (!l.company || !r?.company || norm(r.company) === norm(l.company)) &&
        !conflicts(r),
    ) ??
    null
  )
}

// ── write ────────────────────────────────────────────────────────────────────

/** The POST /api/v1/leads body for a lead. */
export function leadPayload(l: Lead, bloqId: number): Record<string, any> {
  const payload: Record<string, any> = { name: l.name.v, bloqId, source: l.source ?? "reachr-scrape" }
  if (l.email) payload.email = l.email.v
  if (l.phone) payload.phone = l.phone.v
  if (l.company) payload.company = l.company
  if (l.handle && platformOf(l) === "linkedin") {
    // The Playwright runner's shape: contact_info.linkedin = the profile URL.
    payload.contact_info = { linkedin: `https://www.linkedin.com/in/${l.handle}/` }
  } else if (l.handle) {
    // The SOM leadgen runner's shape, so the two recognise each other.
    payload.nickname = `@${l.handle}`
    payload.contact_info = { instagram: l.handle, instagram_url: `https://www.instagram.com/${l.handle}/` }
  }
  return payload
}

/**
 * Did the create call make OUR record? The API upserts (#137529 — by email, and measured by phone
 * too): it can hand back an EXISTING record and drop what we sent. A record created before this run
 * started is not one we created, whatever its name.
 */
export function judgeCreated(lead: any, sentName: string, runStarted: number): { ours: boolean; why?: string } {
  const createdAt = Date.parse(lead?.created_at ?? "")
  const renamed = norm(lead?.name) !== norm(sentName)
  if (renamed) return { ours: false, why: `matched existing "${lead?.name}"` }
  if (Number.isFinite(createdAt) && createdAt < runStarted - 5000) return { ours: false, why: "the API returned an existing record" }
  return { ours: true }
}

export function provenanceNote(l: Lead, when: string): string {
  const fields = [
    l.title && `title: ${l.title.v} (${l.title.how})`,
    l.email && `email: ${l.email.v} (${l.email.how})`,
    l.phone && `phone: ${l.phone.v} (${l.phone.how})`,
    ...Object.entries(l.socials ?? {}).map(([k, v]) => `${k}: ${v}`),
    l.handle && platformOf(l) === "instagram" && `instagram handle: @${l.handle}`,
    l.extra?.headline && `headline: ${l.extra.headline}`,
    l.extra?.location && `location: ${l.extra.location}`,
    l.extra?.summary && `summary: ${String(l.extra.summary).slice(0, 300)}`,
    // 0 means "not fetched" (profiles mode skips stats), not "has no followers" — say nothing.
    Number(l.extra?.followers) > 0 && `followers: ${l.extra?.followers}`,
    l.extra?.context && `found as: ${l.extra.context}`,
    l.extra?.comment && `their comment: ${String(l.extra.comment).slice(0, 200)}`,
    l.extra?.bio && `bio: ${String(l.extra.bio).slice(0, 200)}`,
  ].filter(Boolean)
  return [
    `PUBLIC — not confirmed. Found by \`iris reachr scrape\` on ${when}.`,
    `Source: ${l.source_url}`,
    platformOf(l) === "instagram"
      ? `Found via: ${(l.evidence ?? []).join(", ")} — an Instagram account, which may be a brand rather than a person.`
      : platformOf(l) === "linkedin"
        ? `Found via: ${(l.evidence ?? []).join(", ")} — the headline is self-described and may be out of date.`
        : `Why it was believed to be a person: ${(l.evidence ?? ["structured data"]).join(", ")}.`,
    ...fields,
    `Verify before outreach (iris playbook run reachr-lead-hydrate).`,
  ].join("\n")
}

// ── inbound: replies into lead_comms ─────────────────────────────────────────

/** One reply's identity: its words, ignoring case and spacing. */
export const replyKey = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase()

// Previews shorter than this are exact-match only: a preview of "ok" must not claim every reply
// that starts with "ok". The legacy producers cut previews at 100 (Instagram) and 120 (LinkedIn).
const PREFIX_MIN = 40

/**
 * The reply texts a lead_comms row already holds. Three producers wrote replies before reachr:
 *   `[DM Reply] @h replied via Instagram DM:\n---\nthem: a\nthem: b\n---\nScanned: …`  (several)
 *   `[inbox reply] IG reply from @h: "preview…"`                                     (cut at 100)
 *   `[inbox reply] LinkedIn reply detected from Dana Reyes: "preview…"`              (cut at 120)
 * and a placeholder with no text at all (`… reply detected from @h in acct inbox`), which must hide
 * nothing. Anything else is a plain message body.
 */
export function knownReplies(body: unknown): { exact: string[]; prefixes: string[] } {
  const s = String(body ?? "")
  const dm = s.match(/^\s*\[dm reply\][^\n]*\n---\n([\s\S]*?)\n---/i)
  if (dm) {
    const lines = dm[1].split("\n").map((l) => replyKey(l.replace(/^[^:\n]{1,40}:\s/, ""))).filter(Boolean)
    return { exact: lines, prefixes: [] }
  }
  if (/^\s*\[(?:inbox reply|dm reply)\]/i.test(s)) {
    const q = s.match(/:\s*"([\s\S]*?)"?\s*$/)
    if (!q) return { exact: [], prefixes: [] } // a placeholder: says a reply happened, not what
    const k = replyKey(q[1])
    if (!k) return { exact: [], prefixes: [] }
    return { exact: [k], prefixes: k.length >= PREFIX_MIN ? [k] : [] }
  }
  const k = replyKey(s)
  return { exact: k ? [k] : [], prefixes: [] }
}

export interface ScannedReply {
  body: string
  timestamp: string | null
}
export interface PlannedReply {
  body: string
  sent_at?: string
}

/** Which scanned replies to write to a lead's thread, given the rows already on it. */
export function planReplyLog(replies: ScannedReply[], existingRows: { body?: unknown }[]): { toLog: PlannedReply[]; already: number } {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const row of existingRows) {
    const k = knownReplies(row?.body)
    k.exact.forEach((x) => exact.add(x))
    prefixes.push(...k.prefixes)
  }
  const toLog: PlannedReply[] = []
  let already = 0
  for (const m of replies) {
    const k = replyKey(m.body)
    if (!k) continue
    if (exact.has(k) || prefixes.some((p) => k.startsWith(p))) {
      already++
      continue
    }
    exact.add(k)
    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN
    toLog.push({ body: m.body, ...(Number.isFinite(ts) ? { sent_at: new Date(ts).toISOString() } : {}) })
  }
  return { toLog, already }
}

// ── runner ───────────────────────────────────────────────────────────────────

/**
 * Retry a spec run ONCE, for one failure only: no result file + the browser closed + it died fast.
 * Measured 2026-09-18: ~1 in 3 CLI runs died on the FIRST navigation that way, and the rerun passed.
 * Anything else is reported as it happened. A run that wrote its result may have written back.
 */
export function shouldRetrySpec(o: { resultFileExists: boolean; text: string; elapsedMs: number }): boolean {
  return !o.resultFileExists && /has been closed/.test(o.text) && o.elapsedMs < 120_000
}
