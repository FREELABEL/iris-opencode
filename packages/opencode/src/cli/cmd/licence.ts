import { writeFile } from "node:fs/promises"
import { firstArray } from "../../util/array"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, handleApiError, printDivider, printKV, dim, writeJson, isJsonMode, emitJsonError, resolveUserId } from "./iris-api"
import { productCommand } from "./product-command"

/**
 * `iris licence` / `iris reachr licence` — issue, claim and check entitlement.
 *
 * WHY IT IS MOUNTED TWICE. A licence is what a yes produces, so it belongs to the acquisition arc
 * Reachr owns:
 *
 *     offers    what you are selling
 *     list/apply how it reaches somebody
 *     licence   what a yes produces      <- this
 *
 * But billing and support reach for licences without ever touching outreach, and making them
 * learn that it lives inside the outreach product would be a taxonomy nobody guesses. One
 * definition, two doors — the same call the offers command makes.
 *
 * WHY IT EXISTS AT ALL. LicenseService and eleven actions shipped reachable only from
 * `php artisan license:manage`, so a production shell was the only door. Nothing in the CLI,
 * nothing for an agent, nothing in the capability index — `iris find licence` returned nothing at
 * all. The server routes landed with this change; this is the client half.
 *
 * OPERATOR ACTIONS ARE GATED SERVER-SIDE, not here. `issue`, `list` and `revoke` return 404 to a
 * non-operator by design — a licence endpoint that confirms it exists to the wrong caller is an
 * invitation. So a plain "not found" from those is the expected answer for most people, and the
 * renderer says that rather than implying the key was wrong.
 */

const BASE = "/api/v1/licences"

/** Operator refusal reads as absence by design; say so instead of blaming the input. */
async function reportError(res: Response, action: string): Promise<void> {
  if (res.status === 404) {
    const message = `${action}: not found — this is also what a non-operator sees. If you expected access, you are not on the operator list.`
    if (isJsonMode()) emitJsonError(message, { status: 404, action })
    else prompts.log.warn(message)
    process.exitCode = 1
    return
  }
  await handleApiError(res, action)
}

const money = (cents: unknown) => `$${(Number(cents ?? 0) / 100).toFixed(2)}`

/** What the end of a licence is, in words. A subscription has a period, not an expiry. */
export function endDate(d: any): string {
  if (d?.expires_at) return String(d.expires_at).slice(0, 10)
  if (d?.current_period_end) return `renews; period ends ${String(d.current_period_end).slice(0, 10)}`
  return "none set"
}

export function allowanceLine(d: any): string {
  return Number(d?.allowance_cents ?? 0) > 0 ? `${money(d.allowance_used_cents)} used of ${money(d.allowance_cents)}` : "none"
}

export function inviteWords(status: string): string {
  if (status === "assigned") return "seat assigned"
  if (status === "already_held") return "already holds a seat"
  if (status === "invited") return "named, seat reserved until they claim with this confirmed address"
  if (status === "already_invited") return "already named, seat still reserved"
  return status
}

