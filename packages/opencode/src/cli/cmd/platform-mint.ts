import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import { ScenarioCommand } from "./mint-scenario-cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, writeJson, IRIS_API } from "./iris-api"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawnSync } from "child_process"
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
  sourceRef,
  classifySync,
  planSplit,
  reimbursableOf,
  normalizeDate,
  parseAmountDollars,
  parseCsv,
  periodWindow,
  pickCol,
  sparkline,
  today,
  verifyAgainstSource,
  billKind,
  transcriptIsUsable,
  BILL_IMAGE_MIME,
  ymd,
  budgetCategories,
  groupResolves,
  overlappingCategories,
  overlappingBudgets,
  evaluatePolicy,
  groupViolations,
  norm,
  NO_POLICY,
  type GroupLike,
  type Policy,
} from "./mint-core"
import { firstArray } from "../../util/array"

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
  const records: any[] = firstArray(body?.data?.records?.data, body?.data?.records)
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
  const rows: any[] = firstArray(body?.data?.data, body?.data)
  // Scope is not a server-side filter yet (it lives in metadata), so filter here.
  // STRICT: an untagged row belongs to no scope and is counted against none.
  // Defaulting untagged to "personal" would have silently pulled every legacy
  // business transaction into the personal budget the moment a category matched.
  // A split parent (#182035) is excluded too — its children carry the same
  // money under their own categories, so counting the parent here double-books
  // the original invoice on top of every campaign it was split into.
  return rows
    .filter((tx) => tx?.metadata?.scope === scope && !tx?.metadata?.superseded_by_split)
    .reduce((sum, tx) => sum + (Number(tx.amount_cents) || 0), 0)
}

/**
 * Sum expense cents across SEVERAL categories — what a group budget measures.
 *
 * An EMPTY list sums to 0 and does NOT fall back to "all categories". A budget
 * pointing at a group that does not resolve must measure nothing; an unfiltered
 * query would silently make it match every transaction in the scope and report
 * a wildly overspent budget as fact.
 */
async function actualCentsMulti(categories: string[], scope: string, from: string, to: string): Promise<number> {
  const cats = categories.map(norm).filter(Boolean)
  if (cats.length === 0) return 0
  let total = 0
  for (const c of cats) total += await actualCents(c, scope, from, to)
  return total
}

// ── groups + policy datasets (#181985, #181986) ──────────────────────────────

/**
 * Spending groups, stored as the Atlas dataset `mint-groups` — same pattern as
 * budgets and merchants. A group is a named set of categories that one cap can
 * sit on, so a shopping trip splitting across household/groceries/dining has
 * somewhere to land.
 */
/**
 * Like fetchGroups(), but keeps each record's Atlas external_id so a caller
 * that needs to upsert can update the record it actually found in place,
 * instead of minting a fresh id for something that already exists (#182098).
 */
