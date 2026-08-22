import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import { parsePlan, executeSkill } from "../../skill/executor"
import { dim, bold } from "./iris-api"

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

export const PlatformLexiconCommand = productCommand({
  name: "lexicon",
  aliases: ["legal", "lex"],
  purpose: "Lexicon — legal matters end to end: intake, conflicts, engagement, chronology, demand",
  keywords: ["legal", "demand", "chronology", "engagement", "conflicts", "intake", "matter", "firm", "litigation"],
  howtos: [],
  playbooks: [
    "legal-matter-intake",
    "legal-conflict-check",
    "legal-engagement-letter",
    "legal-matter-chronology",
    "legal-demand-letter",
  ],
  subcommands: [IntakeCmd, ConflictsCmd, EngagementCmd, ChronologyCmd, DemandCmd],
})