/** A seat list as text: holders, then who is reserved for, then who used to hold one. */
export function seatLines(d: any): string[] {
  const person = (s: any) => String(s.email ?? `user #${s.user_id}`).padEnd(36)
  const day = (v: unknown) => String(v ?? "").slice(0, 10) || "—"
  const lines = [
    `  seats      ${d?.occupied ?? 0} of ${d?.seats ?? "—"} held, ${firstArray(d?.pending).length} reserved`,
    `  owner      ${d?.owner_email ?? "—"}`,
    `  ends       ${endDate(d)}`,
    `  allowance  ${allowanceLine(d)}`,
    `  claims     ${d?.claim_domain ? `named people and @${d.claim_domain}` : d?.named_only ? "named people only" : "anyone with the key"}`,
    "",
  ]
  for (const s of firstArray(d?.holders)) lines.push(`  seat ${String(s.seat_id).padEnd(8)} ${person(s)} last active ${day(s.last_active)}${s.lead_id ? `  lead #${s.lead_id}` : ""}`)
  for (const p of firstArray(d?.pending)) lines.push(`  reserved      ${person(p)} not claimed yet`)
  for (const s of firstArray(d?.released)) lines.push(dim(`  seat ${String(s.seat_id).padEnd(8)} ${person(s)} released ${day(s.released_at)}`))
  return lines
}

/** At issue: says the pool is monthly and shared, which is what the operator is deciding. */
export function monthlyAllowanceLine(cents: unknown, seats: unknown): string {
  return `${money(cents)} per month, shared by ${seats ?? "all"} seat(s)`
}

export function seatCapLine(cents: unknown): string {
  return cents === null || cents === undefined ? "none" : `${money(cents)} per seat per month`
}

/**
 * #191993: the pool is not a ceiling. An empty pool falls through to the seat's tier caps, so an
 * operator who reads --allowance as a limit can quote a maximum cost that does not exist.
 */
export function poolRunsOutLine(allowanceCents: unknown, seatCapCents: unknown): string | undefined {
  if (!(Number(allowanceCents ?? 0) > 0)) return undefined
  if (seatCapCents === null || seatCapCents === undefined) {
    return "seats keep working and spending, up to their plan tier's caps. Nothing on this licence stops them sooner"
  }
  return `seats keep working and spending, until a seat reaches its ${money(seatCapCents)} monthly seat cap or its plan tier's caps`
}

/** Set when an allowance could be read as a limit and no seat cap is there to be one. */
export function allowanceWarning(allowanceCents: unknown, seatCapCents: unknown): string | undefined {
  if (!(Number(allowanceCents ?? 0) > 0) || (seatCapCents !== null && seatCapCents !== undefined)) return undefined
  return `The ${money(allowanceCents)} allowance is not a spending limit. Spend can go past it, up to each seat's plan tier caps. Only a seat cap (--seat-cap) stops a seat sooner.`
}

/**
 * Who claimed, who is active, what each seat spent (#191945). A pure function of the API's `usage`
 * block so it can be tested without a server. Empty when talking to a server without one.
 */
export function usageLines(usage: any): string[] {
  if (!usage) return []
  const lines = [
    `${usage.seats_claimed} of ${usage.seats_total} seats claimed, ${usage.seats_unclaimed} unclaimed, ${usage.seats_active_this_month} active in ${usage.period}`,
    `pool ${money(usage.allowance_used_cents_this_month)} of ${money(usage.allowance_cents_per_month)} used this month  ·  seat cap ${seatCapLine(usage.seat_cap_cents)}`,
  ]
  for (const s of firstArray(usage.seats) as any[]) {
    const who = String(s.email ?? `user ${s.user_id}`).padEnd(32)
    const spend = `${money(s.spend_cents_this_month)} this month, ${money(s.spend_cents_total)} total`
    const when = s.released_at
      ? `released ${String(s.released_at).slice(0, 10)}`
      : s.last_active_at
        ? `last active ${String(s.last_active_at).slice(0, 10)}`
        : "not active yet"
    lines.push(`${who} ${spend}  ·  ${when}${s.at_cap ? "  ·  AT CAP" : ""}`)
  }
  return lines
}

export const IssueCmd = cmd({
  command: "issue",
  describe: "mint a licence key (operator only)",
  builder: (y: any) =>
    y
      .option("email", { describe: "who it is issued to", type: "string" })
      .option("tier", { describe: "starter | pro | business", type: "string", default: "starter" })
      .option("seats", { describe: "how many people may hold it", type: "number", default: 1 })
      .option("allowance", {
        describe: "NOT a spending limit: when this pool runs out, seats keep spending up to their plan tier's caps; only --seat-cap stops a seat sooner. CENTS PER MONTH, one pool shared by every seat (it refills each month; one seat can use all of it unless --seat-cap is set)",
        type: "number",
        default: 0,
      })
      .option("seat-cap", {
        describe: "limit in CENTS PER MONTH for each seat; a seat at its limit is refused while the others carry on, so total spend can reach this times the seats (a call already running finishes, and refusal can lag up to a minute). Default: no limit",
        type: "number",
      })
      .option("days", { describe: "expire this many days from now", type: "number" })
      .option("note", { describe: "what was actually agreed, in words", type: "string" })
      .option("owner", { describe: "who owns it: an account's exact address", type: "string" })
      .option("domain", { describe: "let anyone confirmed at this domain claim", type: "string" })
      .option("lead", { describe: "CRM lead this licence belongs to (shows on the lead)", type: "number" })
      .option("allow", { describe: "only these people may claim it (comma-separated emails). Left out, anyone with the key can", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    // JSON has no NaN: `--days abc` would reach the server as null and get the default term.
    if (Number.isNaN(args.days)) {
      const message = "--days must be a number"
      if (isJsonMode()) emitJsonError(message)
      else prompts.log.error(message)
      process.exitCode = 1
      return
    }

    const body: Record<string, unknown> = {
      email: args.email,
      tier: args.tier,
      seats: args.seats,
      allowance_cents: args.allowance,
    }
    // #191947: not a truthiness check. 0 dropped here came back as the server's default, a year.
    if (args.days !== undefined) body.days = args.days
    if (args.allow) body.allowed_emails = String(args.allow).split(",").map((e) => e.trim()).filter(Boolean)
    if (args.seatCap !== undefined) body.seat_cap_cents = args.seatCap
    if (args.note) body.note = args.note
    if (args.owner) body.owner_email = args.owner
    if (args.domain) body.claim_domain = args.domain
    // #189718: the API has accepted lead_id since #183598; the CLI never sent it.
    if (args.lead) body.lead_id = args.lead

    const res = await irisFetch(BASE, { method: "POST", body: JSON.stringify(body) })
    if (!res.ok) return reportError(res, "Issue licence")

    const data = ((await res.json()) as any)?.data
    const warning = allowanceWarning(data?.allowance_cents, data?.seat_cap_cents)
    if (args.json) return writeJson(warning ? { ...data, warning } : data)

    UI.empty()
    prompts.intro("◈  Licence issued")
    printDivider()
    printKV("key", String(data?.key ?? "—"))
    printKV("tier", String(data?.tier ?? "—"))
    printKV("seats", String(data?.seats ?? "—"))
    printKV("allowance", monthlyAllowanceLine(data?.allowance_cents, data?.seats))
    printKV("seat cap", seatCapLine(data?.seat_cap_cents))
    const poolOut = poolRunsOutLine(data?.allowance_cents, data?.seat_cap_cents)
    if (poolOut) printKV("pool runs out", poolOut)
    printKV("expires", data?.expires_at ? String(data.expires_at) : "never")
    printDivider()
    if (warning) prompts.log.warn(warning)
    // The key is the credential. Say where it goes rather than leaving someone to guess.
    prompts.outro(dim("Name the people: iris licence invite <key> <email...>   ·   then: iris licence send <key> <email...>"))
  },
})

export const ClaimCmd = cmd({
  command: "claim <key>",
  describe: "claim a licence key for yourself",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/claim`, { method: "POST", body: JSON.stringify({ key: args.key }) })
    const body = (await res.json().catch(() => ({}))) as any

    // #191949: a refusal is an answer, but a script still has to be able to tell it was a no.
    if (!res.ok) process.exitCode = 1
    if (args.json) return writeJson(body)

    // A refusal here is an ANSWER, not a fault — already claimed, expired, no seats left. It is
    // rendered as the reason it is, because "claim failed" would send someone to check the key.
    if (!res.ok) {
      prompts.log.warn(body?.reason ?? body?.error ?? `Could not claim (HTTP ${res.status})`)
      return
    }

    prompts.log.success(`Claimed — ${body?.license?.tier ?? "licence"} active`)
  },
})

const MeCmd = cmd({
  command: "me",
  aliases: ["check"],
  describe: "what you are entitled to",
  builder: (y: any) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/me`)
    if (!res.ok) return reportError(res, "Check licence")

    const data = ((await res.json()) as any)?.data
    if (args.json) return writeJson(data)

    UI.empty()
    prompts.intro("◈  Your licence")
    printDivider()
    if (!data || data.active === false || !data.license) {
      // No licence is a RESULT. Rendering it as an empty table would read as a broken lookup.
      UI.println("  No active licence on this account.")
      prompts.outro(dim("Have a key? iris licence claim <key>   ·   No key? iris pricing"))
      return
    }
    printKV("tier", String(data.license?.tier ?? "—"))
    printKV("status", String(data.license?.status ?? "—"))
    printKV("seats", `${data.license?.seats ?? "—"}`)
    printKV("expires", data.license?.expires_at ? String(data.license.expires_at) : "never")
    printDivider()
    prompts.outro(dim("iris licence me --json for the machine-readable form"))
  },
})

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list licences (operator only)",
  builder: (y: any) =>
    y
      .option("status", { describe: "filter by status", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const qs = args.status ? `?status=${encodeURIComponent(args.status)}` : ""
    const res = await irisFetch(`${BASE}${qs}`)
    if (!res.ok) return reportError(res, "List licences")

    const page = ((await res.json()) as any)?.data
    const rows: any[] = firstArray(page?.data)
    if (args.json) return writeJson(page)

    UI.empty()
    prompts.intro("◈  Licences")
    printDivider()
    if (rows.length === 0) {
      UI.println("  None issued yet.")
    }
    for (const r of rows) {
      UI.println(`  ${String(r.key).padEnd(24)} ${String(r.tier).padEnd(9)} ${String(r.status).padEnd(10)} ${r.issued_to_email ?? dim("—")}`)
    }
    printDivider()
    prompts.outro(dim(`${rows.length} shown`))
  },
})