async function fetchGroupRecords(scope?: string): Promise<(GroupLike & { external_id: string })[]> {
  const res = await irisFetch(`/api/v1/atlas/datasets/mint-groups?per_page=200`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const records: any[] = firstArray(body?.data?.records?.data, body?.data?.records)
  return records
    .map((r) => ({ ...(r.data ?? {}), external_id: String(r.external_id) }) as GroupLike & { external_id: string })
    .filter((g) => String(g.key ?? "").trim() !== "")
    .filter((g) => (scope ? !g.scope || g.scope === scope : true))
}

async function fetchGroups(scope?: string): Promise<GroupLike[]> {
  // Strips external_id back off — every existing caller (GroupListCommand's
  // --json output among them) expects exactly the GroupLike shape it always
  // returned, not fetchGroupRecords()'s storage-id-carrying superset.
  return (await fetchGroupRecords(scope)).map(({ external_id, ...g }) => g)
}

/**
 * The spend policy for a scope (`mint-policy` dataset), or null when none is set.
 *
 * null rather than NO_POLICY so callers can tell "no policy exists" from "a
 * policy exists and permits everything" — the first is a setup gap worth
 * mentioning, the second is a decision someone made.
 */
async function fetchPolicy(scope: string): Promise<Policy | null> {
  const res = await irisFetch(`/api/v1/atlas/datasets/mint-policy?per_page=200`)
  if (!res.ok) return null
  const body = (await res.json()) as any
  const records: any[] = firstArray(body?.data?.records?.data, body?.data?.records)
  const rows = records.map((r) => ({ ...(r.data ?? {}) }) as Policy)
  return rows.find((x) => norm(x.scope) === norm(scope)) ?? null
}

/**
 * Field definitions for mint's own datasets, so the first write can create the
 * schema instead of failing with "Schema not found" and a dead end. Groups and
 * policy are mint's data — asking someone to hand-craft a schema before using a
 * feature is a setup step that exists only because nobody automated it.
 */
const MINT_SCHEMAS: Record<string, { name: string; fields: any[] }> = {
  "mint-groups": {
    name: "Mint Spending Groups",
    fields: [
      { key: "key", type: "text", label: "Key" },
      { key: "name", type: "text", label: "Group" },
      { key: "categories", type: "text", label: "Categories" },
      { key: "scope", type: "text", label: "Scope" },
      { key: "active", type: "boolean", label: "Active" },
    ],
  },
  "mint-policy": {
    name: "Mint Spend Policy",
    fields: [
      { key: "scope", type: "text", label: "Scope" },
      { key: "require_category", type: "boolean", label: "Require category" },
      { key: "require_group", type: "boolean", label: "Require group" },
      { key: "require_description", type: "boolean", label: "Require description" },
      { key: "declared_only", type: "boolean", label: "Declared only" },
      { key: "max_single_expense", type: "money", label: "Max single $" },
      { key: "allowed_categories", type: "text", label: "Allowed categories" },
      { key: "active", type: "boolean", label: "Active" },
    ],
  },
}

/**
 * Create one of mint's datasets if it does not exist yet.
 *
 * Returns true when the schema is present afterwards. A creation failure is
 * reported by the CALLER against the write it was for — silently continuing
 * would turn a missing schema into a lost record.
 */
async function ensureSchema(schema: string): Promise<boolean> {
  const probe = await irisFetch(`/api/v1/atlas/datasets/${schema}?per_page=1`)
  if (probe.ok) return true
  const def = MINT_SCHEMAS[schema]
  if (!def) return false
  const res = await irisFetch("/api/v1/atlas/schemas", {
    method: "POST",
    body: JSON.stringify({ name: def.name, slug: schema, fields: def.fields }),
  })
  return res.ok
}

/** Upsert one record into an Atlas dataset. Idempotent on external_id. */
async function upsertRecord(schema: string, externalId: string, data: Record<string, any>) {
  await ensureSchema(schema)
  return irisFetch(`/api/v1/atlas/datasets/${schema}/import`, {
    method: "POST",
    body: JSON.stringify({ records: [{ external_id: externalId, data }], validate: false }),
  })
}

/**
 * Categories the system knows about: chart of accounts + every group member.
 *
 * The declared set `declared_only` checks against. It unions both because an
 * account can exist with no group and a group can name a category before its
 * account exists — rejecting either would make the strictest setting unusable.
 */
async function declaredCategories(scope: string): Promise<string[]> {
  const [accounts, groups] = await Promise.all([fetchAccounts(), fetchGroups(scope)])
  const out = new Set<string>()
  for (const a of accounts) {
    const n = norm(a?.name)
    if (n) out.add(n)
  }
  for (const g of groups) for (const c of (g.categories ?? []).map(norm)) if (c) out.add(c)
  return [...out]
}

/**
 * The spend-policy gate (#181986), shared by every write path.
 *
 * Originally lived only inline in SpendCommand — `mint import` and `mint
 * split` wrote transactions directly with no policy check at all, so a
 * capped category (or any other active policy) was silently unenforced for
 * both (#182097). Same shape as SpendCommand always used: block and audit
 * the refusal unless `force`, in which case the violations travel on the
 * row via `policy_override` so an out-of-policy write stays auditable.
 *
 * Returns `blocked: true` when the caller should NOT write this row.
 */
async function checkPolicyOrBlock(
  scopeStr: string,
  draft: { amount_cents?: number; description?: string; category?: string; scope?: string },
  opts: {
    force?: boolean
    // A caller checking many rows against the same scope (import, split)
    // fetches these ONCE up front and passes them in, instead of this
    // function re-fetching policy/categories/groups on every single row.
    // Omit any of them to have this function fetch it fresh (SpendCommand's
    // single-transaction case). `policy: null` is itself a valid pre-fetch
    // result ("no policy set") and is honored as-is, not treated as "unset".
    policy?: Policy | null
    knownCategories?: string[]
    groups?: GroupLike[]
    // Suppress the per-violation console output — a batch caller prints its
    // own aggregate summary instead of one full block per row. The audit
    // trail is written either way.
    quiet?: boolean
  } = {},
): Promise<{ blocked: boolean; violations: { code: string; message: string }[] }> {
  const policy = opts.policy !== undefined ? opts.policy : await fetchPolicy(scopeStr)
  let violations: { code: string; message: string }[] = []
  if (policy) {
    const knownCategories = opts.knownCategories ?? (await declaredCategories(scopeStr))
    const groups = opts.groups ?? (await fetchGroups(scopeStr))
    violations = [...evaluatePolicy(draft, policy, knownCategories), ...groupViolations(draft, policy, groups)]
  }
  if (violations.length > 0 && !opts.force) {
    if (!opts.quiet) {
      prompts.log.error(`Blocked by the spend policy for scope "${scopeStr}" — nothing was written:`)
      for (const v of violations) console.log(`    ${dim("·")} ${v.message}  ${dim(`[${v.code}]`)}`)
      console.log("  " + dim("Fix the row, relax the policy (iris mint policy set), or re-run with --force."))
    }
    // An audit row for the REFUSAL. A block that leaves no trace is
    // indistinguishable from a command nobody ran. Logged as a FAILED create
    // rather than a new "blocked" action: the server's enum rejects unknown
    // actions with a 422, and ok:false + reason is already the documented
    // shape for "someone tried and it did not happen".
    await audit({
      action: "create",
      entity: "transaction",
      scope: scopeStr,
      after: draft.description ?? "",
      amount: (draft.amount_cents ?? 0) / 100,
      ok: false,
      reason: `policy_blocked:${violations.map((v) => v.code).join(",")}`,
    })
    return { blocked: true, violations }
  }
  return { blocked: false, violations }
}

/** Transactions carrying no scope at all — invisible to every scoped total. */
async function fetchUntagged(): Promise<any[]> {
  const res = await irisFetch(`/api/v1/atlas/transactions?per_page=500`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const rows: any[] = firstArray(body?.data?.data, body?.data)
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
      .option("force", {
        type: "boolean",
        default: false,
        describe: "write despite a policy violation — the override is recorded on the row",
      })
      .option("bloq", { type: "number" })
      .option("paid-from", {
        type: "string",
        describe: "the account that actually paid, when different from --scope — e.g. a business ad bought on a personal card (#182036)",
      })
      .option("dry-run", { type: "boolean", default: false })
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

    // ── policy gate (#181986) ────────────────────────────────────────────────
    // Checked BEFORE the write. A row that arrives uncategorised can be fixed
    // later only if someone notices, and the evidence is that nobody does: it
    // matches no budget, and every screen keeps reporting healthy.
    const amountCents = Math.round(amount * 100)
    const scopeStr = String(args.scope)
    const draft = { amount_cents: amountCents, description, category, scope: scopeStr }
    const { blocked, violations } = await checkPolicyOrBlock(scopeStr, draft, { force: args.force })
    if (blocked) {
      prompts.outro("Done")
      return
    }

    const body: Record<string, any> = {
      type: args.revenue ? "revenue" : "expense",
      description,
      amount_cents: amountCents,
      transaction_date: date,
      source: args.source ?? "manual",
      metadata: { scope: args.scope },
    }
    // The override travels ON the row. An out-of-policy transaction that looks
    // identical to a compliant one makes the policy unauditable after the fact.
    if (violations.length > 0 && args.force) {
      body.metadata.policy_override = violations.map((v) => v.code)
      body.metadata.policy_overridden_at = new Date().toISOString()
    }
    if (args["paid-from"]) body.metadata.paid_from = args["paid-from"]
    if (category) body.category = category
    if (accountId != null) body.account_id = accountId
    if (args.bloq != null) body.bloq_id = args.bloq

    if (args["dry-run"]) {
      prompts.log.info("Dry run — nothing written")
      console.log(`  ${args.revenue ? "+" : "-"}${fmtCents(body.amount_cents)}  ${bold(description)}`)
      console.log("  " + dim([args.scope, category ?? "uncategorized", date].join("  ·  ")))
      if (args["paid-from"] && args["paid-from"] !== args.scope)
        console.log("  " + dim(`reimbursable: ${args.scope} owes ${args["paid-from"]}`))
      prompts.outro("Done")
      return
    }

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
    if (violations.length > 0 && args.force) {
      prompts.log.warn(
        `Written with --force over ${violations.length} policy violation(s): ${violations.map((v) => v.code).join(", ")} — recorded on the row.`,
      )
    }
    const meta = [args.scope, category ?? dim("uncategorized"), date]
    if (accountId != null) meta.push(`acct #${accountId}`)
    else if (category) meta.push(dim("no matching account"))
    console.log("  " + dim(meta.join("  ·  ")))
    if (args["paid-from"] && args["paid-from"] !== args.scope)
      console.log("  " + dim(`reimbursable: ${args.scope} owes ${args["paid-from"]} — see: iris mint reimbursable`))

    // Immediate feedback against the budget this just hit — the whole point of
    // capture is seeing the number move, not filing a row.
    if (category) {
      const spendGroups = await fetchGroups(String(args.scope))
      // Include GROUP budgets whose members contain this category — otherwise
      // moving a budget onto a group silently removes the feedback line that is
      // the entire reason to log spend from a terminal.
      const budgets = (await fetchBudgets(args.scope)).filter(
        (b) => b.active && budgetCategories(b, spendGroups).includes(category),
      )
      for (const b of budgets) {
        const [from, to] = periodWindow(b.period)
        const spent = await actualCentsMulti(budgetCategories(b, spendGroups), args.scope, from, to)
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

    const listGroups = await fetchGroups(args.scope)
    printDivider()
    for (const b of budgets) {
      const cap = Math.round(Number(b.cap ?? 0) * 100)
      const floor = Math.round(Number(b.floor ?? 0) * 100)
      const range = floor > 0 ? `${fmtCents(floor)}–${fmtCents(cap)}` : fmtCents(cap)
      const flag = b.active ? "" : dim("  (inactive)")
      console.log(`  ${bold(b.name ?? b.external_id)}  ${dim(`${b.scope} · ${b.period}`)}  ${range}${flag}`)
      const cats = budgetCategories(b, listGroups)
      if (b.group) {
        if (!groupResolves(b, listGroups)) {
          console.log("    " + `⚠ group "${b.group}" does not exist or is inactive — this budget measures NOTHING`)
        } else {
          console.log("    " + dim(`group ${b.group} → ${cats.join(", ")}`))
        }
      } else if (b.category) {
        console.log("    " + dim(`category ${b.category}`))
      } else {
        console.log("    " + dim("bound to neither a category nor a group — measures nothing"))
      }
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
    const statusGroups = await fetchGroups(String(args.scope))
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

    // A budget bound to a group that does not exist measures NO categories, so
    // it reports $0 spent and looks like the healthiest row on the screen. That
    // is the one shape on this page that must never be quiet.
    for (const r of rows.filter((x) => !x.group_resolves)) {
      prompts.log.error(
        `"${r.name}" is bound to group "${r.group}", which does not exist or is inactive — it measures NOTHING. The $0.00 below is not a low number, it is an absent one.`,
      )
    }
    // Overlapping groups double-count: the same dollars land in two budgets,
    // each correct alone, and the total stops tying to the ledger.
    for (const o of overlappingCategories(statusGroups)) {
      prompts.log.warn(
        `category "${o.category}" belongs to ${o.groups.length} active groups (${o.groups.join(", ")}) — its spend is counted in each`,
      )
    }
    // The same hazard one level up, and the one groups newly introduce: a group
    // budget and a legacy category budget can both cover a category. Each row
    // reads correctly on its own; only the TOTAL is wrong, which is the hardest
    // kind of wrong to notice.
    for (const o of overlappingBudgets(
      (await fetchBudgets(String(args.scope))).filter((b) => b.active),
      statusGroups,
    )) {
      prompts.log.warn(
        `"${o.category}" is covered by ${o.budgets.length} active budgets (${o.budgets.join(", ")}) — those dollars are counted in each, so the TOTAL double-counts them`,
      )
    }

    printDivider()
    for (const r of rows) {
      const binding = r.group ? dim(`  group:${r.group}`) : r.category ? dim(`  ${r.category}`) : ""
      console.log(`  ${bold(r.name)}${binding}  ${dim(`${r.from} → ${r.to}`)}`)
      if (!r.group_resolves) {
        console.log("    " + dim(`measures 0 categories — unresolved group "${r.group}"`))
        continue
      }
      if (r.cap_cents <= 0) {
        console.log("    " + dim("no cap set — cannot compare") + `  (spent ${fmtCents(r.spent_cents)})`)
        continue
      }
      const warn = r.pct >= 100 ? " ⚠ OVER" : r.pct >= 80 ? " ⚠" : ""
      console.log(
        `    ${bar(r.pct)} ${String(Math.round(r.pct)).padStart(3)}%  ${fmtCents(r.spent_cents)} / ${fmtCents(r.cap_cents)}  ${dim(`${fmtCents(r.remaining_cents)} left`)}${warn}`,
      )
      // The breakdown is the point of a group — a cap that fits while one member
      // eats all of it is a different situation from an evenly spread one.
      for (const pc of r.per_category ?? []) {
        console.log(`      ${dim("·")} ${String(pc.category).padEnd(18)} ${dim(fmtCents(pc.cents))}`)
      }
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

/**
 * Backfill metadata.paid_from onto existing rows (#182036) — the account that
 * actually paid, when it differs from the scope (books) the row counts
 * against. Same shape as ScopeCommand: it exists for the exact same reason —
 * historical rows cannot be fixed by changing what NEW rows write.
 */
const PaidFromCommand = cmd({
  command: "paid-from <scope>",
  describe: "tag transactions with who actually paid, when different from --scope — `iris mint paid-from personal --tx 42`",
  builder: (y) =>
    y
      .positional("scope", { type: "string", describe: "personal | business | client:<slug>" })
      .option("tx", { type: "number", array: true, describe: "transaction id(s) to tag" })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would change, write nothing" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Paid-From")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    if (!args.tx?.length) {
      prompts.log.error("Pass --tx <id> (one or more)")
      prompts.outro("Done")
      return
    }
    let targets: any[] = []
    for (const id of args.tx) {
      const res = await irisFetch(`/api/v1/atlas/transactions/${id}`)
      if (res.ok) targets.push(((await res.json()) as any)?.data)
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
        `  ${dim(`#${tx.id}`)}  ${dim(String(tx.transaction_date ?? "").slice(0, 10))}  ${fmtCents(tx.amount_cents)}  ${bold(tx.description ?? "")}  ${dim(`scope=${tx?.metadata?.scope ?? "(untagged)"}`)}`,
      )
    }
    printDivider()

    if (args["dry-run"]) {
      prompts.log.info(`Dry run — ${targets.length} transaction(s) would be tagged paid_from=${args.scope}`)
      prompts.outro("Done")
      return
    }

    let ok = 0
    for (const tx of targets) {
      const before = tx?.metadata?.paid_from ?? null
      const metadata = { ...(tx.metadata ?? {}), paid_from: args.scope }
      const res = await irisFetch(`/api/v1/atlas/transactions/${tx.id}`, {
        method: "PATCH",
        body: JSON.stringify({ metadata }),
      })
      if (res.ok) ok++
      else prompts.log.warn(`#${tx.id} failed (${res.status})`)
      await audit({
        action: "backfill",
        entity: "transaction",
        entity_id: tx.id,
        scope: String(tx?.metadata?.scope ?? ""),
        field: "metadata.paid_from",
        before: before ?? "(unset)",
        after: String(args.scope),
        amount: (Number(tx.amount_cents) || 0) / 100,
        ok: res.ok,
        reason: res.ok ? undefined : `HTTP ${res.status}`,
      })
    }
    prompts.log.success(`Tagged ${ok}/${targets.length} as paid_from=${args.scope}`)
    prompts.outro("Done")
  },
})

/**
 * Which of these two accounts owes the other, and how much (#182036). Reads
 * `metadata.paid_from` off every transaction where it differs from
 * `metadata.scope` — the books say one account, the card says another.
 */
const ReimbursableCommand = cmd({
  command: "reimbursable",
  describe: "list transactions where the paying account differs from the scope they count against",
  builder: (y) =>
    y
      .option("scope", { alias: "s", type: "string", describe: "only rows whose books-scope is this" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Reimbursable")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Reading the ledger…")
    const res = await irisFetch(`/api/v1/atlas/transactions?per_page=500&type=expense`)
    if (!res.ok) {
      spinner.stop("Could not read the ledger", 1)
      prompts.log.error(`HTTP ${res.status} — NOT a clean result. The check did not run.`)
      prompts.outro("Done")
      return
    }
    const body = (await res.json()) as any
    const rows: any[] = firstArray(body?.data?.data, body?.data)

    const found = rows
      .map((tx) => ({ tx, rec: reimbursableOf(tx) }))
      .filter((x): x is { tx: any; rec: { owed_by: string; owed_to: string } } => x.rec !== null)
      .filter((x) => (args.scope ? x.tx?.metadata?.scope === args.scope : true))
    spinner.stop(`${rows.length} row(s) examined`)

    if (args.json) {
      await writeJson(
        found.map((x) => ({
          id: x.tx.id,
          date: x.tx.transaction_date,
          description: x.tx.description,
          amount_cents: x.tx.amount_cents,
          owed_by: x.rec.owed_by,
          owed_to: x.rec.owed_to,
        })),
      )
      prompts.outro("Done")
      return
    }

    if (found.length === 0) {
      prompts.log.success("Nothing reimbursable — every row's paid_from matches its scope")
      prompts.outro("Done")
      return
    }

    const totals = new Map<string, number>()
    printDivider()
    for (const { tx, rec } of found) {
      const key = `${rec.owed_by} owes ${rec.owed_to}`
      totals.set(key, (totals.get(key) ?? 0) + (Number(tx.amount_cents) || 0))
      console.log(
        `  ${dim(String(tx.transaction_date ?? "").slice(0, 10))}  ${fmtCents(tx.amount_cents).padEnd(12)}  ${bold(String(tx.description ?? "").slice(0, 40))}  ${dim(key)}`,
      )
    }
    printDivider()
    for (const [key, cents] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${bold(fmtCents(cents))}  ${key}`)
    }
    prompts.outro("Done")
  },
})

// ── statement / CSV import ───────────────────────────────────────────────────

/**
 * RFC4180-ish CSV. Handles quoted fields containing commas and escaped quotes.
 *
 * `scope`, when given, restricts the index to that scope's rows only (client-
 * side — scope lives in metadata, not a queryable column, same as
 * `actualCents`). Without it, no scope filter is applied at all — needed by
 * the mail-receipt importer, whose rows can each carry a different resolved
 * scope via merchant mapping, so no single scope value could index them all
 * correctly. `mint import`, which imports one scope at a time, always passes
 * one (#182100): a bank/card export re-imported into two different scopes in
 * the same date window shared no dedup index before this, so a `source_ref`
 * or fingerprint collision across scopes could patch the WRONG scope's row.
 */
async function existingFingerprints(from: string, to: string, scope?: string): Promise<Set<string>> {
  const out = new Set<string>()
  const res = await irisFetch(`/api/v1/atlas/transactions?per_page=500&from=${from}&to=${to}`)
  if (!res.ok) return out
  const body = (await res.json()) as any
  const rows: any[] = firstArray(body?.data?.data, body?.data)
  for (const tx of rows) {
    if (scope && tx?.metadata?.scope !== scope) continue
    if (tx?.metadata?.fp) out.add(String(tx.metadata.fp))
    else {
      // Rows imported before fingerprinting, or added by hand, still dedup by value.
      const d = String(tx.transaction_date ?? "").slice(0, 10)
      out.add(fingerprint(d, Number(tx.amount_cents) || 0, String(tx.description ?? "")))
    }
  }
  return out
}

/**
 * Existing rows indexed by `metadata.source_ref` (#182038) — the stable-identity
 * dedup that survives a source revising its own amount, unlike `fingerprint`.
 * Only rows written WITH a source_ref are indexed; rows without one are outside
 * this mechanism entirely and keep going through `existingFingerprints` as before.
 *
 * `scope` — see existingFingerprints() above; same rationale, same #182100.
 */
async function existingBySourceRef(
  from: string,
  to: string,
  scope?: string,
): Promise<Map<string, { id: number; amount_cents: number; category?: string }>> {
  const out = new Map<string, { id: number; amount_cents: number; category?: string }>()
  const res = await irisFetch(`/api/v1/atlas/transactions?per_page=500&from=${from}&to=${to}`)
  if (!res.ok) return out
  const body = (await res.json()) as any
  const rows: any[] = firstArray(body?.data?.data, body?.data)
  for (const tx of rows) {
    if (scope && tx?.metadata?.scope !== scope) continue
    const ref = tx?.metadata?.source_ref
    // category travels with the existing row so a correction's policy check
    // (below, ImportCommand) can evaluate against the row's REAL category —
    // a correction never changes it, so treating it as "no category" would
    // false-positive require_category/declared_only on every correction.
    if (ref) out.set(String(ref), { id: tx.id, amount_cents: Number(tx.amount_cents) || 0, category: tx.category ?? undefined })
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
      .option("source-ref-col", {
        type: "string",
        describe:
          "column holding a STABLE external id (e.g. platform:account:campaign:date). Dedup keys off this instead " +
          "of date+amount+description, so a re-sync that revises the amount corrects the row instead of " +
          "duplicating it (#182038). Ignored with --group-by, since a rolled-up row has no single source row. " +
          "Rows without a value in this column fall back to the normal fingerprint dedup.",
      })
      .option("paid-from", {
        type: "string",
        describe: "the account that actually paid, when different from --scope — e.g. a business ad bought on a personal card (#182036)",
      })
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
    const refCol = args["source-ref-col"] ? pickCol(headers, [], args["source-ref-col"]) : -1
    if (di < 0 || ai < 0) {
      prompts.log.error(`Could not find a date and amount column. Headers: ${headers.join(", ")}`)
      prompts.log.info("Point at them with --date-col and --amount-col")
      prompts.outro("Done")
      return
    }
    if (args["source-ref-col"] && refCol < 0) {
      prompts.log.error(`No column named "${args["source-ref-col"]}". Headers: ${headers.join(", ")}`)
      prompts.outro("Done")
      return
    }
    console.log("  " + dim(`date=${headers[di]}  amount=${headers[ai]}  desc=${si >= 0 ? headers[si] : "(none)"}`))

    // Parse rows
    const minAmount = Number(args["min-amount"])
    let skippedSmall = 0,
      skippedBad = 0
    type Row = { date: string; amount: number; desc: string; ref?: string }
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
      const ref = refCol >= 0 ? (r[refCol] ?? "").trim() : ""
      parsed.push({ date, amount, desc: (si >= 0 ? r[si] : "") || path.basename(file), ref: ref || undefined })
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
    if (groupBy !== "none" && refCol >= 0) {
      prompts.log.warn("--source-ref-col is ignored with --group-by — a rolled-up row has no single source row")
    }
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
    const importScope = String(args.scope)
    // Scoped (#182100) — an unscoped index let a re-imported source_ref or
    // fingerprint collide across scopes and patch the wrong one's row.
    const [seen, byRef] = await Promise.all([
      existingFingerprints(dates[0], dates[dates.length - 1], importScope),
      refCol >= 0
        ? existingBySourceRef(dates[0], dates[dates.length - 1], importScope)
        : Promise.resolve(new Map<string, { id: number; amount_cents: number; category?: string }>()),
    ])

    // Rows carrying a stable source_ref (#182038) are classified fresh / duplicate
    // / correction by identity, independent of amount. Everything else keeps the
    // original value-based fingerprint dedup, unchanged.
    type Classified = Row & { cls: "fresh" | "duplicate" | "correction"; existingId?: number }
    const classified: Classified[] = items.map((i) => {
      if (i.ref) {
        const existing = byRef.get(i.ref)
        return { ...i, cls: classifySync(existing?.amount_cents, centsOf(i)), existingId: existing?.id }
      }
      const cls = seen.has(fingerprint(i.date, centsOf(i), i.desc)) ? "duplicate" : "fresh"
      return { ...i, cls }
    })
    const fresh = classified.filter((i) => i.cls === "fresh")
    const corrections = classified.filter((i) => i.cls === "correction")
    const dupes = classified.filter((i) => i.cls === "duplicate").length
    const total = fresh.reduce((s, i) => s + centsOf(i), 0)

    printDivider()
    for (const i of fresh.slice(0, 20)) console.log(`  ${dim(i.date)}  ${fmtCents(centsOf(i)).padEnd(12)}  ${i.desc}`)
    if (fresh.length > 20) console.log("  " + dim(`… ${fresh.length - 20} more`))
    for (const i of corrections.slice(0, 20))
      console.log(`  ${dim(i.date)}  ${fmtCents(centsOf(i)).padEnd(12)}  ${i.desc}  ${dim(`(correcting #${i.existingId})`)}`)
    if (corrections.length > 20) console.log("  " + dim(`… ${corrections.length - 20} more corrections`))
    printDivider()
    console.log(
      `  ${bold(String(fresh.length))} new  ·  ${bold(String(corrections.length))} corrected  ·  ` +
        `${dim(`${dupes} unchanged`)}  ·  ${bold(fmtCents(total))}`,
    )
    if (skippedSmall || skippedBad)
      console.log("  " + dim(`skipped: ${skippedSmall} under min-amount, ${skippedBad} unparseable`))

    if (args["dry-run"]) {
      prompts.log.info("Dry run — nothing written")
      prompts.outro("Done")
      return
    }
    if (fresh.length === 0 && corrections.length === 0) {
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

    // Policy gate (#182097) — fetched ONCE for the whole import, not per row:
    // this can be hundreds of rows, and each row's check only needs to
    // re-evaluate against the same policy/categories/groups, not re-fetch
    // them. `mint spend`'s force/violations plumbing (checkPolicyOrBlock)
    // reused as-is; only the fetch-once-per-run part is new here.
    const importPolicy = await fetchPolicy(importScope)
    const importKnownCategories = importPolicy ? await declaredCategories(importScope) : []
    const importGroups = importPolicy ? await fetchGroups(importScope) : []

    let ok = 0
    let policyBlocked = 0
    for (const i of fresh) {
      const draft = { amount_cents: centsOf(i), description: i.desc, category: args.category, scope: importScope }
      const { blocked } = await checkPolicyOrBlock(importScope, draft, {
        policy: importPolicy,
        knownCategories: importKnownCategories,
        groups: importGroups,
        quiet: true,
      })
      if (blocked) {
        policyBlocked++
        continue
      }
      const metadata: Record<string, any> = {
        scope: args.scope,
        fp: fingerprint(i.date, centsOf(i), i.desc),
        imported_from: path.basename(file),
      }
      if (i.ref) metadata.source_ref = i.ref
      if (args["paid-from"]) metadata.paid_from = args["paid-from"]
      const body: Record<string, any> = {
        type: args.revenue ? "revenue" : "expense",
        description: i.desc.slice(0, 500),
        amount_cents: centsOf(i),
        transaction_date: i.date,
        source: "import",
        metadata,
      }
      if (args.category) body.category = args.category
      if (args["account-id"] != null) body.account_id = args["account-id"]
      const res = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
      if (res.ok) ok++
      else prompts.log.warn(`${i.date} ${fmtCents(centsOf(i))} failed (${res.status})`)
    }
    if (policyBlocked > 0) {
      prompts.log.warn(
        `${policyBlocked} row(s) blocked by the spend policy for scope "${importScope}" — not imported. ` +
          `Re-run with the offending rows fixed, relax the policy, or import to a different scope.`,
      )
    }

    // Corrections update the ONE row a revised source_ref belongs to — never a
    // second row — and every correction is audited with before/after so a
    // revised figure stays defensible (#182038).
    let corrected = 0
    let correctionsPolicyBlocked = 0
    for (const i of corrections) {
      const before = byRef.get(i.ref!)!
      // Policy check (#182097) — category comes from the EXISTING row
      // (before.category), never args.category: a correction revises the
      // amount, not the category, so checking against the row's real
      // category is what "would this write still be allowed" actually means.
      const draft = { amount_cents: centsOf(i), category: before.category, scope: importScope }
      const { blocked } = await checkPolicyOrBlock(importScope, draft, {
        policy: importPolicy,
        knownCategories: importKnownCategories,
        groups: importGroups,
        quiet: true,
      })
      if (blocked) {
        correctionsPolicyBlocked++
        continue
      }
      const res = await irisFetch(`/api/v1/atlas/transactions/${i.existingId}`, {
        method: "PATCH",
        body: JSON.stringify({
          amount_cents: centsOf(i),
          metadata: { source_ref: i.ref, corrected_at: new Date().toISOString(), imported_from: path.basename(file) },
        }),
      })
      if (res.ok) corrected++
      else prompts.log.warn(`#${i.existingId} correction failed (${res.status})`)
      await audit({
        action: "update",
        entity: "transaction",
        entity_id: i.existingId,
        scope: String(args.scope),
        field: "amount_cents",
        before: fmtCents(before.amount_cents),
        after: fmtCents(centsOf(i)),
        amount: centsOf(i) / 100,
        ok: res.ok,
        reason: res.ok ? "source_ref_correction" : `HTTP ${res.status}`,
      })
    }

    if (correctionsPolicyBlocked > 0) {
      prompts.log.warn(
        `${correctionsPolicyBlocked} correction(s) blocked by the spend policy for scope "${importScope}" — the existing row's amount was NOT updated.`,
      )
    }

    await recordRun({
      kind: "import",
      scope: String(args.scope),
      rail: "csv",
      ok: ok === fresh.length && corrected === corrections.length,
      failures: fresh.length - ok + (corrections.length - corrected),
      candidates: items.length,
      written: ok,
      duplicates: dupes,
      amount: total / 100,
      notes:
        policyBlocked || correctionsPolicyBlocked
          ? `${path.basename(file)} — ${policyBlocked + correctionsPolicyBlocked} row(s) policy-blocked`
          : path.basename(file),
    })
    prompts.log.success(
      `Imported ${ok}/${fresh.length} new · corrected ${corrected}/${corrections.length} · ${fmtCents(total)} · scope=${args.scope}`,
    )
    prompts.outro("Done")
  },
})

// ── split ─────────────────────────────────────────────────────────────────────

/** `"campaignA=360.00,campaignB=240.00"` → [{label, cents}]. Dollars, like every other amount option here. */
function parseSplitInto(raw: string): { label: string; cents: number }[] | { error: string } {
  const parts: { label: string; cents: number }[] = []
  for (const chunk of raw.split(",")) {
    const piece = chunk.trim()
    if (!piece) continue
    const eq = piece.indexOf("=")
    if (eq < 0) return { error: `"${piece}" is not label=amount` }
    const label = piece.slice(0, eq).trim()
    const dollars = parseAmountDollars(piece.slice(eq + 1))
    if (dollars == null) return { error: `"${piece}" has no valid amount` }
    parts.push({ label, cents: Math.round(dollars * 100) })
  }
  return parts
}

const SplitCommand = cmd({
  command: "split <id>",
  describe: "divide one invoice across several categories/campaigns — `iris mint split 42 --into \"campaignA=360.00,campaignB=240.00\"`",
  builder: (y) =>
    y
      .positional("id", { type: "number", describe: "the transaction to split" })
      .option("into", { type: "string", demandOption: true, describe: "comma-separated label=amount pairs, in dollars" })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "write despite a policy violation on a split line — the override is recorded on that line",
      })
      .option("dry-run", { type: "boolean", default: false, describe: "show the plan, write nothing" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Split")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(`/api/v1/atlas/transactions/${args.id}`)
    if (!res.ok) {
      prompts.log.error(`#${args.id} not found (HTTP ${res.status})`)
      prompts.outro("Done")
      return
    }
    const parent = ((await res.json()) as any)?.data
    if (!parent) {
      prompts.log.error(`#${args.id} not found`)
      prompts.outro("Done")
      return
    }
    if (parent?.metadata?.superseded_by_split) {
      prompts.log.error(`#${args.id} was already split — see metadata.split_into`)
      prompts.outro("Done")
      return
    }
    if (parent?.metadata?.split_of) {
      prompts.log.error(`#${args.id} is itself a split line, not an invoice — split the original instead`)
      prompts.outro("Done")
      return
    }

    const parsed = parseSplitInto(String(args.into))
    if ("error" in parsed) {
      prompts.log.error(parsed.error)
      prompts.outro("Done")
      return
    }

    const plan = planSplit(Number(parent.amount_cents) || 0, parsed)
    if ("error" in plan) {
      prompts.log.error(plan.error)
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(
      `  #${parent.id}  ${fmtCents(parent.amount_cents)}  ${bold(parent.description ?? "")}  ${dim(`scope=${parent?.metadata?.scope ?? "(untagged)"}`)}`,
    )
    console.log("  " + dim("splits into:"))
    for (const p of plan) console.log(`    ${fmtCents(p.cents).padEnd(12)}  ${p.label}`)
    printDivider()

    if (args["dry-run"]) {
      prompts.log.info("Dry run — nothing written")
      prompts.outro("Done")
      return
    }

    const scope = parent?.metadata?.scope
    const splitOf = parent?.metadata?.source_ref ?? parent?.metadata?.fp ?? String(parent.id)
    const childIds: number[] = []

    // Policy gate (#182097) — fetched once for all split lines, same reason
    // as ImportCommand. An untagged parent (no scope) has no policy to check
    // against, same as everywhere else scope drives enforcement in this file.
    const splitPolicy = scope ? await fetchPolicy(String(scope)) : null
    const splitKnownCategories = splitPolicy ? await declaredCategories(String(scope)) : []
    const splitGroups = splitPolicy ? await fetchGroups(String(scope)) : []

    let ok = 0
    let policyBlocked = 0
    for (const p of plan) {
      const draft = {
        amount_cents: p.cents,
        description: `${parent.description ?? ""} — ${p.label}`,
        category: p.label,
        scope: scope ? String(scope) : undefined,
      }
      const { blocked, violations } = scope
        ? await checkPolicyOrBlock(String(scope), draft, {
            policy: splitPolicy,
            knownCategories: splitKnownCategories,
            groups: splitGroups,
            force: args.force,
          })
        : { blocked: false, violations: [] as { code: string; message: string }[] }
      if (blocked) {
        policyBlocked++
        continue
      }
      const body: Record<string, any> = {
        type: parent.type ?? "expense",
        description: `${parent.description ?? ""} — ${p.label}`.slice(0, 500),
        amount_cents: p.cents,
        transaction_date: parent.transaction_date,
        // NOT "split" — the server's source column only accepts
        // manual,qb,stripe,invoice,import,barter (AtlasTransactionController
        // validation) and rejects anything else with a 422, so every split
        // has always failed on every child line since this command was
        // written. The row's split provenance is already fully captured in
        // metadata (split_of/split_parent_id); source doesn't need to
        // duplicate it, and inventing an unlisted value here breaks the write.
        source: "manual",
        category: p.label,
        metadata: { scope, split_of: splitOf, split_parent_id: parent.id },
      }
      // Same as `mint spend`: an out-of-policy line written with --force
      // carries the override on the row, so it stays auditable after the fact.
      if (violations.length > 0 && args.force) {
        body.metadata.policy_override = violations.map((v) => v.code)
        body.metadata.policy_overridden_at = new Date().toISOString()
      }
      const cres = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
      if (cres.ok) {
        ok++
        const child = ((await cres.json()) as any)?.data
        if (child?.id != null) childIds.push(child.id)
      } else {
        prompts.log.warn(`"${p.label}" failed (${cres.status})`)
      }
      await audit({
        action: "create",
        entity: "transaction",
        scope: String(scope ?? ""),
        field: `split_of=#${parent.id}`,
        after: `${p.label} ${fmtCents(p.cents)}`,
        amount: p.cents / 100,
        ok: cres.ok,
        reason: cres.ok ? "split" : `HTTP ${cres.status}`,
      })
    }

    if (ok !== plan.length) {
      const reason = policyBlocked > 0 ? ` (${policyBlocked} blocked by the spend policy — see above)` : ""
      prompts.log.error(`Only ${ok}/${plan.length} split line(s) written${reason} — the parent was NOT marked split. Fix the failures and re-run.`)
      prompts.outro("Done")
      return
    }

    // The parent is never deleted — it stays as the audit trail for the
    // original invoice — but it must not be summed alongside its own children.
    const pres = await irisFetch(`/api/v1/atlas/transactions/${parent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        metadata: { ...(parent.metadata ?? {}), superseded_by_split: true, split_into: childIds },
      }),
    })
    await audit({
      action: "update",
      entity: "transaction",
      entity_id: parent.id,
      scope: String(scope ?? ""),
      field: "metadata.superseded_by_split",
      before: "false",
      after: "true",
      amount: (Number(parent.amount_cents) || 0) / 100,
      ok: pres.ok,
      reason: pres.ok ? "split" : `HTTP ${pres.status}`,
    })
    if (!pres.ok) {
      prompts.log.error(
        `${plan.length} split line(s) written, but marking #${parent.id} as split failed (HTTP ${pres.status}) — ` +
          `it will still be double-counted alongside its children until this is fixed.`,
      )
      prompts.outro("Done")
      return
    }

    if (args.json) {
      await writeJson({ parent_id: parent.id, children: childIds })
      prompts.outro("Done")
      return
    }
    prompts.log.success(`Split #${parent.id} into ${ok} line(s)`)
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
  const records: any[] = firstArray(body?.data?.records?.data, body?.data?.records)
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
  let messages: any[] = firstArray(result?.messages, result?.emails, result?.data)
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
      // Same defect as the document rail had, and it predates it: the extractor has
      // always returned a currency and nothing has ever read it, so a EUR email
      // receipt has been landing in the ledger as USD. Fail closed here too.
      const scanCurrency = String(ex.currency ?? "").trim().toUpperCase() || BASE_CURRENCY
      const scanFx = await convertToBase(v.amount!, scanCurrency, v.date!)
      if (!scanFx.ok) {
        quarantined.push({ subject: c.subject, reason: scanFx.reason })
        continue
      }
      const mm = merchants.find((m) => m.term === c.term)
      found.push({
        date: v.date!,
        amount: scanFx.amount,
        currency: scanCurrency,
        originalAmount: v.amount!,
        fxRate: scanFx.rate,
        fxRateDate: scanFx.rateDate,
        fxSubstituted: scanFx.substituted,
        fxSource: scanFx.source,
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
          base_currency: BASE_CURRENCY,
          currency: f.currency,
          ...(f.currency !== BASE_CURRENCY
            ? {
                original_amount: f.originalAmount,
                fx_rate: f.fxRate,
                fx_rate_date: f.fxRateDate,
                fx_rate_date_substituted: f.fxSubstituted,
                fx_source: f.fxSource,
              }
            : {}),
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

// ── currency conversion, via the platform integration ────────────────────────
/**
 * THE BUG THIS CLOSES, which was live in both rails before this existed.
 *
 * `verifyAgainstSource` gives us the amount as it appears on the document. Nothing
 * asked what CURRENCY it was in. A EUR 100 receipt produced `amount_cents: 10000`,
 * which the ledger, every budget, `mint status` and `mint verify` then treated as
 * 100 USD. Silently, and off by whatever the rate happened to be.
 *
 * FAIL CLOSED. If a rate cannot be fetched the row is QUARANTINED, never written.
 * That is not caution for its own sake: writing the foreign face value is exactly
 * the bug, so "no rate available" must not fall back to it. A held row is visible
 * and fixable; a wrong row is neither.
 *
 * The rate comes from the `currency-exchange` integration (fl-api), not from an
 * HTTP call here — CLAUDE.md's backend-centric rule, and it means agents, invoices
 * and clients get the same conversion rather than three private implementations.
 * NOTE the ordering dependency: until that integration is deployed, foreign-currency
 * rows quarantine with a message saying so. Base-currency rows are unaffected.
 */
const BASE_CURRENCY = (process.env.MINT_BASE_CURRENCY ?? "USD").toUpperCase()

type FxResult =
  | { ok: true; amount: number; rate: number; rateDate: string; substituted: boolean; source: string }
  | { ok: false; reason: string }

/** One rate per (currency, date) per run — a folder of 20 EUR bills is one lookup. */
const fxCache = new Map<string, FxResult>()

async function convertToBase(amount: number, currency: string, date: string): Promise<FxResult> {
  const from = String(currency || BASE_CURRENCY).toUpperCase()
  if (from === BASE_CURRENCY) {
    return { ok: true, amount, rate: 1, rateDate: date, substituted: false, source: "identity" }
  }
  const key = `${from}|${date}`
  const hit = fxCache.get(key)
  // Cache the RATE decision, then apply it to this row's own amount.
  if (hit) {
    return hit.ok ? { ...hit, amount: round2(amount * hit.rate) } : hit
  }
  let out: FxResult
  try {
    const r = await executeIntegrationCall("currency-exchange", "convert_amount", {
      amount: 1, from, to: BASE_CURRENCY, date,
    })
    const d = r?.data ?? r
    const rate = Number(d?.rate)
    if (!Number.isFinite(rate) || rate <= 0) {
      out = { ok: false, reason: `no usable ${from}->${BASE_CURRENCY} rate for ${date}` }
    } else {
      out = {
        ok: true,
        amount: round2(amount * rate),
        rate,
        rateDate: String(d?.rate_date ?? date),
        substituted: Boolean(d?.rate_date_substituted),
        source: String(d?.source ?? "currency-exchange"),
      }
    }
  } catch (e) {
    out = {
      ok: false,
      reason: `${from}->${BASE_CURRENCY} rate unavailable (${e instanceof Error ? e.message.slice(0, 80) : "error"})`,
    }
  }
  fxCache.set(key, out)
  return out.ok ? { ...out, amount: round2(amount * out.rate) } : out
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ── document & photo receipt rail (`mint bill`) ──────────────────────────────
/**
 * WHY THIS IS TWO STAGES AND NOT ONE VISION CALL.
 *
 * The obvious implementation hands the image to a vision model and asks for
 * {merchant, amount, date} directly. It is shorter, and it quietly destroys the
 * only check this pipeline has.
 *
 * `verifyAgainstSource` works by requiring the extracted amount to appear
 * LITERALLY in the source text — the email rail catches a model inventing 51.79
 * because 51.79 is nowhere in the email. Ask a vision model for JSON straight
 * from pixels and there IS no source text to check against. Its claim becomes
 * unfalsifiable, and the gate does not fail loudly, it just stops being a gate.
 *
 * So: stage one TRANSCRIBES (pixels -> text), stage two EXTRACTS (text -> JSON)
 * through the same extractReceipt/verifyAgainstSource pair the email rail uses.
 * The gate survives unchanged, and the transcript is stored on the row so a
 * human can see what the extractor was actually reading.
 *
 * THE LIMIT, stated because it would otherwise be mistaken for a stronger
 * guarantee: this catches the EXTRACTOR fabricating, not the TRANSCRIBER. If
 * the vision model misreads 51.97 as 51.79, the extractor copies 51.79, the
 * gate finds 51.79 in the transcript, and it passes. Quantifying that rate is
 * B-05 in epic #183767 and it is NOT done. Until it is, rows from this rail are
 * reviewable rather than trusted — which is the entire reason the transcript is
 * kept on the row instead of thrown away.
 */
let lastBillError = ""

const OCR_MODEL = "iris/gpt-4o-mini"

const OCR_PROMPT =
  "Transcribe ALL text visible in this receipt or invoice, exactly as it appears. " +
  "Preserve every number character-for-character — never round, reformat, or convert a currency. " +
  "Keep line items on their own lines. Output the transcription only: no commentary, no summary, " +
  "no markdown fences. If the image contains no legible text, output nothing."

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

/** Stage one for pixels. Returns the transcript, or null with `lastBillError` set. */
async function ocrImageToText(model: string, filePath: string, detail: string): Promise<string | null> {
  const ext = (filePath.match(/\.[^./\\]+$/)?.[0] ?? "").toLowerCase()
  const mime = BILL_IMAGE_MIME[ext] ?? "image/jpeg"
  let dataUri: string
  try {
    dataUri = `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`
  } catch (e) {
    lastBillError = `unreadable file: ${e instanceof Error ? e.message : String(e)}`
    return null
  }
  const res = await irisFetch(
    `/api/v6/openai/chat/completions`,
    {
      method: "POST",
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: OCR_PROMPT },
              { type: "image_url", image_url: { url: dataUri, detail } },
            ],
          },
        ],
      }),
    },
    IRIS_API,
  )
  if (!res.ok) {
    lastBillError = `vision HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`
    return null
  }
  const j = (await res.json()) as any
  const text = String(j?.choices?.[0]?.message?.content ?? "").trim()
  if (!text) {
    lastBillError = "vision model returned nothing"
    return null
  }
  return text
}

/**
 * PDF text layer, via `pdftotext`. Absent binary is reported, never treated as
 * an empty document — "poppler is not installed" and "this PDF has no text" are
 * different facts with different fixes, and collapsing them sends the reader to
 * the wrong one.
 */
function pdfToText(filePath: string): string | null {
  const r = spawnSync("pdftotext", ["-layout", "-q", filePath, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (r.error) {
    lastBillError =
      (r.error as any)?.code === "ENOENT"
        ? "pdftotext not installed — `brew install poppler`, or pass the bill as an image"
        : `pdftotext failed: ${r.error.message}`
    return null
  }
  if (r.status !== 0) {
    lastBillError = `pdftotext exited ${r.status}: ${String(r.stderr ?? "").slice(0, 120)}`
    return null
  }
  return String(r.stdout ?? "").trim()
}

/** Route a file to the right reader. `how` is reported so the cost is visible. */
async function readBillText(
  filePath: string,
  ocrModel: string,
  detail: string,
): Promise<{ text: string; how: "vision" | "pdf-text" | "text" } | null> {
  const kind = billKind(filePath)
  if (kind === "text") {
    try {
      return { text: fs.readFileSync(filePath, "utf8").trim(), how: "text" }
    } catch (e) {
      lastBillError = `unreadable file: ${e instanceof Error ? e.message : String(e)}`
      return null
    }
  }
  if (kind === "pdf") {
    const t = pdfToText(filePath)
    if (t === null) return null
    // A scanned PDF has a valid but EMPTY text layer. That is pixels wearing a
    // document's extension, so it falls through to vision rather than being
    // reported as an unreadable PDF.
    if (transcriptIsUsable(t)) return { text: t, how: "pdf-text" }
    lastBillError = "PDF has no usable text layer (a scan?) — export it as an image and re-run"
    return null
  }
  if (kind === "image") {
    const t = await ocrImageToText(ocrModel, filePath, detail)
    if (t === null) return null
    return { text: t, how: "vision" }
  }
  lastBillError = "unsupported file type"
  return null
}

const BillCommand = cmd({
  command: "bill <files..>",
  aliases: ["bills", "receipt"],
  describe: "read a photo or PDF of a bill into a transaction (verified, idempotent)",
  builder: (y) =>
    y
      .positional("files", { type: "string", describe: "image/PDF/text paths — let your shell expand globs" })
      .option("scope", { alias: "s", type: "string", default: DEFAULT_SCOPE })
      .option("category", { alias: "c", type: "string" })
      .option("account-id", { type: "number", describe: "chart-of-accounts id" })
      .option("model", { type: "string", default: DEFAULT_EXTRACT_MODEL, describe: "stage 2 — extraction" })
      .option("ocr-model", { type: "string", default: OCR_MODEL, describe: "stage 1 — vision transcription" })
      .option("detail", { type: "string", default: "high", describe: "vision detail: high | low | auto" })
      .option("keep-text", { type: "boolean", default: true, describe: "store the transcript on the row for audit" })
      .option("write", { type: "boolean", default: false, describe: "actually write (default is preview only)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Bill")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }
    const scope = String(args.scope ?? DEFAULT_SCOPE)
    const files = (Array.isArray(args.files) ? args.files : [args.files]).map(String).filter(Boolean)

    // REFUSED BY NAME, before a single API call is spent. A file that cannot be
    // read is a fact about the run and belongs in the output, not in silence.
    const readable: string[] = []
    const refused: { file: string; reason: string }[] = []
    for (const f of files) {
      if (!fs.existsSync(f)) refused.push({ file: f, reason: "no such file" })
      else if (!fs.statSync(f).isFile()) refused.push({ file: f, reason: "not a file" })
      else if (!billKind(f)) refused.push({ file: f, reason: `unsupported type (${path.extname(f) || "no extension"})` })
      else readable.push(f)
    }
    if (refused.length) {
      prompts.log.error(`${refused.length} of ${files.length} file(s) will NOT be read:`)
      for (const r of refused.slice(0, 10)) console.log(`    ${dim("·")} ${path.basename(r.file)}  ${dim(r.reason)}`)
      if (refused.length > 10) console.log("    " + dim(`… ${refused.length - 10} more`))
    }
    if (readable.length === 0) {
      prompts.log.warn("Nothing readable to ingest")
      await recordRun({ kind: "bill", scope, ok: false, failures: refused.length, candidates: files.length, written: 0,
        notes: `no readable files of ${files.length} given` })
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    const found: any[] = []
    const quarantined: any[] = []
    const howCount: Record<string, number> = {}
    for (let i = 0; i < readable.length; i++) {
      const f = readable[i]!
      const base = path.basename(f)
      spinner.start(`Reading ${base} (${i + 1}/${readable.length})…`)
      lastBillError = ""
      const read = await readBillText(f, String(args["ocr-model"]), String(args.detail))
      if (!read) {
        spinner.stop(`${base} — could not read`, 1)
        quarantined.push({ subject: base, reason: lastBillError || "could not read" })
        continue
      }
      howCount[read.how] = (howCount[read.how] ?? 0) + 1
      if (!transcriptIsUsable(read.text)) {
        spinner.stop(`${base} — nothing legible`, 1)
        quarantined.push({ subject: base, reason: `transcript too short to be a receipt (${read.text.length} chars)` })
        continue
      }
      const ex = await extractReceipt(String(args.model), base, read.text)
      if (!ex) {
        spinner.stop(`${base} — extraction failed`, 1)
        quarantined.push({ subject: base, reason: lastExtractError || "extraction failed" })
        continue
      }
      if (ex.is_receipt === false) {
        spinner.stop(`${base} — not a receipt`)
        quarantined.push({ subject: base, reason: "model says this is not a receipt or invoice" })
        continue
      }
      // The SAME gate the email rail uses, against the transcript as the source.
      const v = verifyAgainstSource(ex, read.text)
      if (!v.ok) {
        spinner.stop(`${base} — held for review`, 1)
        quarantined.push({ subject: base, reason: v.reason })
        continue
      }
      // CONVERT BEFORE THE ROW EXISTS. The ledger stores one currency; a foreign
      // face value written into it is wrong from the moment it lands, and nothing
      // downstream can tell. Quarantined rather than guessed at.
      const currency = String(ex.currency ?? "").trim().toUpperCase() || BASE_CURRENCY
      const fx = await convertToBase(v.amount!, currency, v.date!)
      if (!fx.ok) {
        spinner.stop(`${base} — held, no rate`, 1)
        quarantined.push({ subject: base, reason: fx.reason })
        continue
      }
      spinner.stop(
        `${base} — ${fmtCents(Math.round(fx.amount * 100))}` +
          (currency !== BASE_CURRENCY ? ` ${dim(`(${currency} ${v.amount!} @ ${fx.rate})`)}` : "") +
          ` ${dim(read.how)}`,
      )
      found.push({
        date: v.date!,
        amount: fx.amount,
        desc: (String(ex.merchant ?? "").trim() || base).slice(0, 200),
        subject: base,
        file: f,
        sha: sha256File(f),
        how: read.how,
        // BOTH sides are kept. The converted figure is what the books add up, the
        // original is what the document says, and the rate is what connects them —
        // drop any one and the number stops being auditable. ECB reference rates are
        // an estimate, not the rate a card was charged, so the statement supersedes
        // this and the original must survive to be re-converted when it does.
        currency,
        originalAmount: v.amount!,
        fxRate: fx.rate,
        fxRateDate: fx.rateDate,
        fxSubstituted: fx.substituted,
        fxSource: fx.source,
        transcript: args["keep-text"] ? read.text.slice(0, 4000) : undefined,
        category: args.category ?? undefined,
        accountId: args["account-id"] ?? undefined,
      })
    }

    if (found.length === 0 && quarantined.length === 0) {
      prompts.log.warn("Nothing extracted")
      prompts.outro("Done")
      return
    }

    // IDENTITY IS THE FILE'S BYTES, not its name and not its values. `source_ref`
    // (#182038) already gives stable identity across a revised amount, so a
    // re-run of the same photo is one row whatever it is called — and two
    // genuinely different bills from the same merchant, same day, same total
    // stay two rows, which `fingerprint` alone would have collapsed into one.
    let fresh = found
    const conflicts: any[] = []
    if (found.length) {
      const dates = found.map((f) => f.date).sort()
      const byRef = await existingBySourceRef(dates[0]!, dates[dates.length - 1]!, scope)
      fresh = []
      for (const f of found) {
        const ref = sourceRef(["bill", f.sha])
        const prior = byRef.get(ref)
        const verdict = classifySync(prior?.amount_cents, centsOf(f))
        if (verdict === "fresh") fresh.push({ ...f, ref })
        else if (verdict === "correction") {
          // Identical bytes that read to a DIFFERENT amount is not a revised
          // source — it is the transcriber being non-deterministic, which is a
          // finding about the instrument. Reported, never silently applied.
          conflicts.push({ file: f.subject, was: prior!.amount_cents, now: centsOf(f), id: prior!.id })
        }
      }
    }

    printDivider()
    for (const f of fresh)
      console.log(
        `  ${dim(f.date)}  ${fmtCents(centsOf(f)).padEnd(12)}  ${bold(f.desc)}  ${dim([f.currency, f.category ?? "uncategorised", f.how].filter(Boolean).join(" · "))}`,
      )
    if (fresh.length === 0) console.log("  " + dim("nothing new"))
    printDivider()
    const readSummary = Object.entries(howCount).map(([k, n]) => `${n} ${k}`).join(", ")
    console.log(
      `  ${bold(String(fresh.length))} new  ·  ${dim(`${found.length - fresh.length - conflicts.length} already recorded`)}  ·  ${bold(fmtCents(fresh.reduce((s, f) => s + centsOf(f), 0)))}  ${dim(`scope=${scope}${readSummary ? " · " + readSummary : ""}`)}`,
    )

    if (conflicts.length) {
      console.log("")
      prompts.log.error(
        `${conflicts.length} file(s) read to a DIFFERENT amount than the row already on file, from identical bytes.`,
      )
      for (const c of conflicts)
        console.log(`    ${dim("·")} ${c.file}  ${dim(`tx #${c.id}: ${fmtCents(c.was)} → now reads ${fmtCents(c.now)}`)}`)
      console.log("    " + dim("Not applied. Same file, two answers — check the transcript before trusting either."))
    }
    if (quarantined.length) {
      console.log("")
      console.log("  " + bold(`${quarantined.length} held for review — read but NOT verified against the source:`))
      for (const q of quarantined.slice(0, 10)) console.log(`    ${dim("·")} ${q.subject.slice(0, 60)}  ${dim(q.reason)}`)
      if (quarantined.length > 10) console.log("    " + dim(`… ${quarantined.length - 10} more`))
    }

    const runOk = refused.length === 0 && conflicts.length === 0
    if (args.json) {
      await writeJson({ fresh, quarantined, refused, conflicts })
      prompts.outro("Done")
      return
    }
    if (!args.write) {
      await recordRun({
        kind: "bill", scope, rail: "document", ok: runOk, failures: refused.length + conflicts.length,
        candidates: files.length, written: 0, duplicates: found.length - fresh.length - conflicts.length,
        quarantined: quarantined.length, amount: fresh.reduce((a, f) => a + centsOf(f), 0) / 100,
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
          scope,
          fp: fingerprint(f.date, centsOf(f), f.desc),
          source_ref: f.ref,
          imported_from: "bill-scan",
          read_as: f.how,
          base_currency: BASE_CURRENCY,
          currency: f.currency,
          ...(f.currency !== BASE_CURRENCY
            ? {
                original_amount: f.originalAmount,
                fx_rate: f.fxRate,
                fx_rate_date: f.fxRateDate,
                fx_rate_date_substituted: f.fxSubstituted,
                fx_source: f.fxSource,
              }
            : {}),
          file: f.subject.slice(0, 200),
          sha256: f.sha,
          ...(f.transcript ? { transcript: f.transcript } : {}),
        },
      }
      if (f.category) body.category = f.category
      if (f.accountId != null) body["account_id"] = f.accountId
      const res = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
      if (res.ok) ok++
    }
    await recordRun({
      kind: "bill", scope, rail: "document", ok: runOk && ok === fresh.length,
      failures: refused.length + conflicts.length + (fresh.length - ok),
      candidates: files.length, written: ok, duplicates: found.length - fresh.length - conflicts.length,
      quarantined: quarantined.length, amount: fresh.reduce((a, f) => a + centsOf(f), 0) / 100,
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
  kind: "snapshot" | "scan" | "import" | "bill"
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
  const records: any[] = firstArray(body?.data?.records?.data, body?.data?.records)
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
  const rows: any[] = firstArray(body?.data?.data, body?.data)
  const known = new Set(budgetedCats.filter(Boolean).map((c) => String(c).toLowerCase()))
  const buckets = new Map<string, number>()
  for (const tx of rows) {
    if (tx?.metadata?.scope !== scope) continue
    if (tx?.metadata?.superseded_by_split) continue // its children carry this money now (#182035)
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
  const posGroups = await fetchGroups(scope)
  const rows: any[] = []
  for (const b of budgets) {
    const [from, to] = periodWindow(b.period)
    // A group budget measures every member category, a category budget one.
    // Both go through the same path so a group cannot drift from a plain budget
    // in how its actuals are summed.
    const cats = budgetCategories(b, posGroups)
    const resolves = groupResolves(b, posGroups)
    const spent = await actualCentsMulti(cats, scope, from, to)
    const capCents = Math.round(Number(b.cap ?? 0) * 100)
    const perCategory: any[] = []
    if (b.group && resolves && cats.length > 1) {
      for (const c of cats) perCategory.push({ category: c, cents: await actualCents(c, scope, from, to) })
      perCategory.sort((x, y) => y.cents - x.cents)
    }
    rows.push({
      name: b.name,
      category: b.category,
      group: b.group ?? null,
      // Every category this row actually measures — the snapshot and the
      // unbudgeted calculation need the expanded set, not the binding.
      categories: cats,
      group_resolves: resolves,
      per_category: perCategory,
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
      // Expanded, not `r.category` — a group budget has no single category, so
      // the old form would re-report every member as unbudgeted while it was
      // ALSO counted inside the group total: the same dollars twice, both
      // looking correct alone. Guarded by a test in mint-core.test.ts.
      rows.flatMap((r) => (r.categories?.length ? r.categories : [r.category])),
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
      .option("kind", { type: "string", describe: "snapshot | scan | import | bill" })
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
      const firstB: any[] = firstArray(snaps[0].budgets)
      const lastB: any[] = firstArray(snaps[snaps.length - 1].budgets)
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
    let rows: any[] = firstArray(body?.data?.records?.data, body?.data?.records).map((r: any) => ({
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
      const raw: any[] = firstArray(body?.data?.data, body?.data)

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


// ── groups (#181985) ─────────────────────────────────────────────────────────

const GroupListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list spending groups and the categories in them",
  builder: (y) =>
    y
      .option("scope", { alias: "s", type: "string", describe: "filter by scope" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Groups")
    const token = await requireAuth()
    if (!token) return prompts.outro("Done")

    const groups = await fetchGroups(args.scope)
    if (args.json) {
      await writeJson(groups)
      return prompts.outro("Done")
    }
    if (groups.length === 0) {
      prompts.log.warn("No spending groups yet. Create one: iris mint group set food --add groceries --add household")
      return prompts.outro("Done")
    }

    const budgets = (await fetchBudgets(args.scope)).filter((b) => b.active)
    printDivider()
    for (const g of groups) {
      const cats = (g.categories ?? []).map(norm).filter(Boolean)
      const flag = g.active === false ? dim("  (inactive)") : ""
      const capped = budgets.filter((b) => norm(b.group) === norm(g.key))
      console.log(`  ${bold(String(g.name ?? g.key))}  ${dim(`key:${g.key}${g.scope ? " · " + g.scope : ""}`)}${flag}`)
      console.log(`    ${cats.length ? cats.join(", ") : dim("no categories — this group measures nothing")}`)
      // A group with no budget is a label, not a cap. Saying so is the difference
      // between "set up" and "set up and actually enforcing".
      if (capped.length === 0) console.log("    " + dim("no budget is bound to this group — it caps nothing yet"))
      else console.log("    " + dim(`capped by: ${capped.map((b) => b.name).join(", ")}`))
    }
    printDivider()
    for (const o of overlappingCategories(groups)) {
      prompts.log.warn(
        `"${o.category}" is in ${o.groups.length} active groups (${o.groups.join(", ")}) — its spend counts in each`,
      )
    }
    prompts.outro("Done")
  },
})

const GroupSetCommand = cmd({
  command: "set <key>",
  describe: "create or edit a spending group — `iris mint group set food --add groceries --add household`",
  builder: (y) =>
    y
      .positional("key", { type: "string", describe: "short stable key, e.g. food" })
      .option("name", { type: "string", describe: "display name" })
      .option("add", { type: "string", array: true, describe: "category to add (repeatable)" })
      .option("remove", { type: "string", array: true, describe: "category to remove (repeatable)" })
      .option("scope", {
        alias: "s",
        type: "string",
        default: DEFAULT_SCOPE,
        describe: "personal | business | client:<slug>",
      })
      .option("inactive", { type: "boolean", default: false, describe: "mark the group inactive" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Group")
    const token = await requireAuth()
    if (!token) return prompts.outro("Done")

    const key = norm(args.key)
    if (!key) {
      prompts.log.error("Needs a key: iris mint group set food --add groceries")
      return prompts.outro("Done")
    }
    const scopeStr = String(args.scope ?? DEFAULT_SCOPE)

    // Scoped lookup (#182098): the old code searched every scope's groups for
    // this key, so `group set food -s business ...` after `group set food -s
    // personal ...` found the PERSONAL record, unioned its categories in, and
    // relabelled it as business — silently deleting the personal group. A
    // group in a different scope with the same key is a DIFFERENT group.
    const existing = (await fetchGroupRecords(scopeStr)).find((g) => norm(g.key) === key)
    const cats = new Set((existing?.categories ?? []).map(norm).filter(Boolean))
    for (const c of (args.add ?? []).map(norm)) if (c) cats.add(c)
    for (const c of (args.remove ?? []).map(norm)) cats.delete(c)
    const categories = [...cats].sort()

    const data = {
      key,
      name: args.name ?? existing?.name ?? args.key,
      categories,
      scope: scopeStr,
      active: args.inactive ? false : (existing?.active ?? true),
    }

    // An existing record keeps whatever id it already has (upsert in place —
    // nothing already stored under a bare key gets orphaned). A NEW group is
    // written under a scope-qualified id so a same-named group in a different
    // scope can never collide with it going forward.
    const externalId = existing?.external_id ?? `${scopeStr}:${key}`
    const res = await upsertRecord("mint-groups", externalId, data)
    const ok = await handleApiError(res, "Save group")
    if (!ok) return prompts.outro("Done")

    await audit({
      action: existing ? "update" : "create",
      entity: "mint-group",
      scope: String(data.scope),
      field: `categories=${categories.join("|")}`,
      after: key,
      ok: true,
    })

    if (args.json) {
      await writeJson(data)
      return prompts.outro("Done")
    }
    console.log(`  ${bold(String(data.name))}  ${dim(`key:${key} · ${data.scope}`)}`)
    console.log(`    ${categories.length ? categories.join(", ") : dim("no categories")}`)
    if (categories.length === 0) {
      prompts.log.warn(
        "A group with no categories sums to $0 — any budget bound to it reads as healthy while measuring nothing.",
      )
    }
    prompts.outro("Done")
  },
})

const GroupRmCommand = cmd({
  command: "rm <key>",
  aliases: ["remove"],
  describe: "deactivate a spending group",
  builder: (y) =>
    y
      .positional("key", { type: "string" })
      .option("scope", {
        alias: "s",
        type: "string",
        describe: "personal | business | client:<slug> — disambiguates a key shared across scopes (#182098)",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Group")
    const token = await requireAuth()
    if (!token) return prompts.outro("Done")

    const key = norm(args.key)
    // Same-scope-first lookup as `group set` (#182098) — an unqualified key
    // can only ever mean "the one in this scope", never "whichever scope's
    // record happens to come back first".
    const existing = (await fetchGroupRecords(args.scope)).find((g) => norm(g.key) === key)
    if (!existing) {
      if (args.json) {
        await writeJson({ ok: false, key, reason: "not_found", scope: args.scope ?? null })
        return prompts.outro("Done")
      }
      prompts.log.error(`No group "${key}"${args.scope ? ` in scope "${args.scope}"` : ""}`)
      return prompts.outro("Done")
    }

    // Refuse while a budget still points here. Deactivating underneath a live
    // budget turns that budget into one measuring zero categories, which reads
    // on `mint status` as the healthiest row on the screen.
    const bound = (await fetchBudgets()).filter((b) => b.active && norm(b.group) === key)
    if (bound.length > 0) {
      if (args.json) {
        // A refusal must be machine-readable too. A script that only parses the
        // success shape reads a refusal as "no output" and carries on as though the
        // group were gone.
        await writeJson({ ok: false, key, reason: "bound_budgets", budgets: bound.map((b) => b.name) })
        return prompts.outro("Done")
      }
      prompts.log.error(`${bound.length} active budget(s) are bound to "${key}": ${bound.map((b) => b.name).join(", ")}`)
      console.log("  " + dim("Rebind or deactivate those budgets first — otherwise they would silently measure nothing."))
      return prompts.outro("Done")
    }

    const { external_id, ...existingData } = existing
    const res = await upsertRecord("mint-groups", external_id, { ...existingData, active: false })
    const ok = await handleApiError(res, "Deactivate group")
    if (!ok) return prompts.outro("Done")
    await audit({ action: "delete", entity: "mint-group", after: key, ok: true })
    if (args.json) {
      await writeJson({ ok: true, key, scope: args.scope ?? null, active: false })
      return prompts.outro("Done")
    }
    prompts.log.success(`Group "${key}" deactivated`)
    prompts.outro("Done")
  },
})

const GroupCommand = cmd({
  command: "group",
  aliases: ["groups", "g"],
  describe: "spending groups — one cap over several categories",
  builder: (y) => y.command(GroupListCommand).command(GroupSetCommand).command(GroupRmCommand).demandCommand(),
  async handler() {},
})

// ── policy (#181986) ─────────────────────────────────────────────────────────

const PolicyShowCommand = cmd({
  command: "show",
  describe: "show the spend policy for a scope",
  builder: (y) =>
    y
      .option("scope", {
        alias: "s",
        type: "string",
        default: DEFAULT_SCOPE,
        describe: "personal | business | client:<slug>",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Policy")
    const token = await requireAuth()
    if (!token) return prompts.outro("Done")

    const scope = String(args.scope)
    const policy = await fetchPolicy(scope)
    if (args.json) {
      await writeJson(policy)
      return prompts.outro("Done")
    }
    // "No policy" and "a policy that permits everything" are different states,
    // and only one of them is a decision someone made.
    if (!policy) {
      prompts.log.warn(`No spend policy for scope "${scope}" — nothing is enforced.`)
      console.log("  " + dim("Set one: iris mint policy set --require-category --require-group"))
      return prompts.outro("Done")
    }

    const p = { ...NO_POLICY, ...policy }
    const on = (b: any) => (b ? "on" : dim("off"))
    printDivider()
    console.log(`  ${bold("scope")}                 ${scope}${p.active === false ? "  " + dim("(policy inactive)") : ""}`)
    console.log(`  ${bold("require description")}   ${on(p.require_description)}`)
    console.log(`  ${bold("require category")}      ${on(p.require_category)}`)
    console.log(`  ${bold("require group")}         ${on(p.require_group)}`)
    console.log(`  ${bold("declared only")}         ${on(p.declared_only)}`)
    console.log(
      `  ${bold("max single expense")}    ${p.max_single_expense ? fmtCents(Math.round(Number(p.max_single_expense) * 100)) : dim("none")}`,
    )
    console.log(
      `  ${bold("allowed categories")}    ${(p.allowed_categories ?? []).length ? (p.allowed_categories ?? []).join(", ") : dim("any")}`,
    )
    printDivider()
    console.log("  " + dim("Checked before every `mint spend`. --force writes anyway and records the override on the row."))
    prompts.outro("Done")
  },
})

const PolicySetCommand = cmd({
  command: "set",
  describe: "set the spend policy — `iris mint policy set --require-category --require-group`",
  builder: (y) =>
    y
      .option("scope", {
        alias: "s",
        type: "string",
        default: DEFAULT_SCOPE,
        describe: "personal | business | client:<slug>",
      })
      .option("require-category", { type: "boolean", describe: "refuse an uncategorised expense" })
      .option("require-group", { type: "boolean", describe: "refuse a category that belongs to no spending group" })
      .option("require-description", { type: "boolean", describe: "refuse an empty description" })
      .option("declared-only", { type: "boolean", describe: "refuse a category that is not an account or group member" })
      .option("max-single", { type: "number", describe: "refuse a single expense above this many dollars (0 = none)" })
      .option("allow", { type: "string", array: true, describe: "allowed category (repeatable) — omit for any" })
      .option("off", { type: "boolean", default: false, describe: "deactivate the policy without deleting it" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Policy")
    const token = await requireAuth()
    if (!token) return prompts.outro("Done")

    const scope = String(args.scope)
    const existing = (await fetchPolicy(scope)) ?? {}
    // Only flags actually PASSED change — an omitted flag keeps its current
    // value rather than resetting to the default. Otherwise editing one setting
    // would silently switch every other one off.
    const pick = <T>(passed: T | undefined, prev: T | undefined, fallback: T): T =>
      passed !== undefined ? passed : prev !== undefined ? prev : fallback

    const data: Policy = {
      scope,
      require_category: pick(args["require-category"], existing.require_category, false),
      require_group: pick(args["require-group"], existing.require_group, false),
      require_description: pick(args["require-description"], existing.require_description, false),
      declared_only: pick(args["declared-only"], existing.declared_only, false),
      max_single_expense:
        args["max-single"] !== undefined
          ? Number(args["max-single"]) > 0
            ? Number(args["max-single"])
            : null
          : (existing.max_single_expense ?? null),
      allowed_categories:
        args.allow !== undefined ? (args.allow ?? []).map(norm).filter(Boolean) : (existing.allowed_categories ?? []),
      active: args.off ? false : (existing.active ?? true),
    }

    const res = await upsertRecord("mint-policy", `policy:${scope}`, data)
    const ok = await handleApiError(res, "Save policy")
    if (!ok) return prompts.outro("Done")
    await audit({ action: "update", entity: "mint-policy", scope, after: JSON.stringify(data).slice(0, 200), ok: true })

    if (args.json) {
      await writeJson(data)
      return prompts.outro("Done")
    }
    prompts.log.success(`Policy saved for scope "${scope}"`)
    // Turning enforcement on says nothing about rows already written. Point at
    // doctor rather than letting someone assume the ledger now complies.
    if (data.active !== false && (data.require_category || data.require_group || data.declared_only)) {
      console.log("  " + dim("This applies to NEW writes. For rows already in the ledger: iris mint doctor"))
    }
    prompts.outro("Done")
  },
})

const PolicyCommand = cmd({
  command: "policy",
  describe: "spend policy — required fields and limits, enforced before a write",
  builder: (y) => y.command(PolicyShowCommand).command(PolicySetCommand).demandCommand(),
  async handler() {},
})

// ── doctor (#181986) ─────────────────────────────────────────────────────────

const DoctorCommand = cmd({
  command: "doctor",
  describe: "list ledger rows that would fail the current spend policy",
  builder: (y) =>
    y
      .option("scope", {
        alias: "s",
        type: "string",
        default: DEFAULT_SCOPE,
        describe: "personal | business | client:<slug>",
      })
      .option("limit", { type: "number", default: 500, describe: "rows to examine" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Mint Doctor")
    const token = await requireAuth()
    if (!token) return prompts.outro("Done")

    const scope = String(args.scope)
    const policy = await fetchPolicy(scope)
    if (!policy) {
      prompts.log.warn(`No spend policy for scope "${scope}" — there is nothing to check against.`)
      console.log("  " + dim("Set one first: iris mint policy set --require-category"))
      return prompts.outro("Done")
    }

    const spinner = prompts.spinner()
    spinner.start("Checking the ledger…")
    const perPage = Math.min(500, Number(args.limit) || 500)
    const res = await irisFetch(`/api/v1/atlas/transactions?per_page=${perPage}&type=expense`)
    if (!res.ok) {
      // A failed fetch is not a clean ledger. Reporting "0 violations" here is
      // the exact false-green this ticket exists to remove.
      spinner.stop("Could not read the ledger", 1)
      prompts.log.error(`HTTP ${res.status} — NOT a clean result. The check did not run.`)
      return prompts.outro("Done")
    }
    const body = (await res.json()) as any
    // A split parent (#182035) is superseded by its children — they are what
    // should be checked against policy now, not the original invoice row.
    const rows: any[] = firstArray(body?.data?.data, body?.data).filter(
      (tx: any) => tx?.metadata?.scope === scope && !tx?.metadata?.superseded_by_split,
    )

    const [known, groups] = await Promise.all([declaredCategories(scope), fetchGroups(scope)])
    const findings: any[] = []
    for (const tx of rows) {
      const draft = {
        amount_cents: Number(tx.amount_cents) || 0,
        description: String(tx.description ?? ""),
        category: String(tx.category ?? ""),
        scope,
      }
      const v = [...evaluatePolicy(draft, policy, known), ...groupViolations(draft, policy, groups)]
      if (v.length > 0)
        findings.push({
          id: tx.id,
          date: tx.transaction_date,
          description: draft.description,
          amount_cents: draft.amount_cents,
          category: draft.category,
          violations: v,
        })
    }
    spinner.stop(`${rows.length} row(s) examined`)

    if (args.json) {
      await writeJson({ scope, examined: rows.length, violations: findings })
      return prompts.outro("Done")
    }
    if (rows.length === 0) {
      // Zero rows is not zero violations — it is an unmeasured ledger. The same
      // distinction `mint verify` gets wrong today (#181947).
      prompts.log.warn(`No transactions in scope "${scope}" — nothing was checked. That is not a pass.`)
      return prompts.outro("Done")
    }
    if (findings.length === 0) {
      prompts.log.success(`All ${rows.length} row(s) satisfy the policy`)
      return prompts.outro("Done")
    }

    printDivider()
    for (const f of findings.slice(0, 50)) {
      console.log(
        `  ${dim(String(f.date ?? "").slice(0, 10))} ${fmtCents(f.amount_cents).padStart(10)}  ${bold(String(f.description).slice(0, 40))}  ${dim(f.category || "(uncategorised)")}`,
      )
      for (const v of f.violations) console.log(`      ${dim("·")} ${v.message}`)
    }
    if (findings.length > 50) console.log("  " + dim(`… and ${findings.length - 50} more`))
    printDivider()
    const byCode = new Map<string, number>()
    for (const f of findings) for (const v of f.violations) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1)
    for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${code}`)
    }
    prompts.log.error(`${findings.length} of ${rows.length} row(s) would fail the current policy`)
    prompts.outro("Done")
  },
})

// ============================================================================
export const PlatformMintCommand = productCommand({
  name: "mint",
  purpose: "Mint — budgets vs actuals for personal and business money",
  keywords: ["mint", "budget", "actuals", "spend", "money", "finance", "scenario", "ledger", "bill", "bills", "receipt", "receipts", "invoice", "ocr"],
  howtos: ["track-finances-atlas-ledger"],
  builder: (y) =>
    y
      .command(SpendCommand)
      .command(BudgetsCommand)
      .command(StatusCommand)
      .command(ScopeCommand)
      .command(PaidFromCommand)
      .command(ReimbursableCommand)
      .command(ImportCommand)
      .command(SplitCommand)
      .command(ScanCommand)
      .command(BillCommand)
      .command(GroupCommand)
      .command(PolicyCommand)
      .command(DoctorCommand)
      .command(MerchantsCommand)
      .command(SnapshotCommand)
      .command(TrendCommand)
      .command(AuditCommand)
      .command(VerifyCommand)
      .command(ScenarioCommand)
      .demandCommand(),
})
