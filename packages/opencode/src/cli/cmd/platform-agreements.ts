import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight, writeJson } from "./iris-api"

// NDAs, BAAs and the rest — epic #179757.
//
// The shape worth preserving: `waitingDays`, `live` and `expiringSoon` are computed by the
// API, not here. The dashboard component and this command both read the same numbers, because
// two surfaces each deriving "outstanding" from raw dates will eventually disagree in front of
// a client.
//
// Signing is deliberately NOT a command. The value of the audit chain is that the signature is
// attributable to the person who gave it, and an operator running a flag is not that person.

interface LedgerRow {
  id: number
  type: string
  counterparty: string
  org?: string | null
  email?: string | null
  status: string
  tier: string
  issuedAt?: string | null
  executedAt?: string | null
  expiryDate?: string | null
  documentHash?: string | null
  signingUrl?: string | null
  partyLinks?: Array<{ role: string; name?: string | null; status: string; url: string }>
  partiesTotal?: number
  partiesSigned?: number
  waitingOn?: string | null
  live?: boolean
  waitingDays?: number | null
  expiringSoon?: boolean
}

function stateLabel(r: LedgerRow): string {
  if (r.status === "executed" && r.expiringSoon) return "EXPIRING"
  if (r.status === "executed") return "EXECUTED"
  if (r.status === "revoked") return "REVOKED"
  if (r.status === "sent" || r.status === "opened") return "AWAITING"
  return r.status.toUpperCase()
}

function shortHash(h?: string | null): string {
  return h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "—"
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list agreements and what is still outstanding",
  builder: (y) =>
    y
      .option("status", { type: "string", describe: "draft | sent | opened | executed | revoked" })
      .option("type", { type: "string", describe: "nda | baa" })
      .option("subject", { type: "string", describe: "filter by subject_ref" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Agreements")
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const qs = new URLSearchParams()
    if (args.status) qs.set("status", String(args.status))
    if (args.type) qs.set("type", String(args.type))
    if (args.subject) qs.set("subject", String(args.subject))
    const suffix = qs.toString() ? `?${qs}` : ""

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    const res = await irisFetch(`/api/v1/agreements${suffix}`)
    if (!res.ok) {
      spinner.stop("Failed")
      await handleApiError(res, "load agreements")
      prompts.outro("Failed")
      return
    }
    const body = (await res.json()) as { summary: Record<string, number>; agreements: LedgerRow[] }
    spinner.stop(`${body.agreements.length} agreement(s)`)

    if (args.json) {
      await writeJson(body)
      prompts.outro("Done")
      return
    }

    if (body.agreements.length === 0) {
      prompts.log.info("No agreements match.")
      prompts.outro("Done")
      return
    }

    const s = body.summary
    printDivider()
    console.log(
      `  ${bold(String(s.awaiting))} awaiting   ${bold(String(s.executed))} executed   ` +
        `${bold(String(s.expiringSoon))} expiring ≤30d   ${bold(String(s.revoked))} revoked`,
    )
    printDivider()

    for (const r of body.agreements) {
      // The wait is the number this list exists for, so it sits immediately after the state
      // rather than being something you work out from the dates further along the row.
      const wait =
        r.waitingDays === null || r.waitingDays === undefined
          ? ""
          : r.waitingDays >= 7
            ? `  ${bold(`${r.waitingDays}d waiting`)}`
            : `  ${dim(`${r.waitingDays}d waiting`)}`

      console.log(
        `  ${dim(`#${r.id}`)}  ${bold(r.counterparty.slice(0, 26).padEnd(26))} ` +
          `${dim(r.type.padEnd(4))} ${highlight(stateLabel(r).padEnd(9))}${wait}`,
      )
      const detail = [
        r.org ? r.org : null,
        // Half-signed is a different situation from not-started and needs different chasing.
        r.partiesTotal && r.partiesTotal > 1
          ? `${r.partiesSigned ?? 0}/${r.partiesTotal} signed${r.waitingOn ? ` — waiting on ${r.waitingOn}` : ""}`
          : null,
        r.executedAt ? `executed ${r.executedAt}` : null,
        r.expiryDate ? `expires ${r.expiryDate}` : null,
        r.documentHash ? `seal ${shortHash(r.documentHash)}` : null,
      ].filter(Boolean)
      if (detail.length) console.log(`       ${dim(detail.join("  ·  "))}`)
    }
    printDivider()
    prompts.outro(dim("iris agreements show <id>   ·   iris agreements link <id>"))
  },
})

