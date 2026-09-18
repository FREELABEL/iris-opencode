import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, resolveUserId, handleApiError, printDivider, printKV, dim, bold, success, writeJson } from "./iris-api"
import { inferMode, normalizeTarget, isMode, findFreelabelRoot, savedSessions, runInstagramScrape } from "./reachr-instagram"
import { resolveBrowserUseScript, runBrowserUseScript } from "./platform-browser"

// Every report line on STDOUT. UI.println writes to stderr while printKV/printDivider write to
// stdout, so mixing them scrambled the order whenever output was piped or saved — a person's
// details printed before their name.
const out = (...parts: string[]) => console.log(parts.join(""))

/**
 * `iris reachr scrape <bloq-id> <url...>` — find people on PUBLIC pages, then (only with --write)
 * put them on a board as leads.
 *
 * Reachr sequenced outreach to leads and had no way to GET them. This is the acquisition end.
 *
 * DRY RUN BY DEFAULT. A bad extraction written straight into the CRM pollutes it before anyone
 * looks; so the first run shows what was found and where, and `--write` is a second, deliberate
 * run.
 *
 * WHAT IT IS NOT. It reads public pages only — no login, no session — through the bridge's
 * scrape-leads.sh (throwaway Chrome, robots.txt obeyed, polite delay, same-site links). LinkedIn
 * and Instagram need a logged-in session and break those sites' terms; they are separate lanes
 * (the Hive LinkedIn / Instagram tools), not flags on this one.
 *
 * PUBLIC IS NOT CONFIRMED. Every lead it writes carries a note saying where it was found, how,
 * and that it is unverified — the lead-hydrate playbook's rule, applied at the moment of entry.
 *
 * THE UPSERT TRAP (#137529). POST /api/v1/leads upserts by email: an existing lead comes back
 * with its OLD values and what we sent is dropped. That is detected (returned name ≠ sent name)
 * and reported as "already on the board", and no note is attached to someone else's record.
 * Leads with no email have no such protection, so they are looked up by name on the board first.
 */

interface Field {
  v: string
  how: string
}
interface Lead {
  name: Field
  title?: Field | null
  email?: Field | null
  phone?: Field | null
  socials?: Record<string, string>
  company?: string
  company_how?: string
  evidence?: string[]
  source_url: string
  /** Instagram lane: the @handle (no @), the lead `source`, and what the scraper saw. */
  handle?: string
  source?: string
  extra?: Record<string, unknown>
}

function provenanceNote(l: Lead, when: string): string {
  const fields = [
    l.title && `title: ${l.title.v} (${l.title.how})`,
    l.email && `email: ${l.email.v} (${l.email.how})`,
    l.phone && `phone: ${l.phone.v} (${l.phone.how})`,
    ...Object.entries(l.socials ?? {}).map(([k, v]) => `${k}: ${v}`),
    l.handle && `instagram handle: @${l.handle}`,
    // 0 means "not fetched" (profiles mode skips stats), not "has no followers" — say nothing.
    Number(l.extra?.followers) > 0 && `followers: ${l.extra?.followers}`,
    l.extra?.context && `found as: ${l.extra.context}`,
    l.extra?.comment && `their comment: ${String(l.extra.comment).slice(0, 200)}`,
    l.extra?.bio && `bio: ${String(l.extra.bio).slice(0, 200)}`,
  ].filter(Boolean)
  return [
    `PUBLIC — not confirmed. Found by \`iris reachr scrape\` on ${when}.`,
    `Source: ${l.source_url}`,
    l.handle
      ? `Found via: ${(l.evidence ?? []).join(", ")} — an Instagram account, which may be a brand rather than a person.`
      : `Why it was believed to be a person: ${(l.evidence ?? ["structured data"]).join(", ")}.`,
    ...fields,
    `Verify before outreach (iris playbook run reachr-lead-hydrate).`,
  ].join("\n")
}

const rowsOf = (x: any): any[] => (Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : [])

/**
 * Everyone already on the board, loaded ONCE per run from the board's own list.
 *
 * Two earlier versions got this wrong, each measured on a second run against a real board:
 *  - `search + bloq_id` found nothing, ever: with a board filter and no status, the list omits
 *    "Prospected" — exactly what a scraped lead is.
 *  - the unfiltered `?search=` (what `iris leads search` uses) is served from an index that
 *    updates asynchronously, so leads created a minute earlier were not there yet; a no-contact
 *    lead was duplicated on every run.
 * The board list is read from the database, so it is current. Prospected has to be asked for by
 * name, so the default list and the Prospected list are both fetched and merged.
 */
