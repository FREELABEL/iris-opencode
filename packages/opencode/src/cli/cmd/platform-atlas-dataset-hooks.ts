import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

// ============================================================================
// iris datasets hooks — webhooks on an Atlas dataset (#187898)
//
// Before this, a record that changed did so in silence: every "when a lead row lands, do X"
// needed a poller. A hook POSTs a signed payload to your https sink when a record in the
// dataset is created, updated or deleted, and every attempt lands in a delivery log.
//
// Routes (fl-api): GET/POST  /api/v1/atlas/datasets/{slug}/hooks
//                  DELETE    /api/v1/atlas/datasets/{slug}/hooks/{id}
//                  GET       /api/v1/atlas/datasets/{slug}/hooks/deliveries
// ============================================================================

export const HOOK_EVENTS = ["created", "updated", "deleted"] as const

/**
 * `--on created --on updated`, `--on created,updated` and `--on all` all mean what they say.
 * Unknown names are returned separately so the caller can refuse them by name rather than
 * letting the server answer with a generic 422.
 */
export function parseHookEvents(raw: unknown): { events: string[]; unknown: string[] } {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .filter((v) => v !== undefined && v !== null)
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  const events = new Set<string>()
  const unknown: string[] = []
  for (const p of parts) {
    if (p === "all" || p === "*") HOOK_EVENTS.forEach((e) => events.add(e))
    else if ((HOOK_EVENTS as readonly string[]).includes(p)) events.add(p)
    else unknown.push(p)
  }
  return { events: HOOK_EVENTS.filter((e) => events.has(e)), unknown }
}

function divider() {
  console.log(dim("  " + "─".repeat(72)))
}

function hooksPath(slug: string, rest = ""): string {
  return `/api/v1/atlas/datasets/${encodeURIComponent(slug)}/hooks${rest}`
}

const HookAddCommand = cmd({
  command: "add <slug>",
  aliases: ["create"],
  describe: "POST a signed payload to a URL when a record in this dataset changes",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true, describe: "dataset slug you own" })
      .option("url", { type: "string", demandOption: true, describe: "https sink (must resolve to a public address)" })
      .option("on", {
        type: "array",
        default: ["created"] as string[],
        describe: "events: created, updated, deleted (repeat, comma-separate, or 'all')",
      })
      .option("description", { type: "string", describe: "what this hook is for" })
      .option("phi-cleared", {
        type: "boolean",
        default: false,
        describe: "include PHI-visibility fields — refused unless the sink's host is a BAA-covered provider in the PHI egress registry",
      })
      .option("bloq", { type: "number", describe: "only fire for records in this bloq's copy of the dataset" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add hook: ${args.slug}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const { events, unknown } = parseHookEvents(args.on)
    if (unknown.length || events.length === 0) {
      prompts.log.error(`Unknown event(s): ${unknown.join(", ") || "(none given)"} — use ${HOOK_EVENTS.join(", ")} or all`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(hooksPath(String(args.slug)), {
      method: "POST",
      body: JSON.stringify({
        url: args.url,
        events,
        ...(args.description ? { description: args.description } : {}),
        ...(args["phi-cleared"] ? { phi_cleared: true } : {}),
        ...(args.bloq != null ? { bloq_id: args.bloq } : {}),
      }),
    })
    const ok = await handleApiError(res, "Create hook")
    if (!ok) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    const d = ((await res.json()) as any)?.data

    if (args.json) {
      await writeJson(d)
      prompts.outro("Done")
      return
    }

    divider()
    console.log(`  ${bold("Hook")}      #${d?.id}  ${d?.url}`)
    console.log(`  ${bold("Events")}    ${(d?.events ?? []).join(", ")}`)
    console.log(`  ${bold("PHI")}       ${d?.phi_cleared ? `cleared (${d?.phi_provider})` : "omitted — PHI-visibility fields are left out of every payload"}`)
    // The API returns the secret exactly once; every later read shows a prefix.
    console.log(`  ${bold("Secret")}    ${d?.secret}`)
    console.log(`  ${dim("This is the ONLY time the secret is shown. Store it with your receiver now.")}`)
    divider()
    console.log(`  ${dim("Verify: hex(HMAC-SHA256(secret, X-Atlas-Timestamp + \".\" + raw body)) == v1 in X-Atlas-Signature;")}`)
    console.log(`  ${dim("reject timestamps older than 5 minutes. Dedupe retries on X-Atlas-Delivery.")}`)
    prompts.outro(`iris datasets hooks deliveries ${args.slug}`)
  },
})

const HookListCommand = cmd({
  command: "list <slug>",
  aliases: ["ls"],
  describe: "list a dataset's hooks (secret prefixes only)",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Hooks: ${args.slug}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(hooksPath(String(args.slug)))
    const ok = await handleApiError(res, "List hooks")
    if (!ok) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    const hooks: any[] = firstArray(((await res.json()) as any)?.data)

    if (args.json) {
      await writeJson(hooks)
      prompts.outro("Done")
      return
    }
    if (hooks.length === 0) {
      prompts.log.warn("No hooks on this dataset")
      prompts.outro(`iris datasets hooks add ${args.slug} --on created --url https://…`)
      return
    }

    divider()
    for (const h of hooks) {
      const last = h.last_status == null ? dim("never delivered") : h.last_status >= 200 && h.last_status < 300 ? bold(String(h.last_status)) : String(h.last_status)
      console.log(`  #${String(h.id).padEnd(5)} ${String(h.url).padEnd(40)} ${dim((h.events ?? []).join(","))}  ${last}`)
      console.log(`         ${dim(`${h.secret_prefix}…  ${h.phi_cleared ? `PHI cleared (${h.phi_provider})` : "PHI omitted"}`)}${h.description ? "  " + h.description : ""}`)
    }
    divider()
    prompts.outro("Done")
  },
})