export const RevokeCmd = cmd({
  command: "revoke <key>",
  describe: "revoke a licence (operator only)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/revoke`, { method: "POST" })
    if (!res.ok) return reportError(res, "Revoke licence")
    const body = (await res.json().catch(() => ({}))) as any
    if (args.json) return writeJson(body)
    if (body?.already_revoked) return prompts.log.info(`${args.key} was already revoked`)
    prompts.log.success(`Revoked ${args.key}`)
  },
})

// #189718 — join a key that was already issued (and maybe already sent) to its CRM lead,
// instead of revoking it and sending the person a different key.
export const LinkCmd = cmd({
  command: "link <key>",
  describe: "link an issued licence to its CRM lead (operator only)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).option("lead", { describe: "CRM lead id", type: "number", demandOption: true }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/link`, {
      method: "POST",
      body: JSON.stringify({ lead_id: args.lead }),
    })
    if (!res.ok) return reportError(res, "Link licence")
    prompts.log.success(`Linked ${args.key} → lead #${args.lead}`)
  },
})

// #191943 — one command to keep a licence going. Seats and the people on them are untouched.
export const RenewCmd = cmd({
  command: "renew <key>",
  // #191970: same operation, same audit event ("renewed"), same refusals. One route, two words.
  aliases: ["extend"],
  describe: "extend a licence's end date, keeping its seats and holders (operator only)",
  builder: (y: any) =>
    y
      .positional("key", { type: "string" })
      .option("days", { describe: "days to add (counted from today if it has already expired)", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/renew`, {
      method: "POST",
      body: JSON.stringify({ days: args.days }),
    })
    if (res.status === 422) {
      // The server's refusal is the answer: Stripe-backed, revoked, no end date, or bad days.
      const body = (await res.json().catch(() => ({}))) as any
      prompts.log.warn(body?.error ?? body?.message ?? "Could not renew (HTTP 422)")
      process.exitCode = 1
      return
    }
    if (!res.ok) {
      process.exitCode = 1
      return reportError(res, "Renew licence")
    }

    const data = ((await res.json()) as any)?.data
    if (args.json) return writeJson(data)
    prompts.log.success(`Renewed ${args.key} to ${String(data?.expires_at ?? "—").slice(0, 10)}. Seats kept.`)
  },
})

// #191940 — name who a licence is for. The first call turns an open licence into a named one;
// anyone already on a seat keeps it.
export const AllowCmd = cmd({
  command: "allow <key> <emails..>",
  describe: "only these people, added to any already named, may claim it (operator only)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).positional("emails", { type: "string", array: true }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/allow`, {
      method: "POST",
      body: JSON.stringify({ emails: args.emails }),
    })
    if (!res.ok) return reportError(res, "Allow on licence")
    const body = (await res.json().catch(() => ({}))) as any
    prompts.log.success(`May claim ${args.key}: ${firstArray(body?.data?.allowed_emails).join(", ")}`)
  },
})