async function boardLeads(bloqId: number): Promise<any[]> {
  const all = new Map<number, any>()
  for (const status of [undefined, "Prospected"]) {
    for (let page = 1; page <= 20; page++) {
      // `fresh_read`: fl-api caches this list in Redis for 30s per user and never invalidates it
      // on create/update/delete — and strips `_`/`timestamp` from the cache key, so the usual
      // cache-busters do nothing. Measured: a lead created a moment ago was absent from the list
      // for ~30s, so two runs 20s apart duplicated every no-contact person. Any OTHER unique
      // parameter changes the key. Remove once the controller invalidates on write (#185994).
      const q = new URLSearchParams({ bloq_id: String(bloqId), per_page: "200", page: String(page), fresh_read: String(Date.now()) })
      if (status) q.set("status", status)
      const res = await irisFetch(`/api/v1/leads?${q}`)
      if (!res.ok) throw new Error(`could not read board ${bloqId} to check for duplicates (HTTP ${res.status})`)
      const rows = rowsOf(((await res.json()) as any)?.data)
      for (const r of rows) if (r?.id != null) all.set(r.id, r)
      if (rows.length < 200) break
    }
  }
  return [...all.values()]
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase()
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10)

/** Same person? Email, then phone, then exact name (+ company when both have one). */
function findExisting(l: Lead, onBoard: any[]): any | null {
  // An Instagram handle is the strongest identity a scraped IG lead has — and the one earlier
  // SOM leadgen runs stored (contact_info.instagram, nickname "@handle"), so match it first.
  const handle = l.handle ? norm(l.handle).replace(/^@/, "") : ""
  const byHandle = handle
    ? onBoard.find(
        (r) => norm(r?.contact_info?.instagram).replace(/^@/, "") === handle || norm(r?.nickname) === `@${handle}`,
      )
    : null
  return (
    byHandle ??
    onBoard.find((r) => l.email && norm(r?.email) === norm(l.email.v)) ??
    onBoard.find((r) => l.phone && digits(r?.phone) && digits(r?.phone) === digits(l.phone.v)) ??
    onBoard.find((r) => norm(r?.name) === norm(l.name.v) && (!l.company || !r?.company || norm(r.company) === norm(l.company))) ??
    null
  )
}

