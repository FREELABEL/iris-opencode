import { cmd } from "./cmd"
import { ScenarioCommand } from "./mint-scenario-cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, writeJson, IRIS_API } from "./iris-api"
import fs from "fs"
import path from "path"
import { executeIntegrationCall } from "./platform-run"
import { bridgeFetch } from "./iris-api"
import { mailRows } from "./mail-response"
import {
  reconcile,
  AMT_COLS,
  DATE_COLS,
  DEFAULT_SENDERS,
  DESC_COLS,
  centsOf,
  fingerprint,
  normalizeDate,
  parseAmountDollars,
  parseCsv,
  periodWindow,
  pickCol,
  sparkline,
  today,
  verifyAgainstSource,
  ymd,
} from "./mint-core"

// ============================================================================
// IRIS Mint — budget-vs-actual over the Atlas ledger.
//
// The ledger already stores transactions and the `budgets` dataset already
// stores caps. Nothing compared them. That comparison is this file.
//
// Routes: /api/v1/atlas/transactions · /api/v1/atlas/accounts
//         /api/v1/atlas/datasets/budgets
//
// SCOPE lives in `metadata.scope` (personal | business | client:<slug>) rather
// than its own column. The value of scope is that every row carries it from the
// first day; which column it sits in is a backfill, not a rewrite. A real column
// can come later — untagged rows cannot be fixed later.
// ============================================================================

const DEFAULT_SCOPE = "personal"

