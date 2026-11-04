import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, PLATFORM_URLS, writeJson } from "./iris-api"
import { getBySlug } from "./platform-pages"
import {
  MAX_PER_HOUR,
  MAX_PER_SENDER,
  buildLane,
  fetchSnippet,
  laneUrl,
  mergeSettings,
  readProbe,
  type LaneConfig,
} from "./public-submit-lane"

// ============================================================================
// iris datasets public-submit — a public form writes into a private dataset (#192478)
//
// The lane itself is server-side (fl-iris-api App\Support\PublicSubmissions, #192455): a dataset
// opts in through settings.public_submit, then POST /api/v1/app-data/{page}/{collection} adds one
// record — write-only, pinned to the page owner, rate-limited, honeypot-guarded. These commands
// turn it on, show it, prove it answers, and turn it off, without hand-writing the JSON.
// ============================================================================

async function loadSchema(slug: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/atlas/schemas/${encodeURIComponent(slug)}`)
  if (!(await handleApiError(res, "Read dataset"))) return null
  const body = (await res.json()) as any
  return body?.data?.schema ?? body?.data ?? null
}

function settingsOf(schema: any): Record<string, any> {
  const s = schema?.settings
  if (!s) return {}
  if (typeof s === "string") {
    try { return JSON.parse(s) } catch { return {} }
  }
  return typeof s === "object" ? s : {}
}

function fieldKeys(schema: any): string[] {
  const defs = schema?.fields?.fields ?? schema?.fields ?? []
  return Array.isArray(defs) ? defs.map((f: any) => f?.key).filter(Boolean) : []
}

function printLane(lane: LaneConfig, slug: string) {
  const url = laneUrl(PLATFORM_URLS.publicSite, lane.page, lane.collection)
  console.log(`  ${dim("Dataset:")}     ${bold(slug)}`)
  console.log(`  ${dim("Lane:")}        ${lane.enabled ? bold("on") : "off"}`)
  console.log(`  ${dim("Posts to:")}    ${url}`)
  if (lane.require_any?.length) console.log(`  ${dim("Requires:")}    one of ${lane.require_any.join(", ")}`)
  if (lane.set && Object.keys(lane.set).length) console.log(`  ${dim("Always sets:")} ${Object.entries(lane.set).map(([k, v]) => `${k}=${v}`).join(", ")}`)
  if (lane.aliases && Object.keys(lane.aliases).length) console.log(`  ${dim("Aliases:")}     ${Object.entries(lane.aliases).map(([k, v]) => `${k}→${v}`).join(", ")}`)
  console.log(`  ${dim("Sites:")}       same host, heyiris.io${lane.origins?.length ? ", " + lane.origins.join(", ") : ""}`)
  console.log(`  ${dim("Limits:")}      ${Math.min(lane.per_sender ?? 5, MAX_PER_SENDER)} per sender / 10 min · ${Math.min(lane.per_hour ?? 200, MAX_PER_HOUR)} per hour`)
  console.log(`  ${dim("Reads back:")}  nothing — the dataset stays private; staff read it signed in`)
}

/**
 * The page a lane is addressed under. The server only honours a lane whose page is PUBLISHED and
 * owned by a board belonging to the dataset's owner — say so now rather than leave a dead lane.
 */
async function checkPage(page: string, schema: any): Promise<string[]> {
  const problems: string[] = []
  let p: any = null
  try { p = await getBySlug(page, false, { quiet404: true }) } catch { /* reported below */ }
  if (!p) return [`Page '${page}' was not found. A lane is addressed under a published page the dataset's owner owns.`]
  if (p.status !== "published") problems.push(`Page '${page}' is ${p.status ?? "not published"} — the lane answers only once it is published.`)
  if (p.owner_type !== "bloq") problems.push(`Page '${page}' is not owned by a board — the server resolves the lane's owner from the page's board.`)
  else if (schema?.bloq_id && Number(p.owner_id) !== Number(schema.bloq_id)) {
    problems.push(`Page '${page}' is on board ${p.owner_id}, the dataset on board ${schema.bloq_id}. That works only if both boards belong to the same account.`)
  }
  return problems
}

