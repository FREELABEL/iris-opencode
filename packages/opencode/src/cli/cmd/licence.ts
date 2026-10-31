import { firstArray } from "../../util/array"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, handleApiError, printDivider, printKV, dim, writeJson, isJsonMode, emitJsonError } from "./iris-api"
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

export const IssueCmd = cmd({
  command: "issue",
  describe: "mint a licence key (operator only)",
  builder: (y: any) =>
    y
      .option("email", { describe: "who it is issued to", type: "string" })
      .option("tier", { describe: "starter | pro | business", type: "string", default: "starter" })
      .option("seats", { describe: "how many people may hold it", type: "number", default: 1 })
      .option("allowance", { describe: "spend allowance in CENTS", type: "number", default: 0 })
      .option("days", { describe: "expire this many days from now", type: "number" })
      .option("note", { describe: "what was actually agreed, in words", type: "string" })
      .option("lead", { describe: "CRM lead this licence belongs to (shows on the lead)", type: "number" })
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
    // Not truthiness: 0 has to reach the server and be refused, not become the default term (#191947).
    if (args.days !== undefined) body.days = args.days
    if (args.note) body.note = args.note
    // #189718: the API has accepted lead_id since #183598; the CLI never sent it.
    if (args.lead !== undefined) body.lead_id = args.lead

    const res = await irisFetch(BASE, { method: "POST", body: JSON.stringify(body) })
    if (!res.ok) return reportError(res, "Issue licence")

    const data = ((await res.json()) as any)?.data
    if (args.json) return writeJson(data)

    UI.empty()
    prompts.intro("◈  Licence issued")
    printDivider()
    printKV("key", String(data?.key ?? "—"))
    printKV("tier", String(data?.tier ?? "—"))
    printKV("seats", String(data?.seats ?? "—"))
    printKV("expires", data?.expires_at ? String(data.expires_at) : "never")
    printDivider()
    // The key is the credential. Say where it goes rather than leaving someone to guess.
    prompts.outro(dim("Give the key to the buyer — they run: iris licence claim <key>"))
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

    // #191949: a refused claim is still a failed command, so a script can tell.
    if (!res.ok) process.exitCode = 1

    if (args.json) return writeJson(res.ok ? body : { success: false, status: res.status, ...body })

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

    if (body?.already_revoked) prompts.log.info(`${args.key} is already revoked — nothing changed`)
    else prompts.log.success(`Revoked ${args.key}`)
  },
})

// #189718 — join a key that was already issued (and maybe already sent) to its CRM lead,
// instead of revoking it and sending the person a different key.
const LinkCmd = cmd({
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

const ShowCmd = cmd({
  command: "show <key>",
  describe: "one licence with its seats and audit trail (operator only)",
  builder: (y: any) =>
    y.positional("key", { type: "string" }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const res = await irisFetch(`${BASE}/${encodeURIComponent(args.key)}`)
    if (!res.ok) return reportError(res, "Show licence")

    const data = ((await res.json()) as any)?.data
    if (args.json) return writeJson(data)

    UI.empty()
    prompts.intro(`◈  ${data?.key ?? args.key}`)
    printDivider()
    printKV("tier", String(data?.tier ?? "—"))
    printKV("status", String(data?.status ?? "—"))
    printKV("seats", `${(data?.seat_rows?.length ?? 0)} of ${data?.seats ?? "—"} held`)
    printKV("issued to", String(data?.issued_to_email ?? "—"))
    printKV("lead", data?.lead_id ? `#${data.lead_id}` : "— (iris licence link <key> --lead <id>)")
    printDivider()
    for (const e of data?.events ?? []) {
      UI.println(dim(`  ${String(e.created_at ?? "").slice(0, 19)}  ${e.event}`))
    }
    prompts.outro(dim("iris licence show <key> --json for everything"))
  },
})

/** The subcommand group, so `iris reachr licence …` and `iris licence …` are one thing. */
export const LicenceGroup = cmd({
  command: "licence",
  aliases: ["license", "licences", "licenses"],
  describe: "what a yes produces — issue, claim and check entitlement",
  builder: (y: any) =>
    y.command(IssueCmd).command(ClaimCmd).command(MeCmd).command(ListCmd).command(ShowCmd).command(LinkCmd).command(RevokeCmd).demandCommand(),
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
      .command(ClaimCmd)
      .command(MeCmd)
      .command(ListCmd)
      .command(ShowCmd)
      .command(LinkCmd)
      .command(RevokeCmd)
      .demandCommand(),
})
