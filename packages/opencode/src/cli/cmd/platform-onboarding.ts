import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, writeJson } from "./iris-api"
import * as fs from "fs"

// ============================================================================
// Onboarding Flows CLI
//
// A multi-step, resumable, public signup flow — anonymous start, magic-link
// resume, and a claim step that reattaches the session to an account created
// afterwards. All of it has existed in fl-api for months.
//
// It stayed invisible because a flow is not a table: it lives in
// `atlas_schemas.settings` under `flow_type: "onboarding"`, and the only CLI
// that touches atlas_schemas never passed `settings`. So a flow could only be
// created by hand against the API, nobody did, and the capability read as
// missing. This file is that missing surface.
//
// Routes: /api/v1/onboarding/* (fl-api) + /api/v1/atlas/schemas for writes.
// ============================================================================

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

function readJsonArg(v: string | undefined, label: string): { ok: boolean; value?: any } {
  if (!v) return { ok: true, value: undefined }
  try {
    if (v.endsWith(".json") && fs.existsSync(v)) return { ok: true, value: JSON.parse(fs.readFileSync(v, "utf8")) }
    return { ok: true, value: JSON.parse(v) }
  } catch {
    prompts.log.error(`Invalid JSON for --${label}`)
    return { ok: false }
  }
}

/** Fetch the newest version of a flow's backing schema so we can edit its settings. */
async function loadFlowSchema(slug: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/atlas/schemas/${slug}`)
  if (!res.ok) return null
  const data = ((await res.json()) as any)?.data ?? null
  if (!data) return null
  // GET  /atlas/schemas/{slug} responds { schema, record_count }.
  // PATCH the same path responds with the schema DIRECTLY.
  // Reading `.settings` off the GET shape therefore yielded undefined, and
  // patchSettings then PATCHed a settings blob with no `steps` — and updateSchema
  // does `settings => $request->input('settings', $current->settings)`, i.e. a
  // wholesale REPLACE. So `flows publish` silently wiped every step (#181824),
  // and `flows steps` wiped branding, completion and the published status.
  // Unwrap both shapes rather than trusting either.
  return data.schema ?? data
}

// ── FLOWS ────────────────────────────────────────────────────────────────────

const FlowsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list onboarding flows",
  builder: (y) =>
    y.option("bloq", { type: "number", describe: "filter by bloq" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Onboarding Flows")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const p = new URLSearchParams()
      if (args.bloq != null) p.set("bloq_id", String(args.bloq))
      const res = await irisFetch(`/api/v1/onboarding/flows?${p}`)
      const ok = await handleApiError(res, "List flows"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const rows: any[] = ((await res.json()) as any)?.flows ?? []
      spinner.stop(`${rows.length} flow(s)`)

      if (args.json) { await writeJson(rows); prompts.outro("Done"); return }
      if (rows.length === 0) {
        prompts.log.warn("No onboarding flows yet")
        prompts.outro("iris onboarding scaffold my-flow  →  then  iris onboarding flows create")
        return
      }

      printDivider()
      for (const f of rows) {
        const a = f.analytics ?? {}
        const started = a.started_count ?? 0
        const done = a.completed_count ?? 0
        console.log(
          `  ${bold(f.slug)}  ${dim(f.status ?? "draft")}  ${dim(`${f.steps_count ?? 0} steps`)}` +
          `  ${dim(`${done}/${started} completed`)}`
        )
        if (f.name && f.name !== f.slug) console.log(`    ${dim(f.name)}`)
      }
      printDivider()
      prompts.outro("iris onboarding flows show <slug>")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const FlowsShowCommand = cmd({
  command: "show <slug>",
  aliases: ["view", "get"],
  describe: "show a flow's steps exactly as a page will receive them",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Flow: ${args.slug}`)

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      // Deliberately the PUBLIC config route — this is the exact payload a browser
      // gets, so what you read here is what the page will render. Reading the raw
      // schema instead would show a shape nobody actually receives.
      const res = await irisFetch(`/api/v1/onboarding/flows/${args.slug}`)
      const ok = await handleApiError(res, "Show flow"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const cfg = (await res.json()) as any
      spinner.stop(`${cfg.total_steps ?? 0} step(s)`)

      if (args.json) { await writeJson(cfg); prompts.outro("Done"); return }

      console.log(`  ${dim("Name:")}  ${cfg.name ?? "—"}`)
      console.log(`  ${dim("Slug:")}  ${cfg.slug}`)
      printDivider()
      const steps: any[] = cfg.steps ?? []
      steps.forEach((st, i) => {
        const kind = st.type ?? "?"
        const rep = st.repeatable ? dim(" · repeatable") : ""
        const sch = st.schema_slug ? dim(` · ${st.schema_slug}`) : ""
        console.log(`  ${dim(String(i).padStart(2, "0"))}  ${bold(st.title ?? kind)}  ${dim(kind)}${sch}${rep}`)
        const fields: any[] = st.fields ?? []
        for (const f of fields) {
          console.log(`      ${dim("·")} ${f.key ?? f.name}  ${dim(f.type ?? "text")}${f.required ? "  " + dim("required") : ""}`)
        }
      })
      printDivider()
      prompts.outro(`iris onboarding analytics ${args.slug}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const FlowsCreateCommand = cmd({
  command: "create",
  aliases: ["new"],
  describe: "create an onboarding flow (a schema whose settings carry the steps)",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true, describe: "flow name" })
      .option("slug", { type: "string", describe: "url-safe slug (auto from name if omitted)" })
      .option("bloq", { type: "number", describe: "bloq the completed sessions file into" })
      .option("steps", { type: "string", describe: "JSON steps array or path to .json file — see `iris onboarding scaffold`" })
      .option("fields", { type: "string", describe: "JSON fields for the parent record (default: none)" })
      .option("completion", { type: "string", describe: 'JSON completion config, e.g. {"create_lead":true}' })
      .option("publish", { type: "boolean", default: false, describe: "mark it published rather than draft" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Onboarding Flow")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const steps = readJsonArg(args.steps as string | undefined, "steps")
    if (!steps.ok) { prompts.outro("Done"); return }
    const fields = readJsonArg(args.fields as string | undefined, "fields")
    if (!fields.ok) { prompts.outro("Done"); return }
    const completion = readJsonArg(args.completion as string | undefined, "completion")
    if (!completion.ok) { prompts.outro("Done"); return }

    const stepList = Array.isArray(steps.value) ? steps.value : (steps.value?.steps ?? [])
    if (stepList.length === 0) {
      prompts.log.warn("A flow with no steps will render an empty form.")
      prompts.log.info(dim("iris onboarding scaffold <slug> > flow.json   →   --steps ./flow.json"))
    }

    const settings: Record<string, any> = {
      flow_type: "onboarding",
      status: args.publish ? "published" : "draft",
      steps: stepList,
    }
    if (completion.value !== undefined) settings.completion = completion.value

    const rawFields = fields.value ?? { fields: [] }
    const body: Record<string, any> = {
      name: args.name,
      fields: Array.isArray(rawFields) ? { fields: rawFields } : rawFields,
      settings,
    }
    if (args.slug) body.slug = args.slug
    if (args.bloq != null) body.bloq_id = args.bloq

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch("/api/v1/atlas/schemas", { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create flow"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      const slug = data?.slug ?? args.slug ?? args.name
      spinner.stop(`Created ${bold(slug)}  ${dim(args.publish ? "published" : "draft")}`)
      console.log(`  ${dim("Render it:")} a Genesis OnboardingFlow component with flowSlug="${slug}"`)
      console.log(`  ${dim("Or by hand:")} iris.onboarding.session("${slug}")  ${dim("(/js/iris-sdk.js)")}`)
      prompts.outro(`iris onboarding flows show ${slug}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

/** Shared by publish/unpublish and `steps set` — a settings patch keeps everything else intact. */
async function patchSettings(slug: string, mutate: (s: any) => any, label: string) {
  const spinner = prompts.spinner()
  spinner.start("Loading current flow…")
  const current = await loadFlowSchema(slug)
  if (!current) { spinner.stop("Flow not found", 1); prompts.outro("Done"); return }

  // The backend versions a schema on every PATCH and defaults `settings` to the
  // current value — so send the WHOLE blob back, mutated. Sending a fragment would
  // silently drop steps.
  const before = { ...(current.settings ?? {}) }
  const next = mutate(before)
  // Guard: a published flow with no steps renders an empty page and the CLI used to
  // print success anyway. If steps existed and the mutation lost them, that is the
  // bug above regressing — refuse rather than destroy.
  const hadSteps = Array.isArray(before.steps) ? before.steps.length : 0
  const willHave = Array.isArray(next.steps) ? next.steps.length : 0
  if (hadSteps > 0 && willHave === 0) {
    spinner.stop(`Refusing: this would drop all ${hadSteps} step(s)`, 1)
    prompts.outro("Done")
    return
  }
  spinner.message(label)
  const res = await irisFetch(`/api/v1/atlas/schemas/${slug}`, { method: "PATCH", body: JSON.stringify({ settings: next }) })
  const ok = await handleApiError(res, label); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
  const data = ((await res.json()) as any)?.data
  spinner.stop(`${label} → v${data?.version ?? "?"}  ${dim("(existing sessions preserved)")}`)
  prompts.outro(`iris onboarding flows show ${slug}`)
}

const FlowsPublishCommand = cmd({
  command: "publish <slug>",
  describe: "mark a flow published",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty(); prompts.intro(`◈  Publish: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    await patchSettings(args.slug as string, (s) => ({ ...s, flow_type: "onboarding", status: "published" }), "Published")
  },
})

const FlowsUnpublishCommand = cmd({
  command: "unpublish <slug>",
  describe: "put a flow back to draft",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty(); prompts.intro(`◈  Unpublish: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    await patchSettings(args.slug as string, (s) => ({ ...s, flow_type: "onboarding", status: "draft" }), "Back to draft")
  },
})

const FlowsStepsCommand = cmd({
  command: "steps <slug>",
  describe: "replace a flow's steps from JSON (branding and completion survive)",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true })
      .option("file", { type: "string", demandOption: true, describe: "JSON steps array or path to .json file" }),
  async handler(args) {
    UI.empty(); prompts.intro(`◈  Steps: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const parsed = readJsonArg(args.file as string, "file")
    if (!parsed.ok) { prompts.outro("Done"); return }
    const stepList = Array.isArray(parsed.value) ? parsed.value : (parsed.value?.steps ?? [])
    await patchSettings(args.slug as string, (s) => ({ ...s, flow_type: "onboarding", steps: stepList }), `Set ${stepList.length} step(s)`)
  },
})

const FlowsGroup = cmd({
  command: "flows",
  aliases: ["flow"],
  describe: "list, inspect, create and publish onboarding flows",
  builder: (y) =>
    y.command(FlowsListCommand).command(FlowsShowCommand).command(FlowsCreateCommand)
     .command(FlowsPublishCommand).command(FlowsUnpublishCommand).command(FlowsStepsCommand).demandCommand(),
  async handler() {},
})

// ── SESSIONS + ANALYTICS ─────────────────────────────────────────────────────

const SessionsCommand = cmd({
  command: "sessions <slug>",
  describe: "who started this flow, how far they got, and who stalled",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true })
      .option("status", { type: "string", describe: "in_progress | completed | abandoned" })
      .option("limit", { type: "number", default: 50 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Sessions: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const p = new URLSearchParams()
      if (args.status) p.set("status", String(args.status))
      p.set("limit", String(args.limit ?? 50))
      const res = await irisFetch(`/api/v1/onboarding/flows/${args.slug}/sessions?${p}`)
      const ok = await handleApiError(res, "List sessions"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const rows: any[] = body?.sessions ?? []
      spinner.stop(`${rows.length} session(s)`)

      if (args.json) { await writeJson(rows); prompts.outro("Done"); return }
      if (rows.length === 0) { prompts.log.warn("Nobody has started this flow yet"); prompts.outro("Done"); return }

      printDivider()
      for (const s of rows) {
        const who = s.contact?.name || s.contact?.email || dim("anonymous")
        const lead = s.lead_id ? dim(` lead#${s.lead_id}`) : ""
        console.log(`  ${bold(who)}  ${dim(s.status)}  ${dim(`step ${s.current_step}`)}  ${dim(`${s.steps_completed} filled`)}${lead}`)
        console.log(`    ${dim(s.session_token)}  ${dim(s.completed_at ?? s.started_at ?? s.created_at ?? "")}`)
      }
      printDivider()
      prompts.outro(`iris onboarding analytics ${args.slug}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const AnalyticsCommand = cmd({
  command: "analytics <slug>",
  aliases: ["stats"],
  describe: "started / completed / in-progress / abandoned, and the conversion rate",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Analytics: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await irisFetch(`/api/v1/onboarding/flows/${args.slug}/analytics`)
      const ok = await handleApiError(res, "Analytics"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const a = (await res.json()) as any
      spinner.stop(a.error ? "Not found" : "Loaded")
      if (args.json) { await writeJson(a); prompts.outro("Done"); return }
      if (a.error) { prompts.log.error(a.error); prompts.outro("Done"); return }

      printDivider()
      console.log(`  ${dim("Started")}      ${bold(String(a.started ?? 0))}`)
      console.log(`  ${dim("Completed")}    ${bold(String(a.completed ?? 0))}`)
      console.log(`  ${dim("In progress")}  ${bold(String(a.in_progress ?? 0))}`)
      console.log(`  ${dim("Abandoned")}    ${bold(String(a.abandoned ?? 0))}`)
      console.log(`  ${dim("Conversion")}   ${bold(`${a.conversion_rate ?? 0}%`)}`)
      printDivider()
      prompts.outro(`iris onboarding sessions ${args.slug} --status=in_progress`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── SCAFFOLD ─────────────────────────────────────────────────────────────────

const ScaffoldCommand = cmd({
  command: "scaffold [slug]",
  aliases: ["template", "example"],
  describe: "print a working flow definition to start from — the shape nobody could guess",
  builder: (y) =>
    y.positional("slug", { type: "string", describe: "used in the printed example" })
      .option("out", { type: "string", describe: "write to this file instead of stdout" }),
  async handler(args) {
    const slug = (args.slug as string) || "my-flow"
    // Every construct a real flow needs, in the order a page hits them: a plain
    // field step, a REPEATABLE step validated against a child schema, an optional
    // step, and the completion step that sends the resume link.
    const example = {
      steps: [
        {
          type: "fields",
          title: "Who you are",
          fields: [
            { key: "full_name", label: "Full name", type: "text", required: true },
            { key: "contact_email", label: "Email", type: "email", required: true },
          ],
        },
        {
          type: "schema",
          title: "Your history",
          schema_slug: `${slug}-entries`,
          repeatable: true,
        },
        {
          type: "fields",
          title: "Anything else",
          optional: true,
          fields: [{ key: "notes", label: "Notes", type: "text" }],
        },
        {
          type: "completion",
          title: "You're in",
          send_magic_link: true,
        },
      ],
      completion: { create_lead: true },
    }

    const json = JSON.stringify(example, null, 2)
    if (args.out) {
      fs.writeFileSync(args.out as string, json + "\n")
      UI.empty()
      prompts.intro("◈  Scaffold")
      prompts.log.success(`Wrote ${args.out}`)
      console.log(`  ${dim("Then:")} iris onboarding flows create --name="${slug}" --slug=${slug} --steps=${args.out}`)
      console.log(`  ${dim("Note:")} the repeatable step needs a child schema — iris atlas:datasets schemas create --slug=${slug}-entries --fields=…`)
      prompts.outro("Done")
      return
    }
    console.log(json)
  },
})

export const PlatformOnboardingCommand = cmd({
  command: "onboarding",
  aliases: ["onboard", "flows"],
  describe: "multi-step signup flows — public, resumable, magic-link, claimable",
  builder: (y) =>
    y.command(FlowsGroup).command(SessionsCommand).command(AnalyticsCommand).command(ScaffoldCommand).demandCommand(),
  async handler() {},
})