const ShowCommand = cmd({
  command: "show <id>",
  aliases: ["get"],
  describe: "one agreement with its full audit trail",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Agreement #${args.id}`)
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    const res = await irisFetch(`/api/v1/agreements/${args.id}`)
    if (!res.ok) {
      spinner.stop("Failed")
      await handleApiError(res, "load agreement")
      prompts.outro("Failed")
      return
    }
    const body = (await res.json()) as any
    spinner.stop("Loaded")

    if (args.json) {
      await writeJson(body)
      prompts.outro("Done")
      return
    }

    const a = body.agreement
    printDivider()
    console.log(`  ${bold(a.counterparty)}${a.org ? dim(`  ${a.org}`) : ""}`)
    console.log(`  ${dim("type")}       ${a.type}  ·  tier ${a.tier}`)
    console.log(`  ${dim("between")}    ${a.disclosingParty}  and  ${a.counterparty}`)
    console.log(`  ${dim("state")}      ${highlight(stateLabel(a))}`)
    if (a.executedAt) console.log(`  ${dim("executed")}   ${a.executedAt}`)
    if (a.expiryDate) console.log(`  ${dim("expires")}    ${a.expiryDate}`)

    // The seal is reported as VERIFIED or not, never just printed. A hash echoed back with no
    // statement about whether it still recomputes is decoration, not evidence.
    const seal = body.seal
    if (seal?.status === "intact") {
      console.log(`  ${dim("seal")}       ${success("intact")}  ${dim(shortHash(seal.chain))}`)
    } else if (seal?.status === "mismatch") {
      console.log(`  ${dim("seal")}       ${bold("MISMATCH — the stored body no longer matches what was sealed")}`)
    } else {
      console.log(`  ${dim("seal")}       ${dim(seal?.detail ?? "unsealed")}`)
    }

    printDivider()
    console.log(`  ${dim("AUDIT TRAIL")}`)
    for (const e of body.trail ?? []) {
      console.log(
        `  ${dim(`seq ${String(e.seq ?? "—").padEnd(6)}`)} ${e.action.replace("agreement.", "").padEnd(11)} ` +
          `${dim(e.ip ?? "")}  ${dim(e.at ?? "")}`,
      )
    }
    printDivider()
    prompts.outro("Done")
  },
})

const LinkCommand = cmd({
  command: "link <id>",
  describe: "print the signing link for an agreement",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .epilogue(
        [
          "The link is a BEARER CREDENTIAL: anyone holding the URL can sign, and there is no",
          "login in front of it. Give it to the counterparty only — never a shared channel.",
          "",
          "On a multi-party agreement this prints one URL per party. A link signs for exactly",
          "one party, so sending the wrong one to the right person will be refused.",
        ].join("\n"),
      ),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Signing link — agreement #${args.id}`)
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(`/api/v1/agreements/${args.id}`)
    if (!res.ok) {
      await handleApiError(res, "load agreement")
      prompts.outro("Failed")
      return
    }
    const body = (await res.json()) as any

    if (body.agreement?.status === "executed") {
      // Printing a live-looking link for something already signed invites someone to chase a
      // counterparty who is done.
      prompts.log.info(`Already executed on ${body.agreement.executedAt} — nothing to chase.`)
    }

    const links = body.agreement.partyLinks ?? []
    console.log()
    if (links.length > 1) {
      // One URL is not enough when there are two sides and they are not interchangeable.
      // Printing them together with the role makes it obvious which goes to whom.
      for (const l of links) {
        const mark = l.status === "signed" ? success("signed  ") : dim("pending ")
        console.log(`  ${mark} ${bold(l.role.padEnd(16))} ${l.url}`)
        if (l.name) console.log(`           ${dim(l.name)}`)
      }
    } else {
      console.log(`  ${body.agreement.signingUrl}`)
    }
    console.log()
    // Said every time one is printed, because that is the moment someone is about to paste it.
    prompts.log.warn(
      links.length > 1
        ? "Each link signs for ONE party. Do not send the wrong one — and do not send both to the same person."
        : "Anyone with that URL can sign. Give it to the counterparty only.",
    )
    prompts.outro("Done")
  },
})


