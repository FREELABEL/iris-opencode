import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

/**
 * `iris senders` — the verified identity a message goes out AS.
 *
 * Sender identity used to be free text typed into a strategy: any name, any address, signed
 * faithfully, with nothing checking it was real, ours, or authorised. A Sender is that identity
 * promoted to a row with a gate on it — unverified means DRAFT-ONLY.
 *
 * Distinct from a Brand (which organisation) and a Persona (how it writes). This one answers
 * what address it leaves from, and whether we may use it.
 */

const BASE = "/api/v1/atlas/senders"

interface SenderRow {
  slug: string
  display_name: string
  role?: string | null
  email?: string | null
  status: string
  is_default: boolean
  verified: boolean
  verification_method?: string | null
  usable: boolean
  unusable_reason?: string | null
  channels?: Record<string, Record<string, string>>
  channel_preference?: string[]
  primary_channel?: string | null
  delegated?: boolean
  allows_generated?: boolean
  authorization_note?: string | null
}

/**
 * Verification state leads every line. The failure mode this prevents is discovering mid-campaign
 * that the identity you queued 50 messages under cannot send — so it must be visible at a glance,
 * not behind --json.
 */
function printSender(s: SenderRow, full = false): void {
  const mark = s.usable ? success("✓") : "\x1b[33m○\x1b[0m"
  const tags = [
    s.is_default ? dim("default") : null,
    s.delegated ? "\x1b[36mdelegated\x1b[0m" : null,
    s.status !== "active" ? `\x1b[31m${s.status}\x1b[0m` : null,
  ].filter(Boolean)

  console.log(`  ${mark} ${bold(s.slug)}  ${s.display_name}${tags.length ? "  " + tags.join(" ") : ""}`)
  if (s.role || s.email) console.log(`      ${dim([s.role, s.email].filter(Boolean).join("  ·  "))}`)
  if (!s.usable && s.unusable_reason) console.log(`      \x1b[33m${s.unusable_reason}\x1b[0m`)

  if (!full) return

  if (s.verification_method) console.log(`      ${dim("verified via")} ${s.verification_method}`)
  if (s.delegated && s.allows_generated === false) {
    console.log(`      \x1b[33mverbatim-only\x1b[0m ${dim("— a model may not write under this identity")}`)
  }
  if (s.authorization_note) console.log(`      ${dim("authorised:")} ${s.authorization_note}`)

  const channels = s.channels ?? {}
  const order = s.channel_preference ?? []
  const bound = order.length ? order : Object.keys(channels)
  if (bound.length) {
    console.log(`      ${dim("sends from:")}`)
    bound.forEach((ch, i) => {
      const v = channels[ch]?.account ?? channels[ch]?.from ?? "?"
      // Rank is the useful thing here — which provider it actually reaches for first.
      const rank = i === 0 ? dim("(primary)") : dim(`(${i + 1})`)
      console.log(`        ${ch.padEnd(12)} ${v}  ${rank}`)
    })
  } else {
    console.log(`      \x1b[33mno channel bindings\x1b[0m ${dim("— sends will be refused on email/apple_mail")}`)
  }
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show your sender identities and which ones can actually send",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Senders") }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const res = await irisFetch(BASE)
    if (!res.ok) { await handleApiError(res, "List senders"); if (!args.json) prompts.outro("Done"); return }

    const rows = (((await res.json()) as any)?.data ?? []) as SenderRow[]

    if (args.json) { console.log(JSON.stringify(rows, null, 2)); return }

    printDivider()
    if (!rows.length) {
      console.log(`  ${dim("No senders yet.")}`)
      console.log(`  ${dim("Create one:")} iris senders create --name "Jordan Mayo" --email jordan@example.com`)
    }
    for (const s of rows) printSender(s)
    printDivider()
    console.log(`  ${success("✓")} ${dim("can send")}   \x1b[33m○\x1b[0m ${dim("draft only — needs")} iris senders verify <slug>`)
    prompts.outro("Done")
  },
})

