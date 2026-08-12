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
  highlight,
} from "./iris-api"

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
      console.log(JSON.stringify(body, null, 2))
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
      console.log(JSON.stringify(body, null, 2))
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
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
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

    console.log()
    console.log(`  ${body.agreement.signingUrl}`)
    console.log()
    // Said every time it is printed, because that is the moment someone is about to paste it.
    prompts.log.warn("Anyone with that URL can sign. Give it to the counterparty only.")
    prompts.outro("Done")
  },
})

export const PlatformAgreementsCommand = cmd({
  command: "agreements",
  aliases: ["nda", "contracts"],
  describe: "[Agreements] NDAs, BAAs — what is outstanding, executed, or expiring",
  builder: (yargs) =>
    yargs.command(ListCommand).command(ShowCommand).command(LinkCommand).demandCommand(),
  async handler() {},
})
