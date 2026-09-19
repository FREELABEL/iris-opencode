import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, resolveUserId, handleApiError, printDivider, printKV, dim, bold, success, writeJson } from "./iris-api"
import { inferMode, normalizeTarget, isMode, findFreelabelRoot, savedSessions, runInstagramScrape } from "./reachr-instagram"
import { runLinkedInScrape, liSessionFile, LI_MAX_PROFILES } from "./reachr-linkedin"
import { type Lead, platformOf, findExisting, provenanceNote, leadPayload, judgeCreated } from "./reachr-core"
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
 * scrape-leads.sh (throwaway Chrome, robots.txt obeyed, polite delay, same-site links).
 * --instagram and --linkedin are different: they browse AS YOU, through a saved session, via the
 * existing Playwright scrapers (reachr-instagram.ts / reachr-linkedin.ts). Always dry there too.
 *
 * PUBLIC IS NOT CONFIRMED. Every lead it writes carries a note saying where it was found, how,
 * and that it is unverified — the lead-hydrate playbook's rule, applied at the moment of entry.
 *
 * THE UPSERT TRAP (#137529). POST /api/v1/leads upserts by email: an existing lead comes back
 * with its OLD values and what we sent is dropped. That is detected (returned name ≠ sent name)
 * and reported as "already on the board", and no note is attached to someone else's record.
 * Leads with no email have no such protection, so they are looked up by name on the board first.
 */

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

export const ReachrScrapeCmd = cmd({
  command: "scrape <bloq-id> [urls..]",
  describe: "find people on public pages (team, about, directories), Instagram (commenters, followers, profiles, your inbox) or LinkedIn (people search, your inbox) — dry run; --write adds them as leads",
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
      .option("linkedin", {
        describe: 'LinkedIn instead: a people-search query ("founder fintech") or "inbox" (people in your LinkedIn messages)',
        type: "string",
      })
      .option("li-location", { describe: "LinkedIn search: add a location to the query", type: "string" })
      .option("max-profiles", { describe: `Instagram / LinkedIn: profiles to collect (LinkedIn cap ${LI_MAX_PROFILES})`, type: "number", default: 30 })
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

    if (args.instagram && args.linkedin) return fail("give --instagram or --linkedin, not both")
    if (args.linkedin) {
      if (urls.length) return fail("give either page URLs or --linkedin, not both")
      const q = String(args.linkedin).trim()
      const mode = q.toLowerCase() === "inbox" ? "inbox" : "search"
      const max = Number(args["max-profiles"])
      if (!(max > 0) || max > LI_MAX_PROFILES)
        return fail(`--max-profiles must be 1–${LI_MAX_PROFILES} for LinkedIn — it browses as you, and LinkedIn restricts accounts that pull too many profiles`)
      const root = findFreelabelRoot()
      if (!root)
        return fail(
          "The LinkedIn scraper lives in the Freelabel checkout (tests/e2e/linkedin-scraper.spec.ts) and this machine has none. " +
            "Run this where the checkout is, or set FREELABEL_PATH.",
        )
      if (!liSessionFile(root))
        return fail(
          "No usable LinkedIn session (tests/e2e/linkedin-auth.json missing, or its login cookie expired). Save one: " +
            "npx playwright test tests/e2e/save-linkedin-session.spec.ts --headed --timeout 300000",
        )
      const token = await requireAuth()
      const userId = await resolveUserId()
      if (!token || !userId) return fail("Not signed in — run `iris login`.")
      spinner?.start(`LinkedIn ${mode === "inbox" ? "inbox" : `search "${q}"`} — a browser window will open; nothing is written…`)
      const r = await runLinkedInScrape({
        root,
        mode,
        query: mode === "search" ? q : "",
        location: String(args["li-location"] ?? ""),
        max,
        bloqId,
        token,
        userId,
      })
      if (r.error) return fail(r.error)
      data = r.data
    } else if (args.instagram) {
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
      if (!urls.length) return fail('give one or more page URLs, --instagram <post|@account|@a,@b|inbox>, or --linkedin "<query>"|inbox')
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
        : data.linkedin
          ? `LinkedIn ${data.linkedin.mode}: ${leads.length} profile(s) — scraped ${data.linkedin.scraped ?? "?"}`
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
        out(`  ${bold(l.name.v)}${l.handle && platformOf(l) === "instagram" && l.name.v !== `@${l.handle}` ? dim(` @${l.handle}`) : ""}${l.title ? dim(` — ${l.title.v}`) : ""}`)
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
        const payload = leadPayload(l, bloqId)
        const res = await irisFetch("/api/v1/leads", { method: "POST", body: JSON.stringify(payload) })
        if (!(await handleApiError(res, `Create ${name}`))) {
          outcome.failed.push({ name, why: `HTTP ${res.status}` })
          continue
        }
        const body = (await res.json()) as any
        const lead = body?.data ?? body
        // Second guard, for whatever the search missed: the API upserts (#137529) and can hand back
        // an existing record. See judgeCreated.
        const judged = judgeCreated(lead, name, runStarted)
        if (!judged.ours) {
          outcome.existing.push({ name, id: lead?.id, why: judged.why })
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
