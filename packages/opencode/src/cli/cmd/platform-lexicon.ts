import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import { parsePlan, executeSkill } from "../../skill/executor"
import { dim, bold } from "./iris-api"
import { printLedger, raiseAgreement } from "./platform-agreements"

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

/** Run a playbook in-process, the same path `iris playbook run` takes. */
async function runPlaybook(name: string, args: Record<string, unknown>): Promise<void> {
  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const info = await Skill.get(name)
      if (!info) {
        console.error(`Playbook "${name}" not found. Is it synced? Try: iris playbook sync`)
        process.exit(1)
      }
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

const DemandCmd = cmd({
  command: "demand <lead>",
  aliases: ["demand-letter"],
  describe: "draft a demand from the matter record — liability, damages, and the number argued",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "lead / matter id", type: "number", demandOption: true })
      .option("demand", { describe: 'amount and its basis, decided by the attorney (e.g. "185000 — specials 62k, 3x")', type: "string" })
      .option("recipient", { describe: "carrier / adverse counsel the letter is addressed to", type: "string" })
      .option("bloq", { describe: "matter bloq id to file the result into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-demand-letter", {
      lead: args.lead, demand: args.demand, recipient: args.recipient,
      bloq: args.bloq, list: args.list, yes: args.yes,
    })
  },
})

const ChronologyCmd = cmd({
  command: "chronology <lead>",
  aliases: ["chrono", "timeline"],
  describe: "assemble every logged communication into a dated chronology with a work summary",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "lead / matter id", type: "number", demandOption: true })
      .option("rate", { describe: "hourly rate — adds estimated time and value to the work summary", type: "number" })
      .option("bloq", { describe: "matter bloq id to file the chronology into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-matter-chronology", { lead: args.lead, rate: args.rate, bloq: args.bloq, list: args.list, yes: args.yes })
  },
})

const EngagementCmd = cmd({
  command: "engagement <lead>",
  aliases: ["retainer"],
  describe: "draft an engagement letter, or review one for the defects that surface at resolution",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "lead / matter id", type: "number", demandOption: true })
      .option("mode", { describe: "draft a letter, or review one you paste in", choices: ["draft", "review"] as const, default: "draft" })
      .option("letter", { describe: "existing letter text (with --mode review)", type: "string" })
      .option("fee", { describe: 'fee arrangement in plain words (e.g. "contingency 33.3% pre-suit, 40% post-filing")', type: "string" })
      .option("bloq", { describe: "matter bloq id to file the result into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-engagement-letter", {
      lead: args.lead, mode: args.mode, letter: args.letter, fee: args.fee,
      bloq: args.bloq, list: args.list, yes: args.yes,
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
      .option("bloq", { describe: "matter bloq id to file the candidate sheet into", type: "number" })
      .option("list", { describe: "list id within that bloq (required to actually FILE — without it the playbook prints instead)", type: "number" })
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-conflict-check", { party: args.party, also: args.also, bloq: args.bloq, list: args.list, yes: args.yes })
  },
})

const IntakeCmd = cmd({
  command: "intake <enquiry>",
  aliases: ["new-matter"],
  describe: "turn a free-text enquiry into a structured matter — parties, posture, dates that bite",
  builder: (yargs) =>
    yargs
      .positional("enquiry", { describe: "raw enquiry — call notes, form submission, pasted email", type: "string", demandOption: true })
      .option("practice", { describe: "practice area hint", type: "string", default: "general" })
      .option("open", { describe: "open the matter (see the playbook's own arg)", type: "string" })
      .option("yes", { describe: "skip confirmation prompts", type: "boolean", default: false, alias: "y" }),
  async handler(args) {
    await runPlaybook("legal-matter-intake", { enquiry: args.enquiry, practice: args.practice, open: args.open, yes: args.yes })
  },
})

const AgreementsListCmd = cmd({
  command: "list [lead]",
  aliases: ["ls"],
  describe: "what is out for signature and what is signed — on one matter, or across every matter",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "lead / matter id; omit for every matter", type: "number" })
      .option("status", { type: "string", describe: "draft | sent | opened | partially_signed | executed | declined | expired | revoked" })
      .option("type", { type: "string", describe: "engagement, fee, tolling, settlement, release, …" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    await printLedger(
      args.lead ? `◈  Agreements — matter ${args.lead}` : "◈  Agreements — all matters",
      {
        status: args.status as string | undefined,
        type: args.type as string | undefined,
        ...(args.lead ? { subject: `matter:${args.lead}` } : { subject_prefix: "matter:" }),
      },
      Boolean(args.json),
    )
  },
})

const AgreementsRaiseCmd = cmd({
  command: "raise <lead>",
  aliases: ["new"],
  describe: "file an agreement against a matter and optionally send it for signature",
  builder: (yargs) =>
    yargs
      .positional("lead", { describe: "lead / matter id", type: "number", demandOption: true })
      .option("name", { type: "string", describe: "who signs, as named in the document", demandOption: true })
      .option("firm", { type: "string", describe: "the firm issuing it, as named in the document", demandOption: true })
      .option("email", { type: "string", describe: "signer's email — required with --issue" })
      .option("org", { type: "string" })
      .option("type", { type: "string", default: "engagement", describe: "engagement, fee, co_counsel, tolling, settlement, release, letter_of_protection, medical_authorization, nda, baa, other" })
      .option("body-file", { type: "string", describe: "the wording, from a text file — e.g. the attorney-approved output of `iris lexicon engagement`" })
      .option("template", { type: "string", describe: "contract template slug, instead of --body-file" })
      .option("term", { type: "string", describe: 'e.g. "two years"; omit for one that runs until revoked' })
      .option("expires", { type: "string", describe: "YYYY-MM-DD" })
      .option("issue", { type: "boolean", describe: "email the signing link now. Without it the agreement stays a draft" })
      .option("json", { type: "boolean" })
      .epilogue(
        [
          "--issue SENDS. A person should have approved the wording first: what goes out is sealed",
          "exactly as supplied, including any [to confirm: ...] still in it.",
          "",
          "An engagement letter on a recorded matter is refused until an attorney has recorded the",
          "conflicts clearance. A matter that was never recorded has nothing to check.",
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
      subject: `matter:${args.lead}`,
      tier: "standard",
      term: args.term as string | undefined,
      expires: args.expires as string | undefined,
      bodyFile: args.bodyFile as string | undefined,
      template: args.template as string | undefined,
      issue: Boolean(args.issue),
      json: Boolean(args.json),
    })
  },
})

const AgreementsCmd = cmd({
  command: "agreements",
  aliases: ["agreement"],
  describe: "agreements filed against matters — engagement letters, fee agreements, releases and more",
  builder: (yargs) => yargs.command(AgreementsListCmd).command(AgreementsRaiseCmd).demandCommand(),
  async handler() {},
})

export const PlatformLexiconCommand = productCommand({
  name: "lexicon",
  aliases: ["legal", "lex"],
  purpose: "Lexicon — legal matters end to end: intake, conflicts, engagement, chronology, demand, agreements",
  keywords: ["legal", "demand", "chronology", "engagement", "conflicts", "intake", "matter", "firm", "litigation", "agreements", "signature"],
  howtos: ["agreements-and-signing"],
  playbooks: [
    "legal-matter-intake",
    "legal-conflict-check",
    "legal-engagement-letter",
    "legal-matter-chronology",
    "legal-demand-letter",
  ],
  subcommands: [IntakeCmd, ConflictsCmd, EngagementCmd, ChronologyCmd, DemandCmd, AgreementsCmd],
})