export const ReleaseCmd = cmd({
  command: "release <key> <email>",
  describe: "take one person's seat back, leaving everyone else alone (operator only)",
  builder: (y: any) =>
    y
      .positional("key", { type: "string" })
      .positional("email", { type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/seats/release`, {
      method: "POST",
      body: JSON.stringify({ email: args.email }),
    })
    if (res.status === 404) return reportError(res, "Release seat")
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok) process.exitCode = 1
    if (args.json) return writeJson(body)
    if (!res.ok) {
      prompts.log.warn(body?.error ?? body?.message ?? `Could not release (HTTP ${res.status})`)
      return
    }
    prompts.log.success(`${args.email} released from ${args.key}`)
    if (body?.key_still_open) {
      prompts.log.warn(`The key still works for anyone who has it, ${args.email} included. To stop that: iris licence allow ${args.key} <emails..>`)
    }
  },
})

export const ShowCmd = cmd({
  command: "show <key>",
  describe: "one licence with its seats and audit trail (operator only)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}`)
    if (!res.ok) return reportError(res, "Show licence")

    const data = ((await res.json()) as any)?.data
    const poolOut = poolRunsOutLine(data?.usage?.allowance_cents_per_month, data?.usage?.seat_cap_cents)
    if (args.json) return writeJson(poolOut ? { ...data, pool_runs_out: poolOut } : data)

    UI.empty()
    prompts.intro(`◈  ${data?.key ?? args.key}`)
    printDivider()
    printKV("tier", String(data?.tier ?? "—"))
    printKV("status", String(data?.end_state ?? data?.status ?? "—"))
    printKV("issued to", String(data?.issued_to_email ?? "—"))
    printKV("lead", data?.lead_id ? `#${data.lead_id}` : "— (iris licence link <key> --lead <id>)")
    printDivider()
    if (data?.end_state === "expired") {
      UI.println(`  Expired: nobody on it has access. Seats are kept. iris licence renew ${data.key} --days <n>`)
      printDivider()
    }
    // Holders, end date and allowance come from the seat view, so show and seats cannot disagree.
    const seatsRes = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/seats`)
    if (seatsRes.ok) for (const l of seatLines(((await seatsRes.json()) as any)?.data)) UI.println(l)
    else prompts.log.warn(`Could not read the seats (HTTP ${seatsRes.status})`)
    printDivider()
    const usage = usageLines(data?.usage)
    if (usage.length) {
      for (const line of usage) UI.println(`  ${line}`)
      if (poolOut) UI.println(`  when the pool runs out: ${poolOut}`)
      printDivider()
    }
    for (const e of data?.events ?? []) {
      UI.println(dim(`  ${String(e.created_at ?? "").slice(0, 19)}  ${e.event}`))
    }
    prompts.outro(dim("iris licence show <key> --json for everything"))
  },
})

/** #191935 #191940 — name who may hold the seats. Operator only: this grants entitlement to someone else. */
const InviteCmd = cmd({
  command: "invite <key> <emails..>",
  describe: "name people on a licence (operator only). Limits the key to them. Sends nothing: see licence send",
  builder: (y: any) =>
    y
      .positional("key", { type: "string" })
      .positional("emails", { type: "string", array: true })
      .option("lead", { describe: "this person's CRM lead (one email only)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/seats`, {
      method: "POST",
      body: JSON.stringify({ emails: args.emails, ...(args.lead ? { lead_id: args.lead } : {}) }),
    })
    if (res.status === 404) return reportError(res, "Invite to licence")
    const body = (await res.json().catch(() => ({}))) as any
    if (args.json) return writeJson(body)
    if (!res.ok) {
      process.exitCode = 1
      prompts.log.warn(body?.reason ?? body?.message ?? `Could not invite (HTTP ${res.status})`)
      return
    }
    for (const r of body?.data?.results ?? []) UI.println(`  ${r.email}: ${inviteWords(r.status)}`)
    printKV("seats", `${body?.data?.occupied ?? "—"} of ${body?.data?.seats ?? "—"} held, ${body?.data?.pending ?? 0} reserved`)
  },
})