export const ReachrScrapeCmd = cmd({
  command: "scrape <bloq-id> [urls..]",
  describe: "find people on public pages (team, about, directories) or Instagram (commenters, followers, profiles, your inbox) — dry run; --write adds them as leads",
  builder: (y: any) =>
    y
      .positional("bloq-id", { describe: "board the leads would land on", type: "number" })
      .positional("urls", { describe: "public page(s) to start from", type: "string", array: true })
      .option("follow", {
        describe: "comma-separated words; same-site links containing one are followed (default: team, about, staff, …)",
        type: "string",
      })
      .option("no-follow", { describe: "read only the pages given", type: "boolean", default: false })
      .option("max-pages", { describe: "pages to read in total (cap 50)", type: "number", default: 6 })
      .option("next", { describe: 'text of a directory\'s pagination control, e.g. "Next"', type: "string" })
      .option("delay", { describe: "seconds between page loads", type: "number", default: 1.5 })
      .option("write", { describe: "create the leads on the board (default: dry run)", type: "boolean", default: false })
      .option("limit", { describe: "write at most this many leads", type: "number" })
      .option("instagram", {
        describe: 'Instagram instead of web pages: a post URL (its commenters), @account (its followers), "@a,@b" (those profiles) or "inbox" (people who DM you)',
        type: "string",
      })
      .option("ig-mode", { describe: "comments | followers | profiles | inbox (default: inferred from --instagram)", type: "string" })
      .option("ig-account", { describe: "the Instagram account whose saved session does the browsing", type: "string" })
      .option("max-profiles", { describe: "Instagram: profiles to collect", type: "number", default: 30 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const bloqId = Number(args["bloq-id"])
    const urls: string[] = (args.urls ?? []).map(String)
    const isJson = Boolean(args.json)

    if (args.write && !(await requireAuth())) {
      process.exitCode = 1
      return
    }

    const spinner = isJson ? null : prompts.spinner()
    let data: any = null
    const fail = (msg: string) => {
      spinner?.stop("Nothing read", 1)
      if (isJson) writeJson({ ok: false, measured: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = 2
    }

    if (args.instagram) {
      if (urls.length) return fail("give either page URLs or --instagram, not both")
      const mode = args["ig-mode"] ?? inferMode(String(args.instagram))
      if (!isMode(mode)) return fail(`--ig-mode must be comments, followers, profiles or inbox — got "${mode}"`)
      const root = findFreelabelRoot()
      if (!root)
        return fail(
          "The Instagram scraper lives in the Freelabel checkout (tests/e2e/leadgen-scraper.spec.ts) and this machine has none. " +
            "Run this where the checkout is, or set FREELABEL_PATH.",
        )
      const sessions = savedSessions(root)
      const account = args["ig-account"] ?? (sessions.length === 1 ? sessions[0] : null)
      if (!account)
        return fail(
          sessions.length
            ? `Choose whose Instagram session browses with --ig-account: ${sessions.join(", ")}`
            : "No saved Instagram session. Save one: IG_ACCOUNT=<account> npx playwright test tests/e2e/save-instagram-session.spec.ts --headed",
        )
      if (!sessions.includes(account))
        return fail(`No saved session for @${account}. Saved: ${sessions.join(", ") || "none"}.`)
      const token = await requireAuth()
      const userId = await resolveUserId()
      if (!token || !userId) return fail("Not signed in — run `iris login`. The scraper reads the board to skip people already on it.")
      const target = normalizeTarget(String(args.instagram), mode)
      spinner?.start(`Instagram ${mode} as @${account} — a browser window will open; nothing is written…`)
      const r = await runInstagramScrape({ root, account, mode, target, max: Number(args["max-profiles"]), bloqId, token, userId })
      if (r.error) return fail(r.error)
      data = r.data
    } else {
      if (!urls.length) return fail("give one or more page URLs, or --instagram <post|@account|@a,@b|inbox>")
      const script = resolveBrowserUseScript("scrape-leads.sh")
      if (!script) {
        const msg =
          "scrape-leads.sh not found. It ships with the IRIS bridge — install or update it, or point " +
          "IRIS_BROWSER_USE_DIR at a checkout. `iris browser doctor` checks every piece."
        if (isJson) writeJson({ ok: false, measured: false, error: msg })
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }

      const argv = [...urls, "--max-pages", String(args["max-pages"]), "--delay", String(args.delay)]
      if (args["no-follow"] || args.follow === false) argv.push("--no-follow")
      else if (typeof args.follow === "string" && args.follow) argv.push("--follow", args.follow)
      if (args.next) argv.push("--next", args.next)

      spinner?.start(`Reading ${urls.length} page(s) — robots.txt obeyed, ${args.delay}s between pages…`)
      const { stdout, stderr, code } = await runBrowserUseScript(script, argv)
      const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop()
      try {
        data = line ? JSON.parse(line) : null
      } catch {
        data = null
      }
      if (!data) {
        spinner?.stop("Could not read the pages", 1)
        const why = stderr.trim().split("\n").slice(-2).join(" ").slice(-300) || `exit ${code}`
        if (isJson) writeJson({ ok: false, measured: false, error: why })
        else prompts.log.error(why)
        process.exitCode = 2
        return
      }
    }

    if (data.measured === false) {
      spinner?.stop("Could not read any page", 1)
      if (isJson) writeJson(data)
      else {
        prompts.log.error(`could not read any page: ${data.error ?? "no reason given"}`)
        for (const s of data.skipped ?? []) out(dim(`  skipped ${s.url} — ${s.reason}`))
      }
      process.exitCode = 2
      return
    }

    const leads: Lead[] = data.leads ?? []
    spinner?.stop(
      data.instagram
        ? `Instagram ${data.instagram.mode}: ${leads.length} new profile(s) — scraped ${data.instagram.scraped ?? "?"}, skipped ${data.instagram.existing_skipped ?? 0} already on board ${bloqId}`
        : `Read ${data.counts?.pages ?? "?"} page(s): ${leads.length} people, ${data.contacts?.length ?? 0} company contact(s)`,
    )

    if (!args.write) {
      if (isJson) {
        writeJson({ ...data, dry_run: true, bloq_id: bloqId })
        process.exitCode = leads.length ? 0 : 1
        return
      }
      printDivider()
      for (const l of leads) {
        const marks = [l.email && "email", l.phone && "phone", Object.keys(l.socials ?? {}).length && "social"]
          .filter(Boolean)
          .join(" ")
        out(`  ${bold(l.name.v)}${l.handle && l.name.v !== `@${l.handle}` ? dim(` @${l.handle}`) : ""}${l.title ? dim(` — ${l.title.v}`) : ""}`)
        out(dim(`      ${[l.company, marks || "no contact", `evidence: ${(l.evidence ?? ["json-ld"]).join(", ")}`].filter(Boolean).join("  ·  ")}`))
      }
      if (data.contacts?.length) {
        printDivider()
        out(dim("  Company contacts (no person attached — not written as leads):"))
        for (const c of data.contacts) out(dim(`    ${c.kind} ${c.value}${c.context ? `  (${c.context})` : ""}`))
      }
      for (const s of data.skipped ?? []) out(dim(`  skipped ${s.url} — ${s.reason}`))
      printDivider()
      prompts.outro(
        leads.length
          ? `Dry run — nothing written. ${dim(`Add --write to create ${leads.length} lead(s) on board ${bloqId}.`)}`
          : "Dry run — read the pages and found no people.",
      )
      process.exitCode = leads.length ? 0 : 1
      return
    }

    // ── --write ──
    const when = new Date().toISOString().slice(0, 10)
    const toWrite = args.limit ? leads.slice(0, Number(args.limit)) : leads
    const outcome = { created: [] as any[], existing: [] as any[], failed: [] as any[] }

    const runStarted = Date.now()
    let onBoard: any[]
    try {
      onBoard = await boardLeads(bloqId)
    } catch (e: any) {
      // Refuse rather than write blind: without the board's current leads, every no-contact
      // person would be written again.
      if (isJson) writeJson({ ...data, dry_run: false, bloq_id: bloqId, error: e.message })
      else prompts.log.error(`${e.message} — nothing written.`)
      process.exitCode = 1
      return
    }
    for (const l of toWrite) {
      const name = l.name.v
      try {
        const hit = findExisting(l, onBoard)
        if (hit) {
          outcome.existing.push({ name, id: hit.id, why: `already on board ${bloqId}${norm(hit.name) !== norm(name) ? ` as "${hit.name}"` : ""}` })
          continue
        }
        const payload: Record<string, unknown> = { name, bloqId, source: l.source ?? "reachr-scrape" }
        if (l.email) payload.email = l.email.v
        if (l.phone) payload.phone = l.phone.v
        if (l.company) payload.company = l.company
        // Instagram leads in the shape the SOM leadgen runner has always stored them, so the two
        // recognise each other: nickname "@handle", contact_info.instagram / instagram_url.
        if (l.handle) {
          payload.nickname = `@${l.handle}`
          payload.contact_info = { instagram: l.handle, instagram_url: `https://www.instagram.com/${l.handle}/` }
        }
        const res = await irisFetch("/api/v1/leads", { method: "POST", body: JSON.stringify(payload) })
        if (!(await handleApiError(res, `Create ${name}`))) {
          outcome.failed.push({ name, why: `HTTP ${res.status}` })
          continue
        }
        const body = (await res.json()) as any
        const lead = body?.data ?? body
        // Second guard, for whatever the search missed. The API upserts (#137529 — by email, and
        // measured here by phone too): it hands back an EXISTING record and drops what we sent. A
        // record created before this run started is not one we created, whatever its name.
        const createdAt = Date.parse(lead?.created_at ?? "")
        const renamed = String(lead?.name ?? "").trim().toLowerCase() !== name.trim().toLowerCase()
        if (renamed || (Number.isFinite(createdAt) && createdAt < runStarted - 5000)) {
          outcome.existing.push({ name, id: lead?.id, why: renamed ? `matched existing "${lead?.name}"` : "the API returned an existing record" })
          continue
        }
        const note = await irisFetch(`/api/v1/leads/${lead.id}/notes`, {
          method: "POST",
          body: JSON.stringify({ message: provenanceNote(l, when) }),
        })
        outcome.created.push({ name, id: lead.id, note_attached: note.ok })
        onBoard.push(lead)
      } catch (e: any) {
        outcome.failed.push({ name, why: e?.message ?? String(e) })
      }
    }

    if (isJson) {
      writeJson({ ...data, dry_run: false, bloq_id: bloqId, outcome })
    } else {
      printDivider()
      printKV("created", outcome.created.length)
      printKV("already on the board", outcome.existing.length)
      printKV("failed", outcome.failed.length)
      printDivider()
      for (const c of outcome.created) out(`  ${success("+")} ${c.name} ${dim(`#${c.id}${c.note_attached ? "" : " (provenance note NOT attached)"}`)}`)
      for (const x of outcome.existing) out(dim(`  = ${x.name} — ${x.why}${x.id ? ` (#${x.id})` : ""}`))
      for (const f of outcome.failed) out(`  ✗ ${f.name} — ${f.why}`)
      prompts.outro(dim("Each new lead carries a PUBLIC — not confirmed note with its source. Verify before outreach."))
    }
    // A write where anything failed is not a success, even if most rows landed.
    process.exitCode = outcome.failed.length ? 1 : 0
  },
})
