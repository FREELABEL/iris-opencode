import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, printDivider, printKV } from "./iris-api"
import {
  readPayments,
  filterPayments,
  sortPayments,
  paginate,
  summarise,
  reconcile,
  type Payment,
} from "../lib/payments"
import { loadIdentities, applyIdentities, groupByIdentity, resolveIdentity } from "../lib/identity"

/**
 * `iris imessage payments` (#178595).
 *
 * Apple Cash transfers were invisible to the CLI: lib/imessage.ts requires a
 * text body (:227 in SQL, :298 in the parser) and a payment has none, so 149 of
 * them sat in chat.db while the CLI reported nothing. That is how a real $50
 * payout to Flo went missing for days.
 *
 * The AMOUNT IS NOT IN THE DATABASE and this command never pretends otherwise —
 * no totals, and the JSON says so explicitly. It answers "who did I pay, when,
 * and what did I say it was for", which is what reconciliation actually needs.
 *
 * Distinct from `iris payments <lead-id>` (platform-payments.ts), which is
 * Stripe.
 */

function fmtRow(p: Payment): string {
  const arrow = p.direction === "sent" ? "→" : "←"
  const who = (p.contact ?? p.handle).padEnd(22)
  const ref = p.reference ? bold(p.reference) : dim("(unlabelled)")
  // The drift that broke attachment: the label names one person, the money
  // reached a different card. Surface it inline rather than burying it.
  const mismatch =
    p.claimedRecipient && p.contact && p.claimedRecipient.toLowerCase() !== p.contact.toLowerCase()
      ? `  ⚠ label says "${p.claimedRecipient}"`
      : ""
  return `  ${p.date.replace("T", " ")}  ${arrow}  ${who} ${ref}${mismatch}`
}

export const ImessagePaymentsCommand = cmd({
  command: "payments",
  aliases: ["cash", "pay"],
  describe: "find and filter Apple Cash payments (Apple does not store the amount)",
  builder: (yargs) =>
    yargs
      .option("contact", { describe: "filter by contact name or number (partial, case-insensitive)", type: "string" })
      .option("sent", { describe: "only payments you sent", type: "boolean", default: false })
      .option("received", { describe: "only payments you received", type: "boolean", default: false })
      .option("since", { describe: "on or after YYYY-MM-DD", type: "string" })
      .option("until", { describe: "on or before YYYY-MM-DD", type: "string" })
      .option("reference", { describe: "filter by label reference, e.g. 001", type: "string" })
      .option("unlabelled", { describe: "only payments with no label — the reconciliation backlog", type: "boolean", default: false })
      .option("labelled", { describe: "only payments carrying a label", type: "boolean", default: false })
      .option("sort", { describe: "sort key", choices: ["date", "contact", "reference"], default: "date" })
      .option("order", { describe: "sort order", choices: ["asc", "desc"], default: "desc" })
      .option("limit", { describe: "rows per page", type: "number", default: 25 })
      .option("offset", { describe: "skip N rows", type: "number", default: 0 })
      .option("days", { describe: "how far back to search", type: "number", default: 365 })
      .option("check", { describe: "report reconciliation issues instead of rows", type: "boolean", default: false })
      .option("by-person", { describe: "group by resolved identity instead of listing rows", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const started = Date.now()
    const res = readPayments({ days: args.days, limit: 5000 })

    if (!res.available) {
      if (args.json) console.log(JSON.stringify({ success: false, error: res.reason }))
      else { UI.empty(); prompts.log.warn(res.reason ?? "Messages unavailable") }
      process.exitCode = 1
      return
    }

    const direction = args.sent ? "sent" : args.received ? "received" : undefined
    const labelled = args.labelled ? true : args.unlabelled ? false : undefined

    // Stamp the canonical identity onto every payment (#178599). The contact
    // card that actually received the money is preserved — unifying must not
    // erase which card was paid, because that is the reconciliation evidence.
    const identities = loadIdentities()
    const identified = applyIdentities(res.payments, identities)

    // Searching by contact must reach EVERY alias of that person. "Flo" has to
    // return the payment that landed on the "Flozzel Smith" card, which is the
    // exact miss that hid a real $50.
    let pool = identified
    if (args.contact) {
      const hit = resolveIdentity(identities, { name: args.contact, handle: args.contact })
      if (hit) pool = identified.filter((p) => p.identityId === hit.id)
    }

    const matched = filterPayments(
      // When an identity matched, the contact filter has already been applied
      // across all of its aliases; re-applying it here would re-narrow to one card.
      pool as Payment[],
      {
        contact: pool === identified ? args.contact : undefined,
        direction: direction as "sent" | "received" | undefined,
        since: args.since,
        until: args.until,
        reference: args.reference,
        labelled,
      },
    ) as typeof identified

    const sorted = sortPayments(matched, { sort: args.sort as any, order: args.order as any })
    const page = paginate(sorted, { limit: args.limit, offset: args.offset })
    const stats = summarise(matched)
    const issues = reconcile(matched)
    const elapsed = Date.now() - started

    if (args.json) {
      console.log(JSON.stringify({
        success: true,
        // Stated outright so a consumer never reads a missing amount as zero.
        amount_available: false,
        amount_note: "Apple does not store Apple Cash amounts in the Messages database.",
        total: page.total,
        returned: page.items.length,
        has_more: page.hasMore,
        scanned_messages: res.messagesScanned,
        elapsed_ms: elapsed,
        summary: stats,
        issues: args.check ? issues : undefined,
        payments: page.items,
      }, null, 2))
      return
    }

    UI.empty()
    prompts.intro(`◈  iMessage Payments${args.contact ? ` — ${args.contact}` : ""}`)

    if (args.check) {
      printDivider()
      if (issues.length === 0) {
        prompts.log.info(`${success("✓")} No reconciliation issues across ${stats.count} payment(s).`)
      } else {
        for (const i of issues) prompts.log.warn(`[${i.kind}] ${i.detail}`)
      }
      printDivider()
      prompts.outro(dim(`${issues.length} issue(s) · ${elapsed}ms`))
      return
    }

    if (args["by-person"]) {
      const groups = groupByIdentity(matched)
      printDivider()
      for (const g of groups) {
        const cards = g.handles.length > 1 ? dim(`  (${g.handles.length} numbers)`) : ""
        console.log(`  ${String(g.count).padStart(4)}  ${bold(g.name)}${g.identityId ? "" : dim(" — unresolved")}${cards}`)
      }
      printDivider()
      printKV("People", groups.length)
      printKV("Payments", matched.length)
      prompts.outro(dim(`unresolved rows group by handle · iris identity suggest`))
      return
    }

    if (page.items.length === 0) {
      prompts.log.info("No payments matched.")
      prompts.outro(dim(`searched ${res.payments.length} payment(s) · ${elapsed}ms`))
      return
    }

    printDivider()
    for (const p of page.items) console.log(fmtRow(p))
    printDivider()
    printKV("Showing", `${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`)
    printKV("Sent / received", `${stats.sent} / ${stats.received}`)
    // Never render a total — the amount genuinely is not available.
    printKV("Amounts", dim("not stored by Apple — the label is what records intent"))
    if (issues.length) printKV("Issues", `${issues.length}  (see --check)`)

    prompts.outro(
      dim(`scanned ${res.messagesScanned} messages in ${elapsed}ms${page.hasMore ? ` · next: --offset ${page.offset + page.limit}` : ""}`),
    )
  },
})