function fmtCents(c?: number | null): string {
  if (c == null) return dim("—")
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function printDivider() {
  console.log(dim("  " + "─".repeat(72)))
}

/**
 * Local calendar date, NOT toISOString(). Anywhere west of UTC, an evening
 * purchase would otherwise file under tomorrow — and a Saturday-night one would
 * land in NEXT week's budget window, which is the whole thing being measured.
 */
async function fetchAccounts(): Promise<any[]> {
  const res = await irisFetch(`/api/v1/atlas/accounts?`)
  if (!res.ok) return []
  return ((await res.json()) as any)?.data ?? []
}

/** Resolve a free-text category to a chart-of-accounts id. Exact, then prefix. */
function resolveAccountId(accounts: any[], category?: string): number | undefined {
  if (!category) return undefined
  const want = category.trim().toLowerCase()
  const exact = accounts.find((a) => String(a.name ?? "").toLowerCase() === want)
  if (exact) return exact.id
  const partial = accounts.find((a) =>
    String(a.name ?? "")
      .toLowerCase()
      .startsWith(want),
  )
  return partial?.id
}

async function fetchBudgets(scope?: string): Promise<any[]> {
  const p = new URLSearchParams({ per_page: "200" })
  const res = await irisFetch(`/api/v1/atlas/datasets/budgets?${p}`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
  return records
    .map((r) => ({ id: r.id, external_id: r.external_id, ...(r.data ?? {}) }))
    .filter((b) => (scope ? b.scope === scope : true))
}

/** Sum expense cents in a window for one category+scope. */
async function actualCents(category: string, scope: string, from: string, to: string): Promise<number> {
  const p = new URLSearchParams({ per_page: "500", type: "expense", from, to })
  if (category) p.set("category", category)
  const res = await irisFetch(`/api/v1/atlas/transactions?${p}`)
  if (!res.ok) return 0
  const body = (await res.json()) as any
  const rows: any[] = body?.data?.data ?? body?.data ?? []
  // Scope is not a server-side filter yet (it lives in metadata), so filter here.
  // STRICT: an untagged row belongs to no scope and is counted against none.
  // Defaulting untagged to "personal" would have silently pulled every legacy
  // business transaction into the personal budget the moment a category matched.
  return rows.filter((tx) => tx?.metadata?.scope === scope).reduce((sum, tx) => sum + (Number(tx.amount_cents) || 0), 0)
}

/** Transactions carrying no scope at all — invisible to every scoped total. */
async function fetchUntagged(): Promise<any[]> {
  const res = await irisFetch(`/api/v1/atlas/transactions?per_page=500`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const rows: any[] = body?.data?.data ?? body?.data ?? []
  return rows.filter((tx) => !tx?.metadata?.scope)
}

function bar(pct: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return "█".repeat(filled) + dim("░".repeat(width - filled))
}

// ── spend ────────────────────────────────────────────────────────────────────

const SpendCommand = cmd({
  command: "spend <amount> [description..]",
  aliases: ["s", "add"],
  describe: "log an expense in one line — `iris mint spend 6.40 coffee -c dining`",
  builder: (y) =>
    y
      .positional("amount", { type: "number", describe: "amount in dollars" })
      .positional("description", { type: "string", array: true, describe: "what it was" })
      .option("category", { alias: "c", type: "string", describe: "budget category (also resolves the account)" })
      .option("scope", {
        alias: "s",
        type: "string",
        default: DEFAULT_SCOPE,
        describe: "personal | business | client:<slug>",
      })
      .option("date", { alias: "d", type: "string", describe: "YYYY-MM-DD (default: today)" })
      .option("account-id", { type: "number", describe: "override the resolved chart-of-accounts id" })
      .option("source", { type: "string", default: "manual", describe: "manual|import|qb|stripe|invoice" })
      .option("revenue", { type: "boolean", default: false, describe: "log as revenue instead of an expense" })
      .option("bloq", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const amount = Number(args.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      prompts.log.error(`Amount must be a positive number — got "${args.amount}"`)
      prompts.outro("Done")
      return
    }
    const description = (args.description ?? []).join(" ").trim()
    if (!description) {
      prompts.log.error("Needs a description: iris mint spend 6.40 coffee")
      prompts.outro("Done")
      return
    }

    const date = args.date ?? today()
    const category = args.category?.trim().toLowerCase()

    let accountId = args["account-id"]
    if (accountId == null && category) accountId = resolveAccountId(await fetchAccounts(), category)

    const body: Record<string, any> = {
      type: args.revenue ? "revenue" : "expense",
      description,
      amount_cents: Math.round(amount * 100),
      transaction_date: date,
      source: args.source ?? "manual",
      metadata: { scope: args.scope },
    }
    if (category) body.category = category
    if (accountId != null) body.account_id = accountId
    if (args.bloq != null) body.bloq_id = args.bloq

    const res = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
    if (!res.ok) {
      await audit({
        action: "create",
        entity: "transaction",
        scope: String(args.scope),
        after: description,
        amount,
        ok: false,
        reason: `HTTP ${res.status}`,
      })
    }
    const ok = await handleApiError(res, "Log spend")
    if (!ok) {
      prompts.outro("Done")
      return
    }
    const tx = ((await res.json()) as any)?.data
    await audit({
      action: "create",
      entity: "transaction",
      entity_id: tx?.id,
      scope: String(args.scope),
      field: category ? `category=${category}` : undefined,
      after: description,
      amount,
      ok: true,
    })

    if (args.json) {
      await writeJson(tx)
      prompts.outro("Done")
      return
    }

    const sign = args.revenue ? "+" : "-"
    console.log(`  ${sign}${fmtCents(body.amount_cents)}  ${bold(description)}`)
    const meta = [args.scope, category ?? dim("uncategorized"), date]
    if (accountId != null) meta.push(`acct #${accountId}`)
    else if (category) meta.push(dim("no matching account"))
    console.log("  " + dim(meta.join("  ·  ")))

    // Immediate feedback against the budget this just hit — the whole point of
    // capture is seeing the number move, not filing a row.
    if (category) {
      const budgets = (await fetchBudgets(args.scope)).filter((b) => b.category === category && b.active)
      for (const b of budgets) {
        const [from, to] = periodWindow(b.period)
        const spent = await actualCents(category, args.scope, from, to)
        const capCents = Math.round(Number(b.cap ?? 0) * 100)
        if (capCents <= 0) continue
        const pct = (spent / capCents) * 100
        const left = capCents - spent
        const warn = pct >= 100 ? " ⚠ OVER" : pct >= 80 ? " ⚠" : ""
        console.log(
          `  ${dim(b.period.padEnd(8))} ${bar(pct)} ${fmtCents(spent)} / ${fmtCents(capCents)}  ${dim(`${fmtCents(left)} left`)}${warn}`,
        )
      }
    }
    prompts.outro("Done")
  },
})

// ── budgets ──────────────────────────────────────────────────────────────────

const BudgetsCommand = cmd({
  command: "budgets",
  aliases: ["b"],
  describe: "list budget caps",
  builder: (y) =>
    y
      .option("scope", { alias: "s", type: "string", describe: "filter by scope" })
      .option("all", { type: "boolean", default: false, describe: "include inactive budgets" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Budgets")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    let budgets = await fetchBudgets(args.scope)
    if (!args.all) budgets = budgets.filter((b) => b.active)
    if (args.json) {
      await writeJson(budgets)
      prompts.outro("Done")
      return
    }
    if (budgets.length === 0) {
      prompts.log.warn("No budgets. Add one with: iris atlas:datasets records upsert -s budgets")
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const b of budgets) {
      const cap = Math.round(Number(b.cap ?? 0) * 100)
      const floor = Math.round(Number(b.floor ?? 0) * 100)
      const range = floor > 0 ? `${fmtCents(floor)}–${fmtCents(cap)}` : fmtCents(cap)
      const flag = b.active ? "" : dim("  (inactive)")
      console.log(`  ${bold(b.name ?? b.external_id)}  ${dim(`${b.scope} · ${b.period}`)}  ${range}${flag}`)
      if (cap <= 0) console.log("    " + dim("no cap set — this budget cannot produce a variance"))
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ── status (variance) ────────────────────────────────────────────────────────

const StatusCommand = cmd({
  command: "status",
  aliases: ["variance", "v"],
  describe: "budget vs actual vs remaining — the only screen that matters",
  builder: (y) =>
    y
      .option("scope", {
        alias: "s",
        type: "string",
        default: DEFAULT_SCOPE,
        describe: "personal | business | client:<slug>",
      })
      .option("period", { alias: "p", type: "string", describe: "only weekly | monthly | yearly" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Status")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")
    // Shares computePosition with `snapshot` — if these drifted, the trend would
    // disagree with the screen it is supposed to be a history of.
    const rows = await computePosition(String(args.scope), args.period)
    if (rows.length === 0) {
      spinner.stop("Nothing to compare", 1)
      prompts.log.warn(`No active budgets for scope "${args.scope}"`)
      prompts.outro("Done")
      return
    }

    const untagged = await fetchUntagged()
    spinner.stop(`${rows.length} budget(s)`)

    if (args.json) {
      await writeJson(rows)
      prompts.outro("Done")
      return
    }

    if (untagged.length > 0) {
      prompts.log.warn(
        `${untagged.length} transaction(s) carry no scope and are counted against nothing — fix with: iris mint scope business --untagged`,
      )
    }

    printDivider()
    for (const r of rows) {
      console.log(`  ${bold(r.name)}  ${dim(`${r.from} → ${r.to}`)}`)
      if (r.cap_cents <= 0) {
        console.log("    " + dim("no cap set — cannot compare") + `  (spent ${fmtCents(r.spent_cents)})`)
        continue
      }
      const warn = r.pct >= 100 ? " ⚠ OVER" : r.pct >= 80 ? " ⚠" : ""
      console.log(
        `    ${bar(r.pct)} ${String(Math.round(r.pct)).padStart(3)}%  ${fmtCents(r.spent_cents)} / ${fmtCents(r.cap_cents)}  ${dim(`${fmtCents(r.remaining_cents)} left`)}${warn}`,
      )
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ── scope ────────────────────────────────────────────────────────────────────

const ScopeCommand = cmd({
  command: "scope <scope>",
  describe: "tag transactions with a scope — `iris mint scope business --untagged`",
  builder: (y) =>
    y
      .positional("scope", { type: "string", describe: "personal | business | client:<slug>" })
      .option("tx", { type: "number", array: true, describe: "transaction id(s) to tag" })
      .option("untagged", { type: "boolean", default: false, describe: "tag every transaction that has no scope yet" })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would change, write nothing" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Scope")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    let targets: any[] = []
    if (args.untagged) targets = await fetchUntagged()
    else if (args.tx?.length) {
      for (const id of args.tx) {
        const res = await irisFetch(`/api/v1/atlas/transactions/${id}`)
        if (res.ok) targets.push(((await res.json()) as any)?.data)
      }
    } else {
      prompts.log.error("Pass --tx <id> or --untagged")
      prompts.outro("Done")
      return
    }
    targets = targets.filter(Boolean)
    if (targets.length === 0) {
      prompts.log.warn("Nothing to tag")
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const tx of targets) {
      console.log(
        `  ${dim(`#${tx.id}`)}  ${dim(String(tx.transaction_date ?? "").slice(0, 10))}  ${fmtCents(tx.amount_cents)}  ${bold(tx.description ?? "")}`,
      )
    }
    printDivider()

    if (args["dry-run"]) {
      prompts.log.info(`Dry run — ${targets.length} transaction(s) would be tagged scope=${args.scope}`)
      prompts.outro("Done")
      return
    }

    let ok = 0
    for (const tx of targets) {
      const before = tx?.metadata?.scope ?? null
      const metadata = { ...(tx.metadata ?? {}), scope: args.scope }
      const res = await irisFetch(`/api/v1/atlas/transactions/${tx.id}`, {
        method: "PATCH",
        body: JSON.stringify({ metadata }),
      })
      if (res.ok) ok++
      else prompts.log.warn(`#${tx.id} failed (${res.status})`)
      // Logged either way — "someone tried to re-scope this and it failed" is a
      // fact the books need as much as a successful change.
      await audit({
        action: "backfill",
        entity: "transaction",
        entity_id: tx.id,
        scope: String(args.scope),
        field: "metadata.scope",
        before: before ?? "(untagged)",
        after: String(args.scope),
        amount: (Number(tx.amount_cents) || 0) / 100,
        ok: res.ok,
        reason: res.ok ? undefined : `HTTP ${res.status}`,
      })
    }
    prompts.log.success(`Tagged ${ok}/${targets.length} as scope=${args.scope}`)
    prompts.outro("Done")
  },
})

// ── statement / CSV import ───────────────────────────────────────────────────

/** RFC4180-ish CSV. Handles quoted fields containing commas and escaped quotes. */
async function existingFingerprints(from: string, to: string): Promise<Set<string>> {
  const out = new Set<string>()
  const res = await irisFetch(`/api/v1/atlas/transactions?per_page=500&from=${from}&to=${to}`)
  if (!res.ok) return out
  const body = (await res.json()) as any
  const rows: any[] = body?.data?.data ?? body?.data ?? []
  for (const tx of rows) {
    if (tx?.metadata?.fp) out.add(String(tx.metadata.fp))
    else {
      // Rows imported before fingerprinting, or added by hand, still dedup by value.
      const d = String(tx.transaction_date ?? "").slice(0, 10)
      out.add(fingerprint(d, Number(tx.amount_cents) || 0, String(tx.description ?? "")))
    }
  }
  return out
}

/** The single rounding point: dollars → cents, once, on the row being written. */
const ImportCommand = cmd({
  command: "import <file>",
  aliases: ["ingest"],
  describe: "ingest a bank/card/usage CSV — idempotent, re-running changes nothing",
  builder: (y) =>
    y
      .positional("file", { type: "string", describe: "path to a .csv export" })
      .option("scope", { alias: "s", type: "string", default: DEFAULT_SCOPE })
      .option("category", { alias: "c", type: "string", describe: "category for every row" })
      .option("account-id", { type: "number" })
      .option("date-col", { type: "string", describe: "override the date column header" })
      .option("amount-col", { type: "string", describe: "override the amount column header" })
      .option("desc-col", { type: "string", describe: "override the description column header" })
      .option("group-by", {
        type: "string",
        default: "none",
        describe: "none | day | month — roll many small rows into one",
      })
      .option("label", { type: "string", describe: "description prefix when grouping (default: file name)" })
      .option("invert", {
        type: "boolean",
        default: false,
        describe: "flip the sign (some exports list spend as positive)",
      })
      .option("min-amount", { type: "number", default: 0.01, describe: "skip rows below this absolute amount" })
      .option("revenue", { type: "boolean", default: false, describe: "import as revenue instead of expense" })
      .option("dry-run", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Import")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const file = String(args.file)
    if (!fs.existsSync(file)) {
      prompts.log.error(`No such file: ${file}`)
      prompts.outro("Done")
      return
    }
    if (!file.toLowerCase().endsWith(".csv")) {
      prompts.log.error("Only CSV is supported. Export CSV from the bank — PDF statements are not parsed.")
      prompts.outro("Done")
      return
    }

    const grid = parseCsv(fs.readFileSync(file, "utf8"))
    if (grid.length < 2) {
      prompts.log.error("File has no data rows")
      prompts.outro("Done")
      return
    }
    const headers = grid[0]
    const di = pickCol(headers, DATE_COLS, args["date-col"])
    const ai = pickCol(headers, AMT_COLS, args["amount-col"])
    const si = pickCol(headers, DESC_COLS, args["desc-col"])
    if (di < 0 || ai < 0) {
      prompts.log.error(`Could not find a date and amount column. Headers: ${headers.join(", ")}`)
      prompts.log.info("Point at them with --date-col and --amount-col")
      prompts.outro("Done")
      return
    }
    console.log("  " + dim(`date=${headers[di]}  amount=${headers[ai]}  desc=${si >= 0 ? headers[si] : "(none)"}`))

    // Parse rows
    const minAmount = Number(args["min-amount"])
    let skippedSmall = 0,
      skippedBad = 0
    type Row = { date: string; amount: number; desc: string }
    const parsed: Row[] = []
    for (const r of grid.slice(1)) {
      const date = normalizeDate(r[di] ?? "")
      let amount = parseAmountDollars(r[ai] ?? "")
      if (!date || amount == null) {
        skippedBad++
        continue
      }
      if (args.invert) amount = -amount
      amount = Math.abs(amount)
      parsed.push({ date, amount, desc: (si >= 0 ? r[si] : "") || path.basename(file) })
    }
    if (parsed.length === 0) {
      prompts.log.warn(`Nothing to import (${skippedBad} unparseable)`)
      prompts.outro("Done")
      return
    }

    // Optional rollup — a usage export is hundreds of micro-charges; one row per
    // day is a ledger entry, 270 rows of $0.004 is noise.
    const groupBy = String(args["group-by"])
    const label = args.label ?? path.basename(file).replace(/\.csv$/i, "")
    let items: Row[] = parsed
    if (groupBy === "day" || groupBy === "month") {
      const buckets = new Map<string, { amount: number; n: number }>()
      for (const p of parsed) {
        const k = groupBy === "day" ? p.date : p.date.slice(0, 7)
        const b = buckets.get(k) ?? { amount: 0, n: 0 }
        b.amount += p.amount
        b.n++
        buckets.set(k, b)
      }
      items = [...buckets.entries()].sort().map(([k, b]) => ({
        date: groupBy === "day" ? k : `${k}-01`,
        amount: b.amount,
        desc: `${label} — ${k} (${b.n} line item${b.n === 1 ? "" : "s"})`,
      }))
    }

    // min-amount applies AFTER any rollup. Filtering first would silently drop
    // hundreds of sub-cent rows that sum to real money inside their bucket.
    const before = items.length
    items = items.filter((i) => i.amount >= minAmount)
    skippedSmall = before - items.length
    if (items.length === 0) {
      prompts.log.warn(`Nothing to import — every row was below --min-amount`)
      prompts.outro("Done")
      return
    }

    const dates = items.map((i) => i.date).sort()
    const seen = await existingFingerprints(dates[0], dates[dates.length - 1])
    const fresh = items.filter((i) => !seen.has(fingerprint(i.date, centsOf(i), i.desc)))
    const dupes = items.length - fresh.length
    const total = fresh.reduce((s, i) => s + centsOf(i), 0)

    printDivider()
    for (const i of fresh.slice(0, 20)) console.log(`  ${dim(i.date)}  ${fmtCents(centsOf(i)).padEnd(12)}  ${i.desc}`)
    if (fresh.length > 20) console.log("  " + dim(`… ${fresh.length - 20} more`))
    printDivider()
    console.log(
      `  ${bold(String(fresh.length))} new  ·  ${dim(`${dupes} already imported`)}  ·  ${bold(fmtCents(total))}`,
    )
    if (skippedSmall || skippedBad)
      console.log("  " + dim(`skipped: ${skippedSmall} under min-amount, ${skippedBad} unparseable`))

    if (args["dry-run"]) {
      prompts.log.info("Dry run — nothing written")
      prompts.outro("Done")
      return
    }
    if (fresh.length === 0) {
      await recordRun({
        kind: "import",
        scope: String(args.scope),
        rail: "csv",
        ok: true,
        failures: 0,
        candidates: items.length,
        written: 0,
        duplicates: dupes,
        notes: `${path.basename(file)} — already up to date`,
      })
      prompts.log.success("Already up to date — nothing to import")
      prompts.outro("Done")
      return
    }

    let ok = 0
    for (const i of fresh) {
      const body: Record<string, any> = {
        type: args.revenue ? "revenue" : "expense",
        description: i.desc.slice(0, 500),
        amount_cents: centsOf(i),
        transaction_date: i.date,
        source: "import",
        metadata: {
          scope: args.scope,
          fp: fingerprint(i.date, centsOf(i), i.desc),
          imported_from: path.basename(file),
        },
      }
      if (args.category) body.category = args.category
      if (args["account-id"] != null) body.account_id = args["account-id"]
      const res = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
      if (res.ok) ok++
      else prompts.log.warn(`${i.date} ${fmtCents(centsOf(i))} failed (${res.status})`)
    }
    await recordRun({
      kind: "import",
      scope: String(args.scope),
      rail: "csv",
      ok: ok === fresh.length,
      failures: fresh.length - ok,
      candidates: items.length,
      written: ok,
      duplicates: dupes,
      amount: total / 100,
      notes: path.basename(file),
    })
    prompts.log.success(`Imported ${ok}/${fresh.length} · ${fmtCents(total)} · scope=${args.scope}`)
    prompts.outro("Done")
  },
})

// ── email receipt scanner ────────────────────────────────────────────────────

/**
 * Which mailbox maps to which scope. A client mailbox never lands in personal or
 * business money — it gets its own scope so it can be reported on and excluded.
 */
const ACCOUNT_SCOPE: Record<string, string> = {
  "admin@vanguardhcs.com": "client:vanguard",
}

const RECEIPT_QUERY =
  '(subject:(receipt OR invoice OR "order confirmation" OR "payment received" OR "your order" OR statement) ' +
  "OR from:(receipts OR billing OR invoice OR no-reply OR noreply)) -category:promotions"

/* ── Mail collection rails ────────────────────────────────────────────────────
 * These live here, not in mint-core, because mint-core opens by promising
 * "no network, no CLI" — and that promise is the reason it can be unit-tested
 * at all. They were briefly moved there, which broke the build: mint-core had
 * no imports to give them, and the imports they needed were still sitting in
 * this file, unused. That pair of symptoms is what an unfinished extraction
 * looks like from the outside.
 */
type Candidate = { subject: string; body: string; sender: string; date: string; term?: string }

type Merchant = {
  term: string
  label: string
  category?: string
  account_id?: number
  scope?: string
  active?: boolean
}

/**
 * The merchant-terms array, stored as an Atlas dataset (`mint-merchants`) rather
 * than hardcoded — same pattern as budgets. A term carries its category and
 * chart-of-accounts id, so matching a sender also CATEGORISES the expense
 * instead of dumping everything into one bucket.
 */
async function fetchMerchants(): Promise<Merchant[]> {
  const res = await irisFetch(`/api/v1/atlas/datasets/mint-merchants?per_page=200`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
  return records
    .map((r) => ({ ...(r.data ?? {}) }) as Merchant)
    .filter((m) => m.active !== false && String(m.term ?? "").trim() !== "")
}

/** Local rail — IRIS Bridge on :3200, this Mac only. Verified working. */
async function collectFromAppleMail(
  senders: string[],
  days: number,
  perSender: number,
  errors: string[],
): Promise<Candidate[]> {
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const term of senders) {
    const params = new URLSearchParams({
      from: term,
      days: String(days),
      limit: String(perSender),
      include_body: "1",
      max_body: "6000",
    })
    // A failed search is NOT an empty search. Swallowing it here turns a wedged
    // Apple Mail into "no receipts found", which reads as a clean result from a
    // dead instrument. Errors are collected and reported, never skipped.
    let res: Response
    try {
      res = await bridgeFetch(`/api/mail/search?${params}`)
    } catch (e) {
      errors.push(`${term}: bridge unreachable`)
      continue
    }
    if (!res.ok) {
      errors.push(`${term}: HTTP ${res.status}`)
      continue
    }
    let payload: any
    try {
      payload = await res.json()
    } catch {
      errors.push(`${term}: unreadable response`)
      continue
    }
    if (payload?.error) {
      errors.push(`${term}: ${String(payload.error).slice(0, 80)}`)
      continue
    }
    let rows: any[] = []
    try {
      rows = mailRows(payload)
    } catch {
      errors.push(`${term}: unparseable rows`)
      continue
    }
    for (const m of rows) {
      const key = `${m.sender}|${m.subject}|${m.date}`
      if (seen.has(key)) continue // the same email matches several sender terms
      seen.add(key)
      out.push({
        subject: String(m.subject ?? ""),
        body: String(m.body ?? ""),
        sender: String(m.sender ?? ""),
        date: String(m.date ?? ""),
        term,
      })
    }
  }
  return out
}

/** Remote rail — Gmail via execute-direct. BROKEN as of 2026-08-19, see #181361. */
async function collectFromGmail(days: number, limit: number, account?: string): Promise<Candidate[]> {
  const q = `${RECEIPT_QUERY} newer_than:${days}d`
  const opts = account ? { account } : {}
  const result = await executeIntegrationCall("gmail", "search_emails", { query: q, max_results: limit }, opts)
  let messages: any[] = result?.messages ?? result?.emails ?? result?.data ?? []
  if (!Array.isArray(messages)) messages = []
  const out: Candidate[] = []
  for (const msg of messages) {
    const id = msg?.id ?? msg?.messageId
    let email: any = msg
    if (id && !msg?.body) {
      try {
        const r = await executeIntegrationCall("gmail", "read_emails", { messageId: id, id, max_results: 1 }, opts)
        const list = r?.emails ?? r?.messages ?? r?.data ?? []
        email = (Array.isArray(list) ? (list.find((e: any) => e?.id === id) ?? list[0]) : r) ?? msg
      } catch {
        /* keep the search row */
      }
    }
    out.push({
      subject: String(email?.subject ?? ""),
      body: String(email?.body ?? email?.textBody ?? email?.snippet ?? ""),
      sender: String(email?.from ?? email?.sender ?? ""),
      date: String(email?.date ?? ""),
    })
  }
  return out
}

/**
 * MODEL CHOICE, from `php artisan models:bench` (5 runs/model, ranked on the floor):
 * gpt-4.1-nano — precision 90, fabrication trap 5/5, reliability 100%, ~10s.
 * Its weak axis is RECALL (75), i.e. it MISSES fields rather than inventing them.
 * For extraction that is the correct failure mode: a miss is quarantined, a
 * fabrication would be written. mimo-v2.5-pro (precision 100, trap 5/5) is the
 * escalation, at ~5x the latency.
 */
const DEFAULT_EXTRACT_MODEL = "iris/gpt-4.1-nano"

const EXTRACT_PROMPT = `You extract payment details from a receipt email. Return ONLY minified JSON:
{"merchant":string,"amount":string,"date":"YYYY-MM-DD","currency":"USD","is_receipt":boolean}
Rules:
- "amount" MUST be copied character-for-character from the email as it appears there (e.g. "42.19"). Never compute, round, or reformat it.
- If the email is not a purchase receipt/invoice/statement, set is_receipt=false.
- If any field is not literally present, use an empty string. NEVER guess.
Email:
`

let lastExtractError = ""

async function extractReceipt(model: string, subject: string, body: string): Promise<any | null> {
  const res = await irisFetch(
    `/api/v6/openai/chat/completions`,
    {
      method: "POST",
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        messages: [{ role: "user", content: `${EXTRACT_PROMPT}Subject: ${subject}\n\n${body.slice(0, 6000)}` }],
      }),
    },
    IRIS_API,
  )
  if (!res.ok) {
    lastExtractError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`
    return null
  }
  const j = (await res.json()) as any
  const text = j?.choices?.[0]?.message?.content ?? ""
  const m = String(text).match(/\{[\s\S]*\}/)
  if (!m) {
    lastExtractError = `no JSON in reply: ${String(text).slice(0, 120)}`
    return null
  }
  try {
    return JSON.parse(m[0])
  } catch {
    lastExtractError = "unparseable JSON"
    return null
  }
}

/**
 * THE GATE. The benchmark says this model's claims are 90% precise, not 100% —
 * so nothing it says is trusted on its own. The amount must appear literally in
 * the source text, and the date must parse. Anything else is quarantined, never
 * written. A check that cannot fail is not a check.
 */
const ScanCommand = cmd({
  command: "scan",
  describe: "scan email for receipts and turn them into transactions (verified, idempotent)",
  builder: (y) =>
    y
      .option("rail", {
        type: "string",
        default: "mail",
        describe: "mail (Apple Mail, local, works) | gmail (blocked by #181361)",
      })
      .option("senders", { type: "string", describe: "comma-separated sender terms for the mail rail" })
      .option("days", { type: "number", default: 30, describe: "how far back to search" })
      .option("account", { type: "string", describe: "gmail account to scan (default: the connected one)" })
      .option("scope", { alias: "s", type: "string", describe: "override the scope for this run" })
      .option("category", { alias: "c", type: "string" })
      .option("account-id", { type: "number", describe: "chart-of-accounts id" })
      .option("model", { type: "string", default: DEFAULT_EXTRACT_MODEL })
      .option("limit", { type: "number", default: 25, describe: "max emails to examine" })
      .option("write", { type: "boolean", default: false, describe: "actually write (default is preview only)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Scan")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const scope =
      args.scope ?? (args.account ? (ACCOUNT_SCOPE[args.account.toLowerCase()] ?? DEFAULT_SCOPE) : DEFAULT_SCOPE)
    const rail = String(args.rail)
    const spinner = prompts.spinner()
    spinner.start(`Scanning ${rail === "mail" ? "Apple Mail" : "Gmail"} (last ${args.days} days)…`)

    let candidates: Candidate[] = []
    let merchants: Merchant[] = []
    let senders: string[] = []
    let usedFallback = false
    const mailErrors: string[] = []
    try {
      if (rail === "mail") {
        if (args.senders)
          senders = String(args.senders)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        else {
          merchants = await fetchMerchants()
          senders = merchants.map((m) => m.term)
          // Falling back silently would make an empty dataset look like a working
          // scan with poor coverage. Say which list is in use.
          if (senders.length === 0) {
            senders = DEFAULT_SENDERS
            usedFallback = true
          }
        }
        candidates = await collectFromAppleMail(
          senders,
          Number(args.days),
          Math.max(2, Math.ceil(Number(args.limit) / 4)),
          mailErrors,
        )
      } else {
        candidates = await collectFromGmail(Number(args.days), Number(args.limit), args.account)
      }
    } catch (err) {
      spinner.stop("Scan failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }
    spinner.stop(`${candidates.length} candidate email(s)`)
    if (rail === "mail") {
      console.log(
        "  " +
          dim(
            `${senders.length} merchant term(s)${usedFallback ? " — built-in fallback list; `mint-merchants` dataset is empty" : " from mint-merchants"}`,
          ),
      )
    }

    // #181361: gmail search_emails ignores every parameter and returns one fixed
    // message. Say so rather than reporting "no receipts", which reads as a clean
    // result from a broken instrument.
    if (rail === "gmail" && candidates.length <= 1) {
      prompts.log.warn(
        "Gmail returned <=1 result regardless of query — this is bug #181361, not an empty inbox. Use --rail mail.",
      )
      await recordRun({
        kind: "scan",
        scope,
        rail,
        ok: false,
        failures: 1,
        candidates: candidates.length,
        written: 0,
        notes: "gmail search returns a fixed response regardless of query — bug #181361",
      })
    }
    if (mailErrors.length) {
      prompts.log.error(
        `${mailErrors.length} of ${senders.length} mail searches FAILED — results below are incomplete:`,
      )
      for (const e of mailErrors.slice(0, 6)) console.log("    " + dim(e))
      if (mailErrors.length > 6) console.log("    " + dim(`… ${mailErrors.length - 6} more`))
      if (mailErrors.length === senders.length) {
        prompts.log.error(
          "EVERY search failed. This is not an empty inbox — Apple Mail/osascript is wedged. Try: quit and reopen Mail.app, then `iris bridge restart`.",
        )
      }
      // Recorded as a FAILED run, never as a zero-value one.
      await recordRun({
        kind: "scan",
        scope,
        rail,
        ok: false,
        failures: mailErrors.length,
        candidates: candidates.length,
        written: 0,
        notes: `${mailErrors.length}/${senders.length} searches failed: ${mailErrors.slice(0, 3).join("; ")}`.slice(
          0,
          400,
        ),
      })
    }
    if (candidates.length === 0) {
      prompts.log.warn(mailErrors.length ? "No usable results (see failures above)" : "Nothing matched")
      prompts.outro("Done")
      return
    }

    const found: any[] = []
    const quarantined: any[] = []
    for (const c of candidates) {
      const source = `${c.subject}\n${c.body}`
      if (!c.body) {
        quarantined.push({ subject: c.subject, reason: "no body returned" })
        continue
      }
      const ex = await extractReceipt(String(args.model), c.subject, c.body)
      if (!ex) {
        quarantined.push({ subject: c.subject, reason: lastExtractError || "extraction failed" })
        continue
      }
      if (ex.is_receipt === false) continue
      const v = verifyAgainstSource(ex, source)
      if (!v.ok) {
        quarantined.push({ subject: c.subject, reason: v.reason })
        continue
      }
      const mm = merchants.find((m) => m.term === c.term)
      found.push({
        date: v.date!,
        amount: v.amount!,
        desc: (String(ex.merchant ?? "").trim() || mm?.label || c.subject).slice(0, 200),
        subject: c.subject,
        category: args.category ?? (mm?.category || undefined),
        accountId: args["account-id"] ?? (mm?.account_id && mm.account_id > 0 ? mm.account_id : undefined),
        rowScope: mm?.scope || scope,
      })
    }

    if (found.length === 0 && quarantined.length === 0) {
      prompts.log.warn("No receipts found")
      prompts.outro("Done")
      return
    }

    // Same fingerprint as `mint import` — a receipt already imported from a CSV
    // will not be added twice.
    let fresh = found
    if (found.length) {
      const dates = found.map((f) => f.date).sort()
      const seen = await existingFingerprints(dates[0], dates[dates.length - 1])
      fresh = found.filter((f) => !seen.has(fingerprint(f.date, centsOf(f), f.desc)))
    }

    printDivider()
    for (const f of fresh)
      console.log(
        `  ${dim(f.date)}  ${fmtCents(centsOf(f)).padEnd(12)}  ${bold(f.desc)}  ${dim([f.category ?? "uncategorised", f.rowScope].filter(Boolean).join(" · "))}`,
      )
    if (fresh.length === 0) console.log("  " + dim("nothing new"))
    printDivider()
    console.log(
      `  ${bold(String(fresh.length))} new  ·  ${dim(`${found.length - fresh.length} already recorded`)}  ·  ${bold(fmtCents(fresh.reduce((s, f) => s + centsOf(f), 0)))}  ${dim(`scope=${scope}`)}`,
    )

    if (quarantined.length) {
      console.log("")
      console.log("  " + bold(`${quarantined.length} held for review — extracted but NOT verified against the email:`))
      for (const q of quarantined.slice(0, 10))
        console.log(`    ${dim("·")} ${q.subject.slice(0, 60)}  ${dim(q.reason)}`)
      if (quarantined.length > 10) console.log("    " + dim(`… ${quarantined.length - 10} more`))
    }

    const scanOk = mailErrors.length === 0
    if (args.json) {
      await writeJson({ fresh, quarantined })
      prompts.outro("Done")
      return
    }
    if (!args.write) {
      // A preview is still a measurement of the mailbox — logged so a gap in the
      // trend means "nobody looked", not "nothing was found".
      await recordRun({
        kind: "scan",
        scope,
        rail,
        ok: scanOk,
        failures: mailErrors.length,
        candidates: candidates.length,
        written: 0,
        duplicates: found.length - fresh.length,
        quarantined: quarantined.length,
        amount: fresh.reduce((a, f) => a + centsOf(f), 0) / 100,
        notes: "preview only (no --write)",
      })
      prompts.log.info("Preview only — re-run with --write to record these")
      prompts.outro("Done")
      return
    }
    if (fresh.length === 0) {
      prompts.log.success("Already up to date")
      prompts.outro("Done")
      return
    }

    let ok = 0
    for (const f of fresh) {
      const body: Record<string, any> = {
        type: "expense",
        description: f.desc,
        amount_cents: centsOf(f),
        transaction_date: f.date,
        source: "import",
        metadata: {
          scope: f.rowScope ?? scope,
          fp: fingerprint(f.date, centsOf(f), f.desc),
          imported_from: `${rail}-scan`,
          subject: f.subject.slice(0, 200),
        },
      }
      if (f.category) body.category = f.category
      if (f.accountId != null) body["account_id"] = f.accountId
      const res = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
      if (res.ok) ok++
    }
    await recordRun({
      kind: "scan",
      scope,
      rail,
      ok: scanOk && ok === fresh.length,
      failures: mailErrors.length + (fresh.length - ok),
      candidates: candidates.length,
      written: ok,
      duplicates: found.length - fresh.length,
      quarantined: quarantined.length,
      amount: fresh.reduce((a, f) => a + centsOf(f), 0) / 100,
    })
    prompts.log.success(`Recorded ${ok}/${fresh.length} · scope=${scope}`)
    prompts.outro("Done")
  },
})

const MerchantsCommand = cmd({
  command: "merchants",
  aliases: ["m"],
  describe: "the merchant-term array mint scan sweeps (Atlas dataset `mint-merchants`)",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Merchants")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }
    const rows = await fetchMerchants()
    if (args.json) {
      await writeJson(rows)
      prompts.outro("Done")
      return
    }
    if (rows.length === 0) {
      prompts.log.warn("Empty — `mint scan` will fall back to its built-in list.")
      prompts.log.info(
        'Add one: iris atlas:datasets records upsert -s mint-merchants --external-id lyft --data \'{"term":"lyft",...}\'',
      )
      prompts.outro("Done")
      return
    }
    printDivider()
    for (const m of rows) {
      const cat = m.category ? `${m.category}${m.account_id ? ` → acct #${m.account_id}` : ""}` : dim("uncategorised")
      console.log(
        `  ${bold((m.label || m.term).padEnd(24))} ${dim(`"${m.term}"`.padEnd(18))} ${cat}  ${dim(m.scope ?? "")}`,
      )
    }
    printDivider()
    console.log("  " + dim(`${rows.length} active term(s)`))
    prompts.outro("Done")
  },
})

// ── run log: snapshot + trend ────────────────────────────────────────────────

/**
 * Every mint run writes one row here. The rule that shapes this table:
 * A RUN THAT FAILED IS RECORDED AS FAILED, NOT AS A ZERO.
 * On 2026-08-19 a mail sweep returned ten clean zeros that were actually
 * osascript errors read through `.get('count', 0)`. If a broken instrument
 * writes `written: 0, ok: true`, the trend line flattens and looks like
 * "spending stopped" instead of "measurement stopped". `ok` and `failures`
 * exist so those two can never be confused again.
 */
type RunRow = {
  kind: "snapshot" | "scan" | "import"
  scope: string
  rail?: string
  ok: boolean
  failures?: number
  candidates?: number
  written?: number
  duplicates?: number
  quarantined?: number
  amount?: number
  total_spent?: number
  total_cap?: number
  budgets?: any[]
  notes?: string
}

function nowStamp(): { iso: string; id: string } {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const iso = `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const id = `${ymd(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-`
  return { iso, id }
}

async function recordRun(row: RunRow): Promise<string | null> {
  const { iso, id } = nowStamp()
  const externalId = id + row.kind
  const flag = row.ok ? "" : " ⚠ FAILED"
  const data = {
    label: `${row.kind}${row.rail ? ` (${row.rail})` : ""} — ${iso}${flag}`,
    ran_at: iso,
    ...row,
  }
  const res = await irisFetch(`/api/v1/atlas/datasets/mint-runs/upsert`, {
    method: "POST",
    body: JSON.stringify({ external_id: externalId, data }),
  })
  return res.ok ? externalId : null
}

async function fetchRuns(kind?: string, limit = 60): Promise<any[]> {
  // `sort` is a FIELD NAME and direction is a separate `dir` param — there is no
  // "-field" syntax. Ask for the NEWEST rows server-side (so paging keeps the ones
  // that matter), then order ascending in code for display.
  const p = new URLSearchParams({ per_page: String(limit), sort: "ran_at", dir: "desc" })
  if (kind) p.set("filter[kind]", kind)
  const res = await irisFetch(`/api/v1/atlas/datasets/mint-runs?${p}`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
  // Order ascending for display. This is a normalisation of the page the server
  // returned, NOT the primary sort — the `sort`/`dir` params above do that, or
  // paging would hand back an arbitrary slice. Kept because an unknown sort field
  // silently yields insertion order on this endpoint, and a reversed trend reports
  // a fall in spending as a rise.
  return records
    .map((r) => ({ id: r.id, external_id: r.external_id, ...(r.data ?? {}) }))
    .sort((a, b) => String(a.ran_at ?? "").localeCompare(String(b.ran_at ?? "")) || (a.id ?? 0) - (b.id ?? 0))
}

/**
 * Spend in this scope+window that NO active budget covers.
 * Without this a snapshot sums only budgeted categories and presents that as the
 * position — so $215 of Lyft with no transport budget reads as "$0 spent, all
 * budgets healthy". The total has to know what it cannot see.
 */
async function unbudgetedSpend(scope: string, from: string, to: string, budgetedCats: string[]) {
  const p = new URLSearchParams({ per_page: "500", type: "expense", from, to })
  const res = await irisFetch(`/api/v1/atlas/transactions?${p}`)
  if (!res.ok) return { cents: 0, byCategory: [] as any[] }
  const body = (await res.json()) as any
  const rows: any[] = body?.data?.data ?? body?.data ?? []
  const known = new Set(budgetedCats.filter(Boolean).map((c) => String(c).toLowerCase()))
  const buckets = new Map<string, number>()
  for (const tx of rows) {
    if (tx?.metadata?.scope !== scope) continue
    const cat = String(tx.category ?? "").toLowerCase()
    if (known.has(cat)) continue
    buckets.set(cat || "(uncategorised)", (buckets.get(cat || "(uncategorised)") ?? 0) + (Number(tx.amount_cents) || 0))
  }
  const byCategory = [...buckets.entries()]
    .map(([category, cents]) => ({ category, cents }))
    .sort((a, b) => b.cents - a.cents)
  return { cents: byCategory.reduce((a, b) => a + b.cents, 0), byCategory }
}

/** Current budget-vs-actual position, shared by `status` and `snapshot`. */
async function computePosition(scope: string, period?: string) {
  let budgets = (await fetchBudgets(scope)).filter((b) => b.active)
  if (period) budgets = budgets.filter((b) => b.period === period)
  const rows: any[] = []
  for (const b of budgets) {
    const [from, to] = periodWindow(b.period)
    const spent = await actualCents(b.category, scope, from, to)
    const capCents = Math.round(Number(b.cap ?? 0) * 100)
    rows.push({
      name: b.name,
      category: b.category,
      period: b.period,
      from,
      to,
      cap_cents: capCents,
      spent_cents: spent,
      remaining_cents: capCents - spent,
      pct: capCents > 0 ? (spent / capCents) * 100 : null,
    })
  }
  return rows
}

const SnapshotCommand = cmd({
  command: "snapshot",
  aliases: ["snap"],
  describe: "record the current budget-vs-actual position into the mint-runs log",
  builder: (y) =>
    y
      .option("scope", { alias: "s", type: "string", default: DEFAULT_SCOPE })
      .option("period", { alias: "p", type: "string" })
      .option("note", { type: "string", describe: "why this snapshot was taken" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Snapshot")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Measuring…")
    const rows = await computePosition(String(args.scope), args.period)
    spinner.stop(`${rows.length} budget(s)`)

    if (rows.length === 0) {
      // No budgets is not a zero-spend position — it is nothing to measure.
      // Recording it as a healthy $0 run would put a false floor in the trend.
      prompts.log.warn(`No active budgets for scope "${args.scope}" — nothing to snapshot.`)
      prompts.outro("Done")
      return
    }

    const totalSpent = rows.reduce((a, r) => a + r.spent_cents, 0)
    const totalCap = rows.reduce((a, r) => a + r.cap_cents, 0)

    // Widest window any budget covers — what "this period" means for the leftovers.
    const froms = rows.map((r) => r.from).sort()
    const tos = rows.map((r) => r.to).sort()
    const unb = await unbudgetedSpend(
      String(args.scope),
      froms[0],
      tos[tos.length - 1],
      rows.map((r) => r.category),
    )

    printDivider()
    for (const r of rows) {
      const pct = r.pct == null ? dim("  —") : `${String(Math.round(r.pct)).padStart(3)}%`
      console.log(`  ${bold(String(r.name).padEnd(26))} ${pct}  ${fmtCents(r.spent_cents)} / ${fmtCents(r.cap_cents)}`)
    }
    printDivider()
    console.log(`  ${bold("TOTAL").padEnd(26)}      ${bold(fmtCents(totalSpent))} / ${fmtCents(totalCap)}`)

    if (unb.cents > 0) {
      console.log("")
      console.log(
        "  " +
          bold(`${fmtCents(unb.cents)} spent outside every budget`) +
          dim(`  (${froms[0]} → ${tos[tos.length - 1]})`),
      )
      for (const b of unb.byCategory.slice(0, 6)) {
        console.log(`    ${dim("·")} ${String(b.category).padEnd(20)} ${fmtCents(b.cents)}  ${dim("no active budget")}`)
      }
      console.log(
        "  " + dim("The TOTAL above does not include this. Add budgets for these categories or it stays invisible."),
      )
    }

    const id = await recordRun({
      kind: "snapshot",
      scope: String(args.scope),
      ok: true,
      failures: 0,
      total_spent: totalSpent / 100,
      total_cap: totalCap / 100,
      amount: unb.cents / 100, // unbudgeted spend, kept on the row so the trend can show it
      budgets: rows.map((r) => ({
        name: r.name,
        category: r.category,
        period: r.period,
        from: r.from,
        to: r.to,
        spent: r.spent_cents / 100,
        cap: r.cap_cents / 100,
        pct: r.pct == null ? null : Math.round(r.pct),
      })),
      notes: [
        args.note,
        unb.cents > 0
          ? `unbudgeted: ${(unb.cents / 100).toFixed(2)} across ${unb.byCategory.map((b) => b.category).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 400),
    })
    if (args.json) {
      await writeJson({ id, rows })
      prompts.outro("Done")
      return
    }
    if (id) prompts.log.success(`Recorded as ${id}`)
    else prompts.log.error("Could not write the run row — this snapshot is NOT in the trend")
    prompts.outro("Done")
  },
})

const TrendCommand = cmd({
  command: "trend",
  aliases: ["history"],
  describe: "how spend and run health have moved over time",
  builder: (y) =>
    y
      .option("kind", { type: "string", describe: "snapshot | scan | import" })
      .option("limit", { type: "number", default: 30 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Trend")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const runs = await fetchRuns(args.kind, Number(args.limit))
    if (args.json) {
      await writeJson(runs)
      prompts.outro("Done")
      return
    }
    if (runs.length === 0) {
      prompts.log.warn("No runs recorded yet. Take one: iris mint snapshot")
      prompts.outro("Done")
      return
    }

    const ordered = runs // fetchRuns already returns oldest → newest
    const snaps = ordered.filter((r) => r.kind === "snapshot")
    const failed = ordered.filter((r) => r.ok === false)

    // Health first. A trend computed over runs that silently failed is a lie,
    // so the reader is told about the gaps BEFORE being shown the line.
    if (failed.length) {
      prompts.log.error(`${failed.length} of ${ordered.length} runs FAILED — the line below has holes:`)
      for (const f of failed.slice(-4))
        console.log(
          "    " +
            dim(`${f.ran_at}  ${f.kind}  ${f.failures ?? "?"} failure(s)  ${String(f.notes ?? "").slice(0, 60)}`),
        )
    }

    if (snaps.length >= 1) {
      const spend = snaps.map((r) => Number(r.total_spent ?? 0))
      console.log("")
      console.log(`  ${bold("Total spend across snapshots")}   ${sparkline(spend)}`)
      const first = spend[0],
        last = spend[spend.length - 1]
      const delta = last - first
      const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "•"
      console.log("  " + dim(`${snaps[0].ran_at} → ${snaps[snaps.length - 1].ran_at}`))
      console.log(
        `  $${first.toFixed(2)} → $${last.toFixed(2)}   ${arrow} ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}`,
      )
      const lastUnb = Number(snaps[snaps.length - 1].amount ?? 0)
      if (lastUnb > 0)
        console.log("  " + dim(`plus $${lastUnb.toFixed(2)} spent outside every budget — not in the line above`))
      if (snaps.length === 1)
        prompts.log.info("One snapshot is a reading, not a trend. Take more before drawing conclusions.")

      // Per-budget movement, newest vs oldest
      const firstB: any[] = snaps[0].budgets ?? []
      const lastB: any[] = snaps[snaps.length - 1].budgets ?? []
      if (snaps.length > 1 && lastB.length) {
        printDivider()
        for (const b of lastB) {
          const prev = firstB.find((x: any) => x.name === b.name)
          const d = prev ? Number(b.spent ?? 0) - Number(prev.spent ?? 0) : null
          const dTxt = d == null ? dim("new") : `${d > 0 ? "▲ +" : d < 0 ? "▼ -" : "• "}$${Math.abs(d).toFixed(2)}`
          const over = b.pct != null && b.pct >= 100 ? " ⚠ OVER" : ""
          console.log(
            `  ${bold(String(b.name).padEnd(26))} $${Number(b.spent ?? 0).toFixed(2)} / $${Number(b.cap ?? 0).toFixed(2)}  ${dTxt}${over}`,
          )
        }
      }
    }

    const ingest = ordered.filter((r) => r.kind !== "snapshot")
    if (ingest.length) {
      printDivider()
      console.log(`  ${bold("Ingest runs")}`)
      for (const r of ingest.slice(-8)) {
        const health = r.ok === false ? "⚠ FAILED" : "ok"
        console.log(
          `  ${dim(r.ran_at)}  ${String(r.kind).padEnd(8)} ${dim(String(r.rail ?? "").padEnd(6))} ${String(r.written ?? 0).padStart(3)} written  ${dim(`${r.duplicates ?? 0} dupe · ${r.quarantined ?? 0} held · ${health}`)}`,
        )
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ── audit trail ──────────────────────────────────────────────────────────────

/**
 * An immutable event per mutation. This exists because on 2026-08-19 thirteen
 * transactions were rewritten in place (a scope backfill) and NOTHING recorded
 * what they had been. The numbers were right; the change was unprovable — and an
 * unprovable number is not usable in books anyone else has to trust.
 *
 * FAILED mutations are logged too, with ok:false. A trail that only records
 * successes cannot answer "did someone try?", which is the question that matters
 * when a figure is disputed.
 */
type AuditEvent = {
  action: "create" | "update" | "delete" | "backfill" | "import" | "scan"
  entity: string
  entity_id?: number
  scope?: string
  field?: string
  before?: string
  after?: string
  amount?: number
  ok: boolean
  reason?: string
  run_id?: string
}

async function audit(ev: AuditEvent): Promise<void> {
  const { iso, id } = nowStamp()
  const label = `${ev.action} ${ev.entity}${ev.entity_id ? ` #${ev.entity_id}` : ""}${ev.ok ? "" : " ⚠ FAILED"}`
  const res = await irisFetch(`/api/v1/atlas/datasets/mint-audit/upsert`, {
    method: "POST",
    body: JSON.stringify({
      external_id: `${id}${ev.action}-${ev.entity}-${ev.entity_id ?? "n"}`,
      data: { label, at: iso, ...ev },
    }),
  }).catch(() => null)

  // A ledger write must not FAIL because its audit row failed — but it must not
  // pass quietly either. This trail exists because thirteen transactions were once
  // rewritten with nothing recording what they had been, and a dropped row
  // reproduces exactly that: the change lands, the proof does not, and nothing says
  // so. Warned here rather than at the caller because audit() returns void — a
  // caller has no way to learn this failed.
  //
  // Checks res.ok, not just the catch: irisFetch RESOLVES on a non-2xx, so an HTTP
  // 500 from the audit endpoint would otherwise be indistinguishable from success.
  if (!res || !res.ok) {
    prompts.log.warn(
      `Audit row NOT written for ${label}` +
        (res ? ` (HTTP ${res.status})` : " (request failed)") +
        " — the change itself is applied, but the trail is now incomplete.",
    )
  }
}

const AuditCommand = cmd({
  command: "audit",
  aliases: ["trail"],
  describe: "the immutable record of every change to the books",
  builder: (y) =>
    y
      .option("entity-id", { type: "number", describe: "only events for one transaction" })
      .option("action", { type: "string", describe: "create|update|delete|backfill|import|scan" })
      .option("failures", { type: "boolean", default: false, describe: "only failed mutations" })
      .option("limit", { type: "number", default: 40 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Audit Trail")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const p = new URLSearchParams({ per_page: String(args.limit), sort: "at", dir: "desc" })
    if (args.action) p.set("filter[action]", String(args.action))
    if (args["entity-id"] != null) p.set("filter[entity_id]", String(args["entity-id"]))
    const res = await irisFetch(`/api/v1/atlas/datasets/mint-audit?${p}`)
    if (!res.ok) {
      prompts.log.error(`Could not read the trail (HTTP ${res.status})`)
      prompts.outro("Done")
      return
    }
    const body = (await res.json()) as any
    let rows: any[] = (body?.data?.records?.data ?? body?.data?.records ?? []).map((r: any) => ({
      id: r.id,
      ...(r.data ?? {}),
    }))
    rows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
    if (args.failures) rows = rows.filter((r) => r.ok === false)

    if (args.json) {
      await writeJson(rows)
      prompts.outro("Done")
      return
    }
    if (rows.length === 0) {
      prompts.log.warn("No audit events recorded yet")
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const r of rows) {
      const mark = r.ok === false ? "⚠" : "·"
      console.log(
        `  ${mark} ${dim(r.at)}  ${bold(String(r.action).padEnd(9))} ${String(r.entity).padEnd(12)} ${r.entity_id ? dim(`#${r.entity_id}`) : ""}`,
      )
      if (r.field)
        console.log(
          `      ${dim(`${r.field}:`)} ${dim(String(r.before ?? "∅"))} ${dim("→")} ${bold(String(r.after ?? "∅"))}`,
        )
      if (r.reason) console.log(`      ${dim(String(r.reason).slice(0, 90))}`)
    }
    printDivider()
    const failed = rows.filter((r) => r.ok === false).length
    console.log(`  ${rows.length} event(s)` + (failed ? `  ${bold(`· ${failed} FAILED`)}` : ""))
    prompts.outro("Done")
  },
})

// ── verify ───────────────────────────────────────────────────────────────────

/** Row cap per verify window. A full page is treated as "cannot verify", not as the answer. */
const PAGE = 500

const VerifyCommand = cmd({
  command: "verify",
  aliases: ["reconcile"],
  describe: "prove every reported figure ties to the rows behind it",
  builder: (y) =>
    y
      .option("scope", { alias: "s", type: "string", default: DEFAULT_SCOPE })
      .option("period", { alias: "p", type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Verify")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const scope = String(args.scope)
    const spinner = prompts.spinner()
    spinner.start("Reconciling…")
    const position = await computePosition(scope, args.period)
    if (position.length === 0) {
      spinner.stop("Nothing to verify", 1)
      prompts.log.warn(`No active budgets for scope "${scope}"`)
      prompts.outro("Done")
      return
    }

    const results: any[] = []
    for (const b of position) {
      // Pull the RAW rows for the window with no scope/category filter, so the
      // reconciler sees everything it might have to exclude — and can say why.
      const p = new URLSearchParams({ per_page: String(PAGE), type: "expense", from: b.from, to: b.to })
      const res = await irisFetch(`/api/v1/atlas/transactions?${p}`)
      if (!res.ok) {
        results.push({ budget: b, error: `HTTP ${res.status}` })
        continue
      }
      const body = (await res.json()) as any
      const raw: any[] = body?.data?.data ?? body?.data ?? []

      // A full page back means there may be more, and reconciling against a SUBSET
      // does not produce a smaller answer — it produces a wrong one, reported as
      // drift the books do not actually have. By this command's own rule below,
      // a check that could not see everything is not a check that failed; it is a
      // check that did not run.
      if (raw.length >= PAGE) {
        results.push({ budget: b, error: `window returned ${raw.length} rows (cap ${PAGE}) — may be truncated` })
        continue
      }

      const recon = reconcile({
        claimed_cents: b.spent_cents,
        scope,
        category: b.category,
        from: b.from,
        to: b.to,
        rows: raw.map((t) => ({
          amount_cents: Number(t.amount_cents) || 0,
          scope: t?.metadata?.scope,
          category: t.category,
          date: String(t.transaction_date ?? ""),
        })),
      })
      results.push({ budget: b, recon })
    }
    spinner.stop(`${results.length} figure(s)`)

    if (args.json) {
      await writeJson(results)
      prompts.outro("Done")
      return
    }

    printDivider()
    let bad = 0,
      errored = 0
    for (const r of results) {
      if (r.error) {
        errored++
        console.log(`  ${bold(r.budget.name)}  ${bold("COULD NOT VERIFY")} ${dim(r.error)}`)
        continue
      }
      const mark = r.recon.ok ? "✓" : "✗"
      if (!r.recon.ok) bad++
      console.log(
        `  ${mark} ${bold(String(r.budget.name).padEnd(24))} claims ${fmtCents(r.recon.claimed_cents)}  ·  ${r.recon.counted} row(s) sum to ${fmtCents(r.recon.actual_cents)}`,
      )
      if (!r.recon.ok) console.log(`      ${bold(`drift ${fmtCents(r.recon.drift_cents)}`)}`)
      for (const e of r.recon.excluded.slice(0, 5)) {
        console.log(`      ${dim(`excluded ${e.count} row(s) · ${fmtCents(e.cents)} · ${e.reason}`)}`)
      }
    }
    printDivider()

    // "Could not verify" is its own outcome. Folding it into either pass or fail
    // is how a check that never ran ends up reported as a check that passed.
    if (errored) prompts.log.error(`${errored} figure(s) COULD NOT BE VERIFIED — that is not a pass`)
    if (bad) prompts.log.error(`${bad} figure(s) do NOT tie to the ledger`)
    if (!bad && !errored) prompts.log.success(`All ${results.length} figure(s) tie to the ledger`)
    prompts.outro("Done")
  },
})

// ============================================================================
export const PlatformMintCommand = cmd({
  command: "mint",
  describe: "IRIS Mint — budgets vs actuals for personal and business money",
  builder: (y) =>
    y
      .command(SpendCommand)
      .command(BudgetsCommand)
      .command(StatusCommand)
      .command(ScopeCommand)
      .command(ImportCommand)
      .command(ScanCommand)
      .command(MerchantsCommand)
      .command(SnapshotCommand)
      .command(TrendCommand)
      .command(AuditCommand)
      .command(VerifyCommand)
      .command(ScenarioCommand)
      .demandCommand(),
  async handler() {},
})