const SeatsCmd = cmd({
  command: "seats <key>",
  describe: "who holds which seat, last active, end date and allowance (the licence's owner or an operator)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/seats`)
    if (!res.ok) return reportError(res, "List seats")
    const data = ((await res.json()) as any)?.data
    if (args.json) return writeJson(data)
    UI.empty()
    prompts.intro(`◈  ${args.key}`)
    for (const l of seatLines(data)) UI.println(l)
    prompts.outro(dim("iris licence release <key> <email>"))
  },
})

/** POST one small operator change and say what the server said. */
async function operatorPost(key: string, path: string, payload: unknown, action: string, done: string): Promise<void> {
  const res = await irisFetch(`${BASE}/${encodeURIComponent(key)}/${path}`, { method: "POST", body: JSON.stringify(payload) })
  if (res.status === 404) return reportError(res, action)
  const body = (await res.json().catch(() => ({}))) as any
  if (!res.ok) {
    process.exitCode = 1
    prompts.log.warn(body?.reason ?? body?.message ?? `${action} failed (HTTP ${res.status})`)
    return
  }
  prompts.log.success(done)
}

const OwnerCmd = cmd({
  command: "owner <key> <email>",
  describe: "choose who owns a licence; grants no seat (operator only)",
  builder: (y: any) => y.positional("key", { type: "string" }).positional("email", { type: "string" }),
  handler: (args: any) => operatorPost(args.key, "owner", { email: args.email }, "Set owner", `${args.email} owns ${args.key}`),
})

const DomainCmd = cmd({
  command: "domain <key> [domain]",
  describe: "let anyone confirmed at one domain claim; --off to stop (operator only)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).positional("domain", { type: "string" }).option("off", { type: "boolean", default: false }),
  async handler(args: any) {
    if (!args.off && !args.domain) {
      process.exitCode = 1
      prompts.log.warn("Name a domain, or pass --off.")
      return
    }
    await operatorPost(args.key, "domain", { domain: args.off ? null : args.domain }, "Set claim domain", args.off ? `Domain claim off for ${args.key}` : `${args.domain} may claim ${args.key}`)
  },
})

const SeatLeadCmd = cmd({
  command: "seat-lead <key> <seat>",
  describe: "link one seat to its CRM lead (operator only)",
  builder: (y: any) =>
    y
      .positional("key", { type: "string" })
      .positional("seat", { type: "number" })
      .option("lead", { describe: "CRM lead id", type: "number", demandOption: true }),
  handler: (args: any) => operatorPost(args.key, `seats/${args.seat}/lead`, { lead_id: args.lead }, "Link seat", `Seat ${args.seat} → lead #${args.lead}`),
})

const SendCmd = cmd({
  command: "send <key> <emails..>",
  describe: "preview the licence message for named people; --send delivers it, logged to their lead (operator only)",
  builder: (y: any) =>
    y
      .positional("key", { type: "string" })
      .positional("emails", { type: "string", array: true })
      .option("send", { describe: "actually send. Without this nothing leaves", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}/send`, {
      method: "POST",
      body: JSON.stringify({ emails: args.emails, send: args.send === true }),
    })
    if (res.status === 404) return reportError(res, "Send licence")
    const body = (await res.json().catch(() => ({}))) as any
    if (args.json) return writeJson(body)
    if (!res.ok) {
      process.exitCode = 1
      prompts.log.warn(body?.reason ?? body?.message ?? `Could not send (HTTP ${res.status})`)
      return
    }
    for (const r of body?.data?.results ?? []) {
      printDivider()
      if (r.status === "preview") {
        UI.println(`  To: ${r.email}\n  Subject: ${r.subject}\n`)
        UI.println(String(r.text))
      } else if (r.status === "sent") prompts.log.success(`${r.email}: sent (comm #${r.comm_id}${r.lead_activity ? `, logged to lead #${r.lead_id}` : ", NOT logged to a lead"})`)
      else if (r.status === "not_named") prompts.log.warn(`${r.email}: not named on this licence, nothing sent. iris licence invite first`)
      else {
        process.exitCode = 1
        prompts.log.warn(`${r.email}: not sent: ${r.error ?? r.status}`)
      }
    }
    if (body?.data?.sent !== true) prompts.outro(dim("Preview only, nothing was sent. Add --send to deliver."))
  },
})