const RaiseCommand = cmd({
  command: "raise",
  aliases: ["new", "create"],
  describe: "raise an agreement and optionally issue it",
  builder: (y) =>
    y
      .option("name", { type: "string", describe: "counterparty full name", demandOption: true })
      .option("email", { type: "string", describe: "counterparty email — required to issue" })
      .option("org", { type: "string" })
      .option("type", { type: "string", default: "nda", choices: ["nda", "baa"] })
      .option("disclosing", { type: "string", default: "IRIS", describe: "the disclosing party" })
      .option("subject", { type: "string", describe: "what this agreement gates" })
      .option("tier", { type: "string", default: "standard", choices: ["standard", "phi"] })
      .option("term", { type: "string", default: "one year" })
      .option("expires", { type: "string", describe: "YYYY-MM-DD; derived from --term when omitted" })
      .option("issue", { type: "boolean", describe: "email the signing link straight away" })
      .option("json", { type: "boolean" })
      .example(
        '$0 agreements raise --name="Dana Whitfield" --email=dana@example.com --term="two years" --issue',
        "raise an NDA and email the signing link",
      )
      .example(
        '$0 agreements raise --type=baa --name="Dana Whitfield" --email=dana@example.com --tier=phi --issue',
        "a BAA — the signer must verify their email before signing",
      )
      .epilogue(
        [
          "--term and the expiry date state the same fact, so the date is DERIVED from the term.",
          'A term this cannot read ("for the duration of the engagement") is refused, not guessed —',
          "pass --expires=YYYY-MM-DD instead.",
          "",
          "The clause wording is PLACEHOLDER pending counsel review and says so on the document.",
          "",
          "Full recipe:  iris how-to view agreements-and-signing",
        ].join("\n"),
      ),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Raise an agreement")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    if (args.issue && !args.email) {
      // Issuing means emailing. Without an address the agreement would be marked sent while
      // nothing left the building — the exact failure send() was fixed for.
      prompts.log.error("--issue needs --email: there is nowhere to send the link")
      prompts.outro("Failed")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Raising…")
    const res = await irisFetch("/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify({
        agreement_type: args.type,
        counterparty_name: args.name,
        counterparty_email: args.email ?? null,
        counterparty_org: args.org ?? null,
        disclosing_party: args.disclosing,
        subject_ref: args.subject ?? null,
        access_tier: args.tier,
        term: args.term,
        expiry_date: args.expires ?? null,
        issue: Boolean(args.issue),
      }),
    })
    if (!res.ok) {
      spinner.stop("Failed")
      await handleApiError(res, "raise agreement")
      prompts.outro("Failed")
      return
    }
    const body = (await res.json()) as any
    spinner.stop("Raised")

    if (args.json) { await writeJson(body); prompts.outro("Done"); return }

    const a = body.agreement
    printDivider()
    console.log(`  ${dim("agreement")}  #${a.id}  ${bold(a.type)}`)
    console.log(`  ${dim("between")}    ${a.disclosingParty}  and  ${bold(a.counterparty)}`)
    console.log(`  ${dim("term")}       ${a.expiryDate ? `expires ${a.expiryDate}` : "—"}  ·  tier ${a.tier}`)
    console.log(`  ${dim("state")}      ${highlight(stateLabel(a))}`)
    if (a.signingUrl) console.log(`  ${dim("sign at")}    ${a.signingUrl}`)
    printDivider()
    if (args.issue) {
      prompts.log.warn("That URL is a bearer link — anyone holding it can sign.")
    } else {
      prompts.log.info(`Not issued yet: iris agreements issue ${a.id}`)
    }
    prompts.outro("Done")
  },
})

const IssueCommand = cmd({
  command: "issue <id>",
  aliases: ["send", "resend"],
  describe: "email the signing link (also re-sends)",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Issue agreement #${args.id}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/agreements/${args.id}/issue`, { method: "POST" })
    if (!res.ok) {
      await handleApiError(res, "issue agreement")
      prompts.outro("Failed")
      return
    }
    const a = ((await res.json()) as any).agreement
    console.log()
    console.log(`  ${success("issued")}   ${bold(a.counterparty)}  ·  ${a.signingUrl}`)
    console.log()
    prompts.log.warn("That URL is a bearer link — give it to the counterparty only.")
    prompts.outro("Done")
  },
})

const RevokeCommand = cmd({
  command: "revoke <id>",
  describe: "revoke an agreement and close the access it authorised",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("reason", { type: "string", describe: "why — recorded on the audit chain" })
      .epilogue(
        [
          "The reason is required. A revocation withdraws access someone was relying on, and",
          "the chain should say why without anyone reconstructing it from a timestamp.",
          "",
          "Access closes on the NEXT gate call — nothing has to run in between. Assignments",
          "already made are withdrawn by:  php artisan agreements:sweep-access --apply",
        ].join("\n"),
      ),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Revoke agreement #${args.id}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    // Asked for rather than defaulted. A revocation withdraws access someone was relying on,
    // and "revoked" with no reason is a question for whoever reads the chain later.
    let reason = args.reason as string | undefined
    if (!reason) {
      const answer = await prompts.text({
        message: "Why is this being revoked? (recorded on the audit chain)",
        placeholder: "engagement ended",
      })
      if (prompts.isCancel(answer) || !answer) { prompts.outro("Cancelled"); return }
      reason = String(answer)
    }

    const res = await irisFetch(`/api/v1/agreements/${args.id}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) {
      await handleApiError(res, "revoke agreement")
      prompts.outro("Failed")
      return
    }
    const a = ((await res.json()) as any).agreement
    console.log()
    console.log(`  ${bold("revoked")}  ${a.counterparty}  ·  any access this authorised is now closed`)
    console.log()
    prompts.outro("Done")
  },
})

export const PlatformAgreementsCommand = cmd({
  command: "agreements",
  aliases: ["nda", "contracts"],
  describe: "[Agreements] NDAs, BAAs — what is outstanding, executed, or expiring",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(ShowCommand)
      .command(LinkCommand)
      .command(RaiseCommand)
      .command(IssueCommand)
      .command(RevokeCommand)
      .demandCommand()
      .epilogue(
        [
          "Agreements GATE work: an NDA before someone sees anything confidential, a BAA before",
          "they touch PHI. For selling — proposals, invoices, Stripe — see `iris invoices` and",
          "the payment-gate-contracts recipe instead.",
          "",
          "There is no `sign` command, deliberately. The value of the audit chain is that a",
          "signature is attributable to the person who gave it, and an operator running a flag",
          "is not that person.",
          "",
          "Recipe:  iris how-to view agreements-and-signing",
        ].join("\n"),
      ),
  async handler() {},
})