const ShowCommand = cmd({
  command: "show <slug>",
  describe: "show a dataset's public submit lane — where it posts, what it accepts, what it refuses",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Public submit: ${args.slug}`) }
    if (!(await requireAuth())) { if (!args.json) prompts.outro("Done"); return }
    const schema = await loadSchema(String(args.slug))
    if (!schema) { process.exitCode = 1; if (!args.json) prompts.outro("Done"); return }
    const lane = settingsOf(schema).public_submit as LaneConfig | undefined
    if (args.json) { await writeJson({ dataset: args.slug, lane: lane ?? null }); return }
    if (!lane) {
      prompts.log.info(`No lane. Turn one on:\n  iris datasets public-submit enable ${args.slug} --page <published-page> --collection submissions --require <field>`)
      prompts.outro("Done")
      return
    }
    printLane(lane, String(args.slug))
    prompts.outro(lane.enabled ? `Prove it answers: iris datasets public-submit test ${args.slug}` : "Done")
  },
})

const EnableCommand = cmd({
  command: "enable <slug>",
  aliases: ["on"],
  describe: "let a public form add records to this dataset — write-only, nothing is read back",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true, describe: "dataset (schema) slug" })
      .option("page", { type: "string", describe: "published page slug the lane is addressed under" })
      .option("collection", { type: "string", describe: "lane name in the URL, e.g. submissions" })
      .option("require", { type: "array", string: true, describe: "fields of which at least one must be filled (repeat or comma-separate)" })
      .option("set", { type: "array", string: true, describe: "field=value the server always writes (the sender cannot change it)" })
      .option("alias", { type: "array", string: true, describe: "sent_name=field — accept an older field name" })
      .option("origin", { type: "array", string: true, describe: "another site allowed to post (host name)" })
      .option("ref-prefix", { type: "string", describe: "letters in front of each reference, e.g. INTAKE" })
      .option("per-sender", { type: "number", describe: `submissions per address per 10 minutes (max ${MAX_PER_SENDER})` })
      .option("per-hour", { type: "number", describe: `submissions per hour for the whole lane (max ${MAX_PER_HOUR})` })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would be stored; change nothing" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Enable public submit: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const schema = await loadSchema(String(args.slug))
    if (!schema) { process.exitCode = 1; prompts.outro("Nothing changed"); return }

    const current = settingsOf(schema)
    const built = buildLane(current.public_submit, {
      page: args.page as string | undefined,
      collection: args.collection as string | undefined,
      require: args.require as string[] | undefined,
      set: args.set as string[] | undefined,
      alias: args.alias as string[] | undefined,
      origin: args.origin as string[] | undefined,
      refPrefix: args["ref-prefix"] as string | undefined,
      perSender: args["per-sender"] as number | undefined,
      perHour: args["per-hour"] as number | undefined,
    }, fieldKeys(schema))
    for (const w of built.warnings) prompts.log.warn(w)
    if (!built.lane) {
      for (const e of built.errors) prompts.log.error(e)
      process.exitCode = 1
      prompts.outro("Nothing changed")
      return
    }
    for (const p of await checkPage(built.lane.page, schema)) prompts.log.warn(p)

    printLane(built.lane, String(args.slug))
    if (args["dry-run"]) { prompts.outro("Dry run — nothing changed"); return }

    // Settings are replaced WHOLESALE by the endpoint, so send everything that was there with only
    // public_submit changed. It also cuts a new schema version — say so.
    const res = await irisFetch(`/api/v1/atlas/schemas/${encodeURIComponent(String(args.slug))}`, {
      method: "PATCH",
      body: JSON.stringify({ settings: mergeSettings(current, built.lane) }),
    })
    if (!(await handleApiError(res, "Enable lane"))) { process.exitCode = 1; prompts.outro("Nothing changed"); return }
    const after = await loadSchema(String(args.slug))
    const stored = settingsOf(after).public_submit as LaneConfig | undefined
    if (!stored?.enabled || stored.page !== built.lane.page || stored.collection !== built.lane.collection) {
      prompts.log.error("The API accepted the change but the lane does not read back as enabled. Check: iris datasets public-submit show " + args.slug)
      process.exitCode = 1
      prompts.outro("Not confirmed")
      return
    }
    prompts.log.info(dim(`Schema is now v${after?.version ?? "?"} (a settings change cuts a new version).`))
    const path = `/api/v1/app-data/${built.lane.page}/${built.lane.collection}`
    prompts.log.info(`For a hand-written page on the same site:\n\n${fetchSnippet(path, fieldKeys(schema).filter((k) => !(k in (built.lane!.set ?? {}))))}`)
    prompts.outro(`Prove it answers: iris datasets public-submit test ${args.slug}`)
  },
})

const DisableCommand = cmd({
  command: "disable <slug>",
  aliases: ["off"],
  describe: "stop accepting public submissions — the lane's settings are kept for a later enable",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Disable public submit: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const schema = await loadSchema(String(args.slug))
    if (!schema) { process.exitCode = 1; prompts.outro("Nothing changed"); return }
    const current = settingsOf(schema)
    if (!current.public_submit?.enabled) { prompts.outro("No lane is on — nothing to change"); return }
    const res = await irisFetch(`/api/v1/atlas/schemas/${encodeURIComponent(String(args.slug))}`, {
      method: "PATCH",
      body: JSON.stringify({ settings: mergeSettings(current, null) }),
    })
    if (!(await handleApiError(res, "Disable lane"))) { process.exitCode = 1; prompts.outro("Nothing changed"); return }
    const stored = settingsOf(await loadSchema(String(args.slug))).public_submit
    if (stored?.enabled) { prompts.log.error("The lane still reads back as on."); process.exitCode = 1; prompts.outro("Not confirmed"); return }
    prompts.outro("Lane off — public submissions are refused from now on")
  },
})

const TestCommand = cmd({
  command: "test <slug>",
  aliases: ["probe"],
  describe: "prove the lane answers — sends a honeypot probe the server drops, so nothing is saved",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Test public submit: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const schema = await loadSchema(String(args.slug))
    if (!schema) { process.exitCode = 1; prompts.outro("Done"); return }
    const lane = settingsOf(schema).public_submit as LaneConfig | undefined
    if (!lane?.enabled) { prompts.log.error("No lane is on for this dataset."); process.exitCode = 1; prompts.outro("Done"); return }

    // A probe with the honeypot filled: a live lane answers like a success and saves nothing.
    const url = laneUrl(PLATFORM_URLS.publicSite, lane.page, lane.collection)
    const t0 = Date.now()
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ website: "iris-public-submit-probe" }),
    })
    const ms = Date.now() - t0
    const body = await res.json().catch(() => ({}))
    const verdict = readProbe(res.status, body)
    if (verdict.live) prompts.log.success(`${verdict.message}  ${dim(`(${ms} ms)`)}`)
    else { prompts.log.error(verdict.message); process.exitCode = 1 }
    prompts.outro(url)
  },
})

export const DatasetPublicSubmitGroup = cmd({
  command: "public-submit",
  aliases: ["public-lane", "intake-lane"],
  describe: "let a public form add records to a private dataset — show, enable, disable, test",
  builder: (y) => y.command(ShowCommand).command(EnableCommand).command(DisableCommand).command(TestCommand).demandCommand(),
  async handler() {},
})