// #191969 — one link for a chosen plan. The server reads the price and seats from the catalogue.
export const PayLinkCmd = cmd({
  command: "pay-link",
  describe: "one payment or invoice link; once paid, the named people move to the paid licence (operator only)",
  builder: (y: any) =>
    y
      .option("plan", { describe: "plan key: solo, team or scale", type: "string", demandOption: true })
      .option("people", { describe: "emails of who moves", type: "string", array: true, demandOption: true })
      .option("from", { describe: "trial licence keys they move from", type: "string", array: true, demandOption: true })
      .option("billing-email", { describe: "who pays", type: "string", demandOption: true })
      .option("organization", { describe: "company on the paid licence", type: "string" })
      .option("invoice", { describe: "an invoice link instead of a card checkout", type: "boolean", default: false })
      .option("days-until-due", { describe: "invoice terms in days (default 30)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/conversions`, {
      method: "POST",
      body: JSON.stringify({
        plan: args.plan,
        method: args.invoice ? "invoice" : "checkout",
        people: args.people,
        from: args.from,
        billing_email: args.billingEmail,
        organization: args.organization,
        days_until_due: args.daysUntilDue,
      }),
    })
    if (res.status === 404) {
      process.exitCode = 1
      return reportError(res, "Create payment link")
    }
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok) {
      process.exitCode = 1
      if (args.json) return writeJson(body)
      prompts.log.warn(body?.error ?? body?.message ?? `Could not create the link (HTTP ${res.status})`)
      return
    }
    if (args.json) return writeJson(body?.data)
    const d = body?.data
    prompts.log.success(`${money(d?.amount_cents)} per month, ${d?.seats} seats, ${firstArray(d?.people).length} moving on payment`)
    UI.println(`  ${d?.link_url}`)
    if (d?.link_expires_at) UI.println(dim(`  link good until ${String(d.link_expires_at).slice(0, 10)}. Check it: iris licence pay-status ${d?.id}`))
  },
})

