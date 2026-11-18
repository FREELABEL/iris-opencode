import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import { parsePlan, executeSkill } from "../../skill/executor"
import { dim, bold } from "./iris-api"
import { printLedger, raiseAgreement, MERGE_OPTION, COUNTERSIGNER_OPTION } from "./platform-agreements"

// ============================================================================
// platform-lexicon — the legal product's front door (#181888 PROD-3)
//
// Lexicon is the product a firm buys: demands, chronologies, engagement
// letters, conflict checks, intake. The work itself already existed as five
// legal-* playbooks, reachable only if you knew their slugs — which meant the
// IP was in the repo but the PRODUCT had no name a client could type.
//
// These subcommands do not reimplement the playbooks. They are the front door
// onto them, so the same rails run whether a person types `iris lexicon demand`
// or an agent invokes the playbook directly.
// ============================================================================

/** Find the playbook, or fetch it: a firm's first command must not fail because nothing was synced. */
async function resolvePlaybook(name: string) {
  const find = () => Instance.provide({ directory: process.cwd(), fn: () => Skill.get(name) })
  const found = await find()
  if (found) return found

  const { PlaybookInstallCommand } = await import("./platform-playbook")
  await (PlaybookInstallCommand.handler as (a: unknown) => Promise<void>)({
    name,
    force: false,
    global: true,
    project: false,
    sync: false,
    "no-sync": true,
    noSync: true,
    json: false,
  })
  // The skill list is read once per instance, so it has to be re-read to see the new file.
  await Instance.provide({ directory: process.cwd(), fn: () => Instance.dispose() })
  return find()
}

/** Run a playbook in-process, the same path `iris playbook run` takes. */
async function runPlaybook(name: string, args: Record<string, unknown>): Promise<void> {
  const info = await resolvePlaybook(name)
  if (!info) {
    console.error(`Could not get the "${name}" playbook. Check your connection and sign-in (iris auth login), then try again.`)
    process.exit(1)
  }
  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const plan = await parsePlan(info)
      // Drop undefined so a playbook's own defaults survive.
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args)) if (v !== undefined) clean[k] = v

      const result = await executeSkill(plan, clean, { yes: Boolean(args.yes) })

      console.log("")
      console.log(`${bold(plan.name)} — ${result.status}  ${dim(`(run ${result.run_id})`)}`)
      for (const step of plan.steps) {
        const sr = result.steps[step.id]
        if (!sr || !sr.output.trim()) continue
        console.log("")
        console.log(dim(`── ${step.id}`))
        console.log(sr.output.trim())
      }
    },
  })
}

const RECORD_OPTION = {
  describe: "keep this on the case so the console can show it (--record yes)",
  type: "string",
} as const

/** The playbooks read `yes`. `--record` alone means the same; absent stays absent. */
const recordArg = (v: unknown) => (v === undefined ? undefined : "yes") // clearing needs the sweep on file, so --cleared-by implies it

const DemandCmd = cmd({
  command: "demand <lead>",
  aliases: ["demand-letter"],
  describe: "draft a demand from the case record — liability, damages, and the number argued",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "case id (the lead id)", type: "number", demandOption: true })
      .option("demand", { describe: 'amount and its basis, decided by the attorney (e.g. "185000 — specials 62k, 3x")', type: "string" })
      .option("recipient", { describe: "carrier / adverse counsel the letter is addressed to", type: "string" })
      .option("bloq", { describe: "case board id to file the result into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("record", RECORD_OPTION)
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-demand-letter", {
      lead: args.lead, demand: args.demand, recipient: args.recipient,
      bloq: args.bloq, list: args.list, record: recordArg(args.record), yes: args.yes,
    })
  },
})

