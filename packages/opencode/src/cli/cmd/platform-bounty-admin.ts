import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success } from "./iris-api"

/**
 * `iris bounty admin` — the Bounty OS ledger and reconciliation surface.
 *
 * These verbs existed only as artisan commands, so answering "is the ledger sane" meant opening
 * a shell on production (`railway ssh -s fl-api -- php artisan bounty:invariants`). Running a
 * READ-ONLY check should not require the ability to run anything at all.
 *
 * The server side is a strict allow-list (BountyAdminController), not a generic artisan runner:
 * verbs are hardcoded, every option is cast to int, and mutating verbs refuse to run without an
 * explicit confirmation.
 */

const BASE = "/api/v1/marketplace/bounty/admin"

interface AdminVerb {
  verb: string
  summary: string
  writes: boolean
  options: string[]
}

async function listVerbs(): Promise<AdminVerb[] | null> {
  const res = await irisFetch(BASE)
  if (!res.ok) {
    await handleApiError(res, "List bounty admin verbs")
    return null
  }
  const data = (await res.json()) as any
  return (data?.data ?? []) as AdminVerb[]
}

/**
 * Render whatever the verb returned.
 *
 * `exit_code` is the answer for `invariants` — it exits non-zero on a violation — so a failing
 * check is reported as a FAILED CHECK, never as a failed request. Flattening the two would hide
 * the exact thing being looked for.
 */
function printResult(verb: string, payload: any, json: boolean): number {
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return payload?.ok === false ? 1 : 0
  }

  printDivider()
  const ok = payload?.ok !== false
  console.log(`  ${bold(verb)}  ${ok ? success("✓ ok") : "\x1b[31m✗ violations found\x1b[0m"}  ${dim(`exit ${payload?.exit_code ?? "?"}`)}`)

  if (payload?.data) {
    console.log()
    console.log(JSON.stringify(payload.data, null, 2))
  } else if (payload?.output) {
    console.log()
    console.log(payload.output)
  }

  printDivider()
  return ok ? 0 : 1
}

const AdminListCommand = cmd({
  command: "list",
  aliases: ["ls", "verbs"],
  describe: "show the ledger/reconciliation verbs available and which ones mutate data",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Bounty OS — admin verbs") }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const verbs = await listVerbs()
    if (!verbs) { if (!args.json) prompts.outro("Done"); return }

    if (args.json) { console.log(JSON.stringify(verbs, null, 2)); return }

    printDivider()
    for (const v of verbs) {
      const tag = v.writes ? "\x1b[33mWRITES\x1b[0m" : dim("read-only")
      console.log(`  ${bold(v.verb)}  ${tag}`)
      console.log(`      ${dim(v.summary)}`)
      if (v.options.length) console.log(`      ${dim("options: " + v.options.map((o) => "--" + o.replace(/_/g, "-")).join(", "))}`)
    }
    printDivider()
    console.log(`  ${dim("Run one:")} iris bounty admin run invariants`)
    console.log(`  ${dim("Mutating verbs need")} --confirm`)
    prompts.outro("Done")
  },
})

const AdminRunCommand = cmd({
  command: "run <verb>",
  describe: "run a ledger/reconciliation verb (invariants, audit, balance, sync-ledger, refresh-views)",
  builder: (y) =>
    y
      .positional("verb", { type: "string", demandOption: true, describe: "verb name — see `iris bounty admin list`" })
      .option("opportunity", { type: "number", describe: "bounty opportunity id" })
      .option("lead", { type: "number", describe: "restrict to one reporter lead (invariants)" })
      .option("owner-id", { type: "number", describe: "owner id (sync-ledger)" })
      .option("bloq-id", { type: "number", describe: "bloq id (sync-ledger)" })
      .option("confirm", { type: "boolean", default: false, describe: "required for verbs that modify data" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const verb = String(args.verb)
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bounty OS — ${verb}`) }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const body: Record<string, unknown> = {}
    if (args.opportunity != null) body.opportunity = args.opportunity
    if (args.lead != null) body.lead = args.lead
    if (args["owner-id"] != null) body.owner_id = args["owner-id"]
    if (args["bloq-id"] != null) body.bloq_id = args["bloq-id"]
    if (args.confirm) body.confirm = true

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start(`Running ${verb}…`)

    const res = await irisFetch(`${BASE}/${encodeURIComponent(verb)}`, {
      method: "POST",
      body: JSON.stringify(body),
    })

    const payload = (await res.json().catch(() => null)) as any

    if (!res.ok) {
      spinner?.stop("Failed", 1)
      // 409 is the guard on a mutating verb, not an error — say what to do instead of dumping it.
      if (res.status === 409) {
        prompts.log.warn(`${verb} modifies data. Re-run with --confirm.`)
      } else if (res.status === 404 && payload?.available) {
        prompts.log.error(`Unknown verb "${verb}". Available: ${payload.available.join(", ")}`)
      } else {
        prompts.log.error(payload?.error ?? `HTTP ${res.status}`)
      }
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
      return
    }

    spinner?.stop("Done")
    process.exitCode = printResult(verb, payload, Boolean(args.json))
    if (!args.json) prompts.outro("Done")
  },
})

export const BountyAdminCommand = cmd({
  command: "admin",
  aliases: ["ledger", "ops"],
  describe: "ledger & reconciliation — invariants, audit, balance, sync-ledger, refresh-views",
  builder: (y) => y.command(AdminListCommand).command(AdminRunCommand).demandCommand(1, "Specify a subcommand"),
  async handler() {},
})