export const PayStatusCmd = cmd({
  command: "pay-status <id>",
  describe: "whether a payment link was paid, and why if it was refused (operator only)",
  builder: (y: any) =>
    y.positional("id", { type: "number" }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/conversions/${encodeURIComponent(args.id)}`)
    if (!res.ok) {
      process.exitCode = 1
      return reportError(res, "Read payment link")
    }
    const d = ((await res.json()) as any)?.data
    if (args.json) return writeJson(d)
    UI.println(`  ${d?.status}  ${d?.plan_key}  ${money(d?.amount_cents)}${d?.paid_license_key ? `  ${d.paid_license_key}` : ""}`)
    if (d?.refusal) {
      process.exitCode = 1
      prompts.log.warn(`Refused: ${d.refusal}. Nobody moved. Money may have been taken: check Stripe.`)
    }
  },
})

/** One CSV line. Handles quoted fields, which a company name with a comma needs. */
function csvCells(line: string): string[] {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cell += '"'
      i++
    } else if (ch === '"') quoted = !quoted
    else if (ch === "," && !quoted) {
      cells.push(cell.trim())
      cell = ""
    } else cell += ch
  }
  return [...cells, cell.trim()]
}

const BULK_COLUMNS = ["email", "lead", "seat_cap", "allow", "organization"]

/**
 * #191971 — people.csv: email,lead,seat_cap,allow,organization. Only email is needed as a column.
 * allow is ;-separated. A bad value goes to the server as written, so it is reported on its row.
 */
export function parseBulkCsv(text: string): { rows: any[] } | { error: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return { error: "The file needs a header line and at least one person." }
  const header = csvCells(lines[0].replace(/^\uFEFF/, "")).map((h) => h.toLowerCase())
  const unknown = header.filter((h) => !BULK_COLUMNS.includes(h))
  if (unknown.length) return { error: `Unknown column: ${unknown.join(", ")}. Use: ${BULK_COLUMNS.join(", ")}.` }
  if (!header.includes("email")) return { error: "The file needs an email column." }
  const rows = lines.slice(1).map((line) => {
    const cells = csvCells(line)
    const at = (name: string) => cells[header.indexOf(name)] || undefined
    const row: Record<string, unknown> = { email: at("email") ?? "" }
    const number = (v: string) => (/^\d+$/.test(v) ? Number(v) : v)
    if (at("lead")) row.lead_id = number(at("lead")!)
    if (at("seat_cap")) row.seat_cap_cents = number(at("seat_cap")!)
    if (at("allow")) row.allow = at("allow")!.split(";").map((e) => e.trim()).filter(Boolean)
    if (at("organization")) row.organization = at("organization")
    return row
  })
  return { rows }
}

/** A lead as a bulk row: its own address and id. No address reaches the server as a row problem. */
export function leadToBulkRow(lead: any): { email: string; lead_id: number } {
  return { email: String(lead?.email ?? lead?.contact_info?.email ?? "").trim(), lead_id: lead?.id }
}

/** Enough to tell keys apart. The key is the credential, so reports and logs never hold it. */
export function maskKey(key: unknown): string {
  const parts = String(key ?? "").split("-")
  return parts.length > 1 ? `${parts[0]}-****-${parts[parts.length - 1]}` : "—"
}

export function bulkRowLine(r: any): string {
  const who = `${String(r.row).padStart(3)}  ${String(r.email || "(no email)").padEnd(36)}`
  const lead = r.lead_id ? `  lead #${r.lead_id}` : ""
  if (r.status === "problem") return `${who} PROBLEM: ${firstArray(r.problems).join("; ")}`
  if (r.status === "would_issue") return `${who} would issue${lead}  seat cap ${seatCapLine(r.seat_cap_cents)}`
  if (r.status === "issued") return `${who} issued ${maskKey(r.key)}${lead}`
  const differs = firstArray(r.differs).length ? `  differs from the list: ${firstArray(r.differs).join(", ")}, left as it is` : ""
  return `${who} already has ${maskKey(r.key)}, skipped${differs}`
}

/** Every page of a lead list, so a list of 60 is not silently a list of 50. */
async function allPages(url: (page: number) => string, read: (body: any) => { leads: any[]; last: number }): Promise<any[] | undefined> {
  const leads: any[] = []
  for (let page = 1; ; page++) {
    const res = await irisFetch(url(page))
    if (!res.ok) {
      await handleApiError(res, "Read the people")
      process.exitCode = 1
      return undefined
    }
    const got = read(await res.json())
    leads.push(...got.leads)
    if (page >= got.last) return leads
  }
}

async function bulkRowsFrom(args: any): Promise<any[] | undefined> {
  const sources = [args.file, args.segment, args.tag].filter((v) => v !== undefined)
  const refuse = (message: string) => {
    process.exitCode = 1
    if (isJsonMode() || args.json) emitJsonError(message)
    else prompts.log.warn(message)
    return undefined
  }
  if (sources.length !== 1) return refuse("Name the people one way: --file, --segment or --tag.")

  if (args.file !== undefined) {
    const text = await Bun.file(String(args.file)).text().catch(() => undefined)
    if (text === undefined) return refuse(`Could not read ${args.file}`)
    const parsed = parseBulkCsv(text)
    return "error" in parsed ? refuse(parsed.error) : parsed.rows
  }

  let leads: any[] | undefined
  if (args.segment !== undefined) {
    const userId = await resolveUserId()
    if (!userId) return refuse("Could not resolve your user id")
    leads = await allPages(
      (p) => `/api/v1/users/${userId}/lead-segments/${encodeURIComponent(args.segment)}/leads?per_page=100&page=${p}`,
      (b) => ({ leads: firstArray(b?.leads), last: Number(b?.pagination?.last_page ?? 1) }),
    )
  } else {
    leads = await allPages(
      (p) => `/api/v1/leads?per_page=100&page=${p}&tag=${encodeURIComponent(args.tag)}`,
      (b) => ({ leads: firstArray(b?.data?.data, b?.data), last: Number(b?.data?.last_page ?? 1) }),
    )
  }
  if (leads === undefined) return undefined
  if (leads.length === 0) return refuse("Nobody matched, so there is nothing to issue.")
  return leads.map(leadToBulkRow)
}

// #191971 — one licence per person. Preview by default; --yes issues. Sends nothing.
export const IssueBulkCmd = cmd({
  command: "issue-bulk",
  describe: "issue one named licence per person from a file, segment or tag. Previews unless --yes. Safe to re-run. Sends nothing (operator only)",
  builder: (y: any) =>
    y
      .option("file", { describe: "CSV with columns email,lead,seat_cap,allow,organization (only email is required; allow is ;-separated)", type: "string" })
      .option("segment", { describe: "lead segment id: everyone in it, using each lead's email", type: "number" })
      .option("tag", { describe: "lead tag name: everyone carrying it, using each lead's email", type: "string" })
      .option("seat-cap", { describe: "limit in CENTS PER MONTH for each seat. A seat_cap column overrides it per person. Default: no limit", type: "number" })
      .option("allow", { describe: "also name these people on every licence (comma-separated). Each person is always named on their own. Needs --seats to fit them", type: "string" })
      .option("tier", { describe: "starter | pro | business", type: "string", default: "starter" })
      .option("seats", { describe: "seats on each licence", type: "number", default: 1 })
      .option("allowance", { describe: "NOT a spending limit. CENTS PER MONTH, one pool per licence", type: "number", default: 0 })
      .option("days", { describe: "expire this many days from now", type: "number" })
      .option("note", { describe: "what was actually agreed, in words", type: "string" })
      .option("organization", { describe: "the company these licences belong to", type: "string" })
      .option("unlinked", { describe: "allow people with no CRM lead. Without this, a row with no lead is a problem", type: "boolean", default: false })
      .option("keys-file", { describe: "write email and key here, readable only by you. Must not exist yet. Keys are never printed", type: "string" })
      .option("yes", { describe: "actually issue. Without this nothing changes", type: "boolean", default: false })
      .option("json", { describe: "JSON output, with keys masked", type: "boolean", default: false }),
  async handler(args: any) {
    const refuse = (message: string) => {
      process.exitCode = 1
      if (args.json) emitJsonError(message)
      else prompts.log.warn(message)
    }
    if (args.seatCap !== undefined && Number.isNaN(args.seatCap)) return refuse("--seat-cap must be a number")
    if (Number.isNaN(args.days)) return refuse("--days must be a number")
    // Before anything is issued: finding this after would leave keys with nowhere to go.
    if (args.keysFile && (await Bun.file(String(args.keysFile)).exists())) return refuse(`${args.keysFile} already exists. Nothing was issued.`)

    const rows = await bulkRowsFrom(args)
    if (!rows) return

    const common: Record<string, unknown> = { rows, tier: args.tier, seats: args.seats, allowance_cents: args.allowance, allow_unlinked: args.unlinked === true }
    if (args.seatCap !== undefined) common.seat_cap_cents = args.seatCap
    if (args.days !== undefined) common.days = args.days
    if (args.note) common.note = args.note
    if (args.organization) common.organization = args.organization
    if (args.allow) common.allow = String(args.allow).split(",").map((e) => e.trim()).filter(Boolean)

    const post = (confirm: boolean) => irisFetch(`${BASE}/bulk`, { method: "POST", body: JSON.stringify({ ...common, confirm }) })
    const report = (body: any) => {
      const shown = firstArray(body?.rows).map((r: any) => (r.key ? { ...r, key: maskKey(r.key) } : r))
      if (args.json) return writeJson({ issued: body?.issued === true, counts: body?.counts, rows: shown, ...(body?.reason ? { reason: body.reason } : {}) })
      for (const r of firstArray(body?.rows)) UI.println(bulkRowLine(r))
    }

    // Always preview first, so --yes never issues a list that was not checked.
    const previewRes = await post(false)
    if (previewRes.status === 404) {
      process.exitCode = 1
      return reportError(previewRes, "Issue licences")
    }
    const preview = (await previewRes.json().catch(() => ({}))) as any
    if (!previewRes.ok) {
      process.exitCode = 1
      await report(preview)
      if (!args.json) prompts.log.warn(preview?.reason ?? (firstArray(preview?.rows).length ? "Problems found. Nothing was issued. Fix the rows above and run it again." : (preview?.message ?? `Refused (HTTP ${previewRes.status}). Nothing was issued.`)))
      return
    }
    if (!args.yes) {
      await report(preview)
      if (!args.json) prompts.outro(dim(`Preview: ${preview?.counts?.would_issue ?? 0} to issue, ${preview?.counts?.already_issued ?? 0} already have one. Nothing changed. Add --yes to issue.`))
      return
    }

    const res = await post(true)
    if (res.status === 404) {
      process.exitCode = 1
      return reportError(res, "Issue licences")
    }
    const body = (await res.json().catch(() => ({}))) as any
    if (args.keysFile && res.ok) {
      const lines = firstArray(body?.rows).filter((r: any) => r.key).map((r: any) => `${r.email},${r.key},${r.status}`)
      await writeFile(String(args.keysFile), `email,key,status\n${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" }).catch((e: any) => {
        process.exitCode = 1
        prompts.log.error(`The licences were issued but ${args.keysFile} could not be written (${e?.message}). Run this again with a new --keys-file: nobody gets a second key.`)
      })
    }
    await report(body)
    if (!res.ok) {
      process.exitCode = 1
      if (!args.json) prompts.log.warn(body?.reason ?? "Problems found. Nothing was issued.")
      return
    }
    if (!args.json) prompts.outro(dim(`${body?.counts?.issued ?? 0} issued, ${body?.counts?.already_issued ?? 0} already had one. Nothing sent. Safe to re-run.`))
  },
})

/** The subcommand group, so `iris reachr licence …` and `iris licence …` are one thing. */
export const LicenceGroup = cmd({
  command: "licence",
  aliases: ["license", "licences", "licenses"],
  describe: "what a yes produces — issue, claim and check entitlement",
  builder: (y: any) =>
    y.command(IssueCmd).command(IssueBulkCmd).command(ClaimCmd).command(MeCmd).command(ListCmd).command(ShowCmd).command(LinkCmd).command(RenewCmd).command(AllowCmd).command(InviteCmd).command(SeatsCmd).command(ReleaseCmd).command(OwnerCmd).command(DomainCmd).command(SeatLeadCmd).command(SendCmd).command(PayLinkCmd).command(PayStatusCmd).command(RevokeCmd).demandCommand(),
  async handler() {},
})

/** Top-level sibling — billing and support reach licences without going through Reachr. */
export const LicenceCommand = productCommand({
  name: "licence",
  aliases: ["license", "licences", "licenses", "licensing"],
  purpose: "Licences — issue a key, claim one, check what you are entitled to",
  keywords: ["licence", "license", "licensing", "key", "seat", "seats", "entitlement", "claim", "activate", "trial"],
  howtos: ["claim-a-licence", "team-licences"],
  playbooks: [],
  builder: (yargs: any) =>
    yargs
      .command(IssueCmd)
      .command(IssueBulkCmd)
      .command(ClaimCmd)
      .command(MeCmd)
      .command(ListCmd)
      .command(ShowCmd)
      .command(LinkCmd)
      .command(RenewCmd)
      .command(AllowCmd)
      .command(InviteCmd)
      .command(SeatsCmd)
      .command(ReleaseCmd)
      .command(OwnerCmd)
      .command(DomainCmd)
      .command(SeatLeadCmd)
      .command(SendCmd)
      .command(PayLinkCmd)
      .command(PayStatusCmd)
      .command(RevokeCmd)
      .demandCommand(),
})