const ChronologyCmd = cmd({
  command: "chronology <lead>",
  aliases: ["chrono", "timeline"],
  describe: "assemble every logged communication into a dated chronology with a work summary",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "case id (the lead id)", type: "number", demandOption: true })
      .option("rate", { describe: "hourly rate — adds estimated time and value to the work summary", type: "number" })
      .option("bloq", { describe: "case board id to file the chronology into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("record", RECORD_OPTION)
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-case-chronology", { lead: args.lead, rate: args.rate, bloq: args.bloq, list: args.list, record: recordArg(args.record), yes: args.yes })
  },
})

const EngagementCmd = cmd({
  command: "engagement <lead>",
  aliases: ["retainer"],
  describe: "draft an engagement letter, or review one for the defects that surface at resolution",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "case id (the lead id)", type: "number", demandOption: true })
      .option("mode", { describe: "draft a letter, or review one you paste in", choices: ["draft", "review"] as const, default: "draft" })
      .option("letter", { describe: "existing letter text (with --mode review)", type: "string" })
      .option("fee", { describe: 'fee arrangement in plain words (e.g. "contingency 33.3% pre-suit, 40% post-filing")', type: "string" })
      .option("bloq", { describe: "case board id to file the result into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("record", RECORD_OPTION)
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-engagement-letter", {
      lead: args.lead, mode: args.mode, letter: args.letter, fee: args.fee,
      bloq: args.bloq, list: args.list, record: recordArg(args.record), yes: args.yes,
    })
  },
})

const ConflictsCmd = cmd({
  command: "conflicts <party>",
  aliases: ["conflict-check"],
  describe: "sweep the firm's own records for a party and assemble a conflicts candidate sheet",
  builder: (yargs) =>
    yargs
      .positional("party", { describe: "prospective client or adverse party name", type: "string", demandOption: true })
      .option("also", { describe: "comma-separated related names (spouse, employer, carrier, entities)", type: "string" })
      .option("lead", { describe: "case id (the lead id) this sweep belongs to", type: "number" })
      .option("cleared-by", { describe: "the attorney clearing conflicts on --lead. Only a person's sign-off clears; it is refused with no sweep on file", type: "string" })
      .option("bloq", { describe: "case board id to file the candidate sheet into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("record", RECORD_OPTION)
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-conflict-check", { party: args.party, also: args.also, bloq: args.bloq, list: args.list, lead: args.lead, cleared_by: args.clearedBy, record: recordArg(args.clearedBy ?? args.record), yes: args.yes })
  },
})

const IntakeCmd = cmd({
  command: "intake <enquiry>",
  aliases: ["new-case"],
  describe: "turn a free-text enquiry into a structured case — parties, posture, dates that bite",
  builder: (yargs) =>
    yargs
      .positional("enquiry", { describe: "raw enquiry — call notes, form submission, pasted email", type: "string", demandOption: true })
      .option("practice", { describe: "practice area hint", type: "string", default: "general" })
      .option("open", { describe: "create the case's lead record (--open yes)", type: "string" })
      .option("record", RECORD_OPTION)
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-case-intake", { enquiry: args.enquiry, practice: args.practice, open: args.open, record: recordArg(args.record), yes: args.yes })
  },
})