const ShowCommand = cmd({
  command: "show <slug>",
  describe: "full detail for one sender, including its channel bindings",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Sender — ${args.slug}`) }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const res = await irisFetch(`${BASE}/${encodeURIComponent(String(args.slug))}`)
    if (!res.ok) { await handleApiError(res, "Show sender"); if (!args.json) prompts.outro("Done"); return }

    const s = ((await res.json()) as any)?.data as SenderRow
    if (args.json) { console.log(JSON.stringify(s, null, 2)); return }

    printDivider()
    printSender(s, true)
    printDivider()
    prompts.outro("Done")
  },
})

const CreateCommand = cmd({
  command: "create",
  aliases: ["add", "new"],
  describe: "register a sender identity (created UNVERIFIED — verify before it can send)",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true, describe: "display name, e.g. \"Jordan Mayo\"" })
      .option("slug", { type: "string", describe: "short handle (default: slugified name)" })
      .option("email", { type: "string", describe: "the address this identity sends from" })
      .option("role", { type: "string", describe: 'e.g. "Prospective Student"' })
      .option("company", { type: "string" })
      .option("phone", { type: "string" })
      .option("calendar", { type: "string", describe: "booking link" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Create sender") }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const res = await irisFetch(BASE, {
      method: "POST",
      body: JSON.stringify({
        display_name: args.name,
        slug: args.slug,
        email: args.email,
        role: args.role,
        company: args.company,
        phone: args.phone,
        calendar_url: args.calendar,
      }),
    })

    const payload = (await res.json().catch(() => null)) as any
    if (!res.ok) {
      if (!args.json) prompts.log.error(payload?.error ?? `HTTP ${res.status}`)
      else console.log(JSON.stringify(payload))
      process.exitCode = 1
      return
    }

    if (args.json) { console.log(JSON.stringify(payload?.data, null, 2)); return }

    printDivider()
    printSender(payload.data as SenderRow, true)
    printDivider()
    // Created unverified ALWAYS — a sender you can send with the moment you type it is the
    // free-text problem this replaced. Say what to do next rather than leaving it inert.
    console.log(`  ${dim("Next:")} iris senders verify ${payload.data.slug}`)
    console.log(`  ${dim("Then:")} iris senders bind ${payload.data.slug} --channel apple_mail --value <mail.app account>`)
    prompts.outro("Done")
  },
})

const VerifyCommand = cmd({
  command: "verify <slug>",
  describe: "establish that this address is yours to send from (required before any send)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("method", { type: "string", describe: "resend_domain | local_mailbox | delegated (default: inferred)" })
      .option("authorized-by", { type: "number", describe: "user id granting a DELEGATED identity" })
      .option("note", { type: "string", describe: "why the delegation is legitimate (required for delegated)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Verify — ${args.slug}`) }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const res = await irisFetch(`${BASE}/${encodeURIComponent(String(args.slug))}/verify`, {
      method: "POST",
      body: JSON.stringify({
        method: args.method,
        authorized_by: args["authorized-by"],
        note: args.note,
      }),
    })

    const payload = (await res.json().catch(() => null)) as any

    if (!res.ok) {
      if (args.json) { console.log(JSON.stringify(payload)); process.exitCode = 1; return }
      prompts.log.error(payload?.error ?? `HTTP ${res.status}`)
      prompts.outro("Done")
      process.exitCode = 1
      return
    }

    if (args.json) { console.log(JSON.stringify(payload, null, 2)); return }

    printDivider()
    printSender(payload.data as SenderRow, true)
    if (payload.note) { console.log(); console.log(`  \x1b[33m${payload.note}\x1b[0m`) }
    printDivider()
    prompts.outro(`${success("✓")} verified`)
  },
})