const HookRemoveCommand = cmd({
  command: "remove <slug> <id>",
  aliases: ["rm", "delete"],
  describe: "remove a hook (pending retries stop)",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true }).positional("id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Remove hook #${args.id}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(hooksPath(String(args.slug), `/${args.id}`), { method: "DELETE" })
    const ok = await handleApiError(res, "Remove hook")
    if (!ok) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    if (args.json) {
      await writeJson({ removed: args.id })
      prompts.outro("Done")
      return
    }
    console.log(`  ${bold("Removed")} — no further deliveries, including queued retries.`)
    prompts.outro("Done")
  },
})

const HookDeliveriesCommand = cmd({
  command: "deliveries <slug>",
  aliases: ["log"],
  describe: "every delivery attempt for a dataset's hooks, newest first",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("hook", { type: "number", describe: "only this hook id" })
      .option("limit", { type: "number", default: 50 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Hook deliveries: ${args.slug}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const p = new URLSearchParams()
    if (args.hook != null) p.set("hook_id", String(args.hook))
    if (args.limit != null) p.set("limit", String(args.limit))

    const res = await irisFetch(hooksPath(String(args.slug), `/deliveries?${p}`))
    const ok = await handleApiError(res, "List deliveries")
    if (!ok) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    const rows: any[] = firstArray(((await res.json()) as any)?.data)

    // A bare array, newest first — so `--json | jq -e '.[0].status==200'` asks "did the last
    // attempt land?" without unwrapping anything.
    if (args.json) {
      await writeJson(rows)
      prompts.outro("Done")
      return
    }
    if (rows.length === 0) {
      prompts.log.warn("No deliveries yet")
      prompts.outro("Done")
      return
    }

    divider()
    for (const r of rows) {
      const status = r.status == null ? "—" : String(r.status)
      const mark = r.ok ? bold("✓") : "✗"
      console.log(
        `  ${mark} ${String(r.created_at ?? "").slice(0, 19).padEnd(20)} hook #${String(r.hook_id).padEnd(4)} ` +
          `${String(r.event).padEnd(8)} rec ${String(r.record_id ?? "—").padEnd(7)} ${status.padEnd(4)} ` +
          `${dim(`try ${r.attempt}  ${r.duration_ms ?? "?"}ms`)}${r.phi_included ? dim("  PHI") : ""}`,
      )
      if (r.error) console.log(`      ${dim(r.error)}${r.next_retry_at ? dim(`  — retry at ${r.next_retry_at}`) : ""}`)
    }
    divider()
    prompts.outro("Done")
  },
})

export const DatasetHooksGroup = cmd({
  command: "hooks",
  aliases: ["hook", "webhooks"],
  describe: "webhooks — POST to a URL when a record is created, updated or deleted",
  builder: (y) =>
    y.command(HookAddCommand).command(HookListCommand).command(HookRemoveCommand).command(HookDeliveriesCommand).demandCommand(),
  async handler() {},
})