const AgreementsListCmd = cmd({
  command: "list [case]",
  aliases: ["ls"],
  describe: "what is out for signature and what is signed — on one case, or across every case",
  builder: (yargs) =>
    yargs
      .positional("case", { describe: "case id (the lead id) or a synced case ref (e.g. LEX-CLIO-9); omit for every case", type: "string" })
      .option("status", { type: "string", describe: "draft | sent | opened | partially_signed | executed | declined | expired | revoked" })
      .option("type", { type: "string", describe: "engagement, fee, tolling, settlement, release, …" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    await printLedger(
      args.case ? `◈  Agreements — case ${args.case}` : "◈  Agreements — all cases",
      {
        status: args.status as string | undefined,
        type: args.type as string | undefined,
        ...(args.case ? { subject: `case:${args.case}` } : { subject_prefix: "case:" }),
      },
      Boolean(args.json),
    )
  },
})

const AgreementsRaiseCmd = cmd({
  command: "raise [case]",
  aliases: ["new"],
  describe: "send an engagement letter, retainer, fee agreement, release or equity grant for signature — on a case or the firm's own",
  builder: (yargs) =>
    yargs
      .positional("case", { describe: "case id (the lead id) or a synced case ref (e.g. LEX-CLIO-9). Omit for the firm's own paperwork, e.g. an equity grant", type: "string" })
      .option("name", { type: "string", describe: "who signs, as named in the document", demandOption: true })
      .option("firm", { type: "string", describe: "the firm issuing it, as named in the document", demandOption: true })
      .option("email", { type: "string", describe: "signer's email — required with --issue" })
      .option("org", { type: "string" })
      .option("type", { type: "string", default: "engagement", describe: "engagement, fee, co_counsel, equity_grant, tolling, settlement, release, letter_of_protection, medical_authorization, nda, baa, other" })
      .option("body-file", { type: "string", describe: "the wording, from a text file — e.g. the attorney-approved output of `iris lexicon engagement`" })
      .option("template", { type: "string", describe: "contract template slug, instead of --body-file" })
      .option("merge", MERGE_OPTION)
      .option("countersigner", COUNTERSIGNER_OPTION)
      .option("term", { type: "string", describe: 'e.g. "two years"; omit for one that runs until revoked' })
      .option("expires", { type: "string", describe: "YYYY-MM-DD" })
      .option("issue", { type: "boolean", describe: "email the signing link now. Without it the agreement stays a draft" })
      .option("json", { type: "boolean" })
      .epilogue(
        [
          "--issue SENDS. A person should have approved the wording first: what goes out is sealed",
          "exactly as supplied, including any [to confirm: ...] still in it.",
          "",
          "An engagement letter on a recorded case is refused until an attorney has recorded the",
          "conflicts clearance. A case that was never recorded has nothing to check.",
          "",
          "After this:  iris agreements show <id>  ·  link <id>  ·  issue <id>  ·  revoke <id>",
        ].join("\n"),
      ),
  async handler(args) {
    await raiseAgreement({
      type: args.type as string,
      name: args.name as string,
      email: args.email as string | undefined,
      org: args.org as string | undefined,
      disclosing: args.firm as string,
      subject: args.case ? `case:${args.case}` : undefined,
      tier: "standard",
      term: args.term as string | undefined,
      expires: args.expires as string | undefined,
      bodyFile: args.bodyFile as string | undefined,
      template: args.template as string | undefined,
      merge: args.merge as string[] | undefined,
      countersigner: args.countersigner as string | undefined,
      issue: Boolean(args.issue),
      json: Boolean(args.json),
    })
  },
})

const AgreementsCmd = cmd({
  command: "agreements",
  aliases: ["agreement"],
  describe: "agreements filed against cases — engagement letters, fee agreements, releases and more",
  builder: (yargs) => yargs.command(AgreementsListCmd).command(AgreementsRaiseCmd).demandCommand(),
  async handler() {},
})

export const PlatformLexiconCommand = productCommand({
  name: "lexicon",
  aliases: ["legal", "lex"],
  purpose: "Lexicon — legal cases end to end: intake, conflicts, engagement, chronology, demand, agreements",
  keywords: ["legal", "demand", "chronology", "engagement", "conflicts", "intake", "case", "firm", "litigation", "agreements", "signature", "engagement letter", "retainer", "law firm", "lawyer", "attorney"],
  howtos: ["run-a-case-in-lexicon", "agreements-and-signing"],
  playbooks: [
    "legal-case-intake",
    "legal-conflict-check",
    "legal-engagement-letter",
    "legal-case-chronology",
    "legal-demand-letter",
  ],
  subcommands: [IntakeCmd, ConflictsCmd, EngagementCmd, ChronologyCmd, DemandCmd, AgreementsCmd],
})