const BindCommand = cmd({
  command: "bind <slug>",
  describe: "bind a transport — WHICH mailbox or number this identity actually leaves from",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("channel", { type: "string", demandOption: true, describe: "apple_mail | email | sms | imessage" })
      .option("value", { type: "string", demandOption: true, describe: "Mail.app account, from-address, or number" })
      .option("primary", { type: "boolean", default: false, describe: "make this the channel this identity reaches for FIRST" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bind — ${args.slug} → ${args.channel}`) }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const res = await irisFetch(`${BASE}/${encodeURIComponent(String(args.slug))}/bind`, {
      method: "POST",
      body: JSON.stringify({ channel: args.channel, value: args.value, primary: args.primary }),
    })
    if (!res.ok) { await handleApiError(res, "Bind sender"); if (!args.json) prompts.outro("Done"); return }

    const s = ((await res.json()) as any)?.data as SenderRow
    if (args.json) { console.log(JSON.stringify(s, null, 2)); return }

    printDivider()
    printSender(s, true)
    printDivider()
    // Worth stating: binding sets the transport; it does not prove the account exists.
    console.log(`  ${dim("Confirm the From header by reading a RECEIVED message — not the send response.")}`)
    prompts.outro("Done")
  },
})

const PreferCommand = cmd({
  command: "prefer <slug>",
  aliases: ["order"],
  describe: "set which provider this identity reaches for first, second, …",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("order", { type: "string", demandOption: true, describe: "comma-separated, most preferred first, e.g. email,apple_mail" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Channel order — ${args.slug}`) }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }

    const order = String(args.order).split(",").map((x) => x.trim()).filter(Boolean)

    const res = await irisFetch(`${BASE}/${encodeURIComponent(String(args.slug))}/prefer`, {
      method: "POST",
      body: JSON.stringify({ order }),
    })

    const payload = (await res.json().catch(() => null)) as any
    if (!res.ok) {
      // The common error is preferring a channel with no binding — that would queue a send the
      // router then refuses, so the API rejects it here where it is fixable.
      if (!args.json) prompts.log.error(payload?.error ?? `HTTP ${res.status}`)
      else console.log(JSON.stringify(payload))
      process.exitCode = 1
      return
    }

    if (args.json) { console.log(JSON.stringify(payload?.data, null, 2)); return }

    printDivider()
    printSender(payload.data as SenderRow, true)
    printDivider()
    prompts.outro("Done")
  },
})

const DefaultCommand = cmd({
  command: "default <slug>",
  describe: "make this the default sender for your outreach",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Default sender — ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const res = await irisFetch(`${BASE}/${encodeURIComponent(String(args.slug))}/default`, { method: "POST" })
    if (!res.ok) { await handleApiError(res, "Set default sender"); prompts.outro("Done"); return }

    prompts.outro(`${success("✓")} ${args.slug} is now the default`)
  },
})

const ArchiveCommand = cmd({
  command: "archive <slug>",
  aliases: ["rm", "delete"],
  describe: "retire a sender (archived, never deleted — the ledger points at it)",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Archive — ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const res = await irisFetch(`${BASE}/${encodeURIComponent(String(args.slug))}`, { method: "DELETE" })
    if (!res.ok) { await handleApiError(res, "Archive sender"); prompts.outro("Done"); return }

    // Archived rather than deleted: lead_comms.sender_id points at this row, and deleting it
    // would orphan the record of what that identity sent.
    prompts.outro(`${success("✓")} archived — its sent history is preserved`)
  },
})

export const PlatformSendersCommand = cmd({
  command: "senders",
  aliases: ["sender", "identities"],
  describe: "sender identities — who a message goes out AS, and whether it may",
  builder: (y) =>
    y
      .command(ListCommand)
      .command(ShowCommand)
      .command(CreateCommand)
      .command(VerifyCommand)
      .command(BindCommand)
      .command(PreferCommand)
      .command(DefaultCommand)
      .command(ArchiveCommand)
      .demandCommand(1, "Specify a subcommand"),
  async handler() {},
})
