import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold } from "./iris-api"

// ============================================================================
// Brand CLI — first-class brand entity
//
// Maps to fl-api routes added in 2026_04_09:
//   GET    /api/v1/brands
//   POST   /api/v1/brands
//   GET    /api/v1/brands/{id}
//   PATCH  /api/v1/brands/{id}
//   DELETE /api/v1/brands/{id}
//   POST   /api/v1/brands/{id}/integrations/{integrationId}      (attach)
//   DELETE /api/v1/brands/{id}/integrations/{integrationId}      (detach)
//   POST   /api/v1/brands/{id}/personas/{personaId}/default
//   *      /api/v1/brands/{brandId}/personas[/...]
//
// Social accounts and assets do NOT have nested brand routes.
// They live on the existing endpoints filtered by ?brand_id=N:
//   GET /api/v1/integrations?brand_id=N&category=social
//   GET /api/v1/cloud-files?brand_id=N
// ============================================================================

function printBrand(b: Record<string, unknown>): void {
  const name = bold(String(b.name ?? `Brand #${b.id}`))
  const slug = dim(`(${b.slug})`)
  const id = dim(`#${b.id}`)
  const status = b.status === "active" ? "" : dim(` [${b.status}]`)
  console.log(`  ${name}  ${slug}  ${id}${status}`)
  if (b.description) {
    console.log(`    ${dim(String(b.description).slice(0, 100))}`)
  }
  const personas = Array.isArray(b.personas) ? b.personas.length : 0
  const integrations = Array.isArray(b.integrations) ? b.integrations.length : 0
  const assets = Array.isArray(b.assets) ? b.assets.length : 0
  if (personas + integrations + assets > 0) {
    console.log(`    ${dim(`personas=${personas}  integrations=${integrations}  assets=${assets}`)}`)
  }
}

// ----------------------------------------------------------------------------
// brands list
// ----------------------------------------------------------------------------
const BrandsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list brands you manage",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("bloq", { describe: "filter by bloq id", type: "number" })
      .option("status", { describe: "active|archived|draft", type: "string" })
      .option("search", { describe: "search by name or slug", type: "string" })
      .option("limit", { describe: "max results", type: "number", default: 50 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Brands")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"]); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading brands…")
    try {
      const params = new URLSearchParams({ user_id: String(userId), per_page: String(args.limit) })
      if (args.bloq != null) params.set("bloq_id", String(args.bloq))
      if (args.status) params.set("status", String(args.status))
      if (args.search) params.set("search", String(args.search))

      const res = await irisFetch(`/api/v1/brands?${params}`)
      const ok = await handleApiError(res, "List brands"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const brands: any[] = (data?.data?.data ?? data?.data ?? []) as any[]
      spinner.stop(`${brands.length} brand(s)`)

      if (brands.length === 0) {
        prompts.log.warn("No brands found")
        prompts.outro(`Create one: ${dim("iris brands create")}`)
        return
      }

      printDivider()
      for (const b of brands) {
        printBrand(b)
        console.log()
      }
      printDivider()
      prompts.outro(`${dim("iris brands show <id>")}  ·  ${dim("iris brands create")}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// brands show
// ----------------------------------------------------------------------------
const BrandsShowCommand = cmd({
  command: "show <id>",
  aliases: ["get"],
  describe: "show brand details with personas, integrations, assets",
  builder: (yargs) =>
    yargs.positional("id", { describe: "brand ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Brand #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.id}`)
      const ok = await handleApiError(res, "Get brand"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const b = data?.data ?? data
      spinner.stop(String(b.name ?? `Brand #${b.id}`))

      printDivider()
      printKV("ID", b.id)
      printKV("Slug", b.slug)
      printKV("Name", b.name)
      printKV("Entity Type", b.entity_type)
      printKV("Status", b.status)
      printKV("Bloq", b.bloq_id ?? dim("(reusable / no bloq)"))
      if (b.parent_brand_id) printKV("Parent", `#${b.parent_brand_id}`)
      if (b.description) printKV("Description", b.description)
      console.log()

      if (Array.isArray(b.personas) && b.personas.length > 0) {
        console.log(bold("Personas:"))
        for (const p of b.personas) {
          const star = p.is_default ? "★ " : "  "
          console.log(`  ${star}${bold(p.name)}  ${dim(`#${p.id}`)}${p.archetype ? dim(` [${p.archetype}]`) : ""}`)
          if (p.tone) console.log(`      ${dim(String(p.tone).slice(0, 100))}`)
        }
        console.log()
      }

      if (Array.isArray(b.integrations) && b.integrations.length > 0) {
        console.log(bold("Integrations:"))
        for (const i of b.integrations) {
          console.log(`  ${bold(i.name ?? i.type)}  ${dim(`#${i.id} ${i.type}`)} ${dim(`[${i.status}]`)}`)
        }
        console.log()
      }

      if (Array.isArray(b.assets) && b.assets.length > 0) {
        console.log(bold("Assets:"))
        for (const a of b.assets) {
          console.log(`  ${bold(a.original_filename ?? a.filename)}  ${dim(`#${a.id}`)}`)
        }
        console.log()
      }

      printDivider()
      prompts.outro(
        `${dim("iris brands personas add " + b.id)}  ·  ${dim("iris brands attach " + b.id + " <int_id>")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// brands create
// ----------------------------------------------------------------------------
const BrandsCreateCommand = cmd({
  command: "create",
  aliases: ["new"],
  describe: "create a new brand",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "brand name", type: "string", demandOption: true })
      .option("slug", { describe: "url slug (a-z 0-9 - _)", type: "string", demandOption: true })
      .option("entity-type", { describe: "creator|studio|venue|business|service|brand", type: "string", default: "brand" })
      .option("bloq", { describe: "scope to bloq id (omit for reusable)", type: "number" })
      .option("parent", { describe: "parent brand id (sub-brand)", type: "number" })
      .option("description", { describe: "description", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Brand")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"]); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const body: Record<string, unknown> = {
        user_id: userId,
        name: args.name,
        slug: args.slug,
        entity_type: args["entity-type"],
      }
      if (args.bloq != null) body.bloq_id = args.bloq
      if (args.parent != null) body.parent_brand_id = args.parent
      if (args.description) body.description = args.description

      const res = await irisFetch(`/api/v1/brands`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create brand"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const b = data?.data ?? data
      spinner.stop(`Created ${bold(b.name)} ${dim(`#${b.id}`)}`)

      prompts.outro(`${dim("iris brands show " + b.id)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// brands update
// ----------------------------------------------------------------------------
const BrandsUpdateCommand = cmd({
  command: "update <id>",
  describe: "update a brand",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "brand ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("status", { describe: "active|archived|draft", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("entity-type", { describe: "creator|studio|venue|business|service|brand", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Brand #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const body: Record<string, unknown> = {}
    if (args.name) body.name = args.name
    if (args.status) body.status = args.status
    if (args.description) body.description = args.description
    if (args["entity-type"]) body.entity_type = args["entity-type"]
    if (Object.keys(body).length === 0) {
      prompts.log.warn("Nothing to update — pass --name, --status, --description, or --entity-type")
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.id}`, { method: "PATCH", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Update brand"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Updated")
      prompts.outro(`${dim("iris brands show " + args.id)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// brands delete
// ----------------------------------------------------------------------------
const BrandsDeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["rm"],
  describe: "delete a brand (integrations/assets are unlinked, not deleted)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "brand ID", type: "number", demandOption: true })
      .option("yes", { describe: "skip confirmation", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Brand #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    if (!args.yes) {
      const confirmed = await prompts.confirm({ message: `Delete brand #${args.id}? Personas will be removed; integrations and assets are unlinked but kept.` })
      if (prompts.isCancel(confirmed) || !confirmed) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete brand"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Deleted")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// brands attach <brand-id> <integration-id>   — sets integrations.brand_id
// ----------------------------------------------------------------------------
const BrandsAttachCommand = cmd({
  command: "attach <brandId> <integrationId>",
  describe: "link an existing integration to a brand",
  builder: (yargs) =>
    yargs
      .positional("brandId", { describe: "brand ID", type: "number", demandOption: true })
      .positional("integrationId", { describe: "integration ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Attach integration #${args.integrationId} → brand #${args.brandId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Attaching…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/integrations/${args.integrationId}`, { method: "POST", body: JSON.stringify({}) })
      const ok = await handleApiError(res, "Attach"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Attached")
      prompts.outro(`${dim("iris brands show " + args.brandId)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// brands detach <brand-id> <integration-id>   — nulls integrations.brand_id
// ----------------------------------------------------------------------------
const BrandsDetachCommand = cmd({
  command: "detach <brandId> <integrationId>",
  describe: "unlink an integration from a brand (integration row preserved)",
  builder: (yargs) =>
    yargs
      .positional("brandId", { describe: "brand ID", type: "number", demandOption: true })
      .positional("integrationId", { describe: "integration ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Detach integration #${args.integrationId} from brand #${args.brandId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Detaching…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/integrations/${args.integrationId}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Detach"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Detached")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// brands personas <subcommand>
// ============================================================================

const PersonasListCommand = cmd({
  command: "list <brandId>",
  aliases: ["ls"],
  describe: "list personas for a brand",
  builder: (yargs) =>
    yargs.positional("brandId", { describe: "brand ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Personas for brand #${args.brandId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/personas`)
      const ok = await handleApiError(res, "List personas"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const personas: any[] = data?.data ?? []
      spinner.stop(`${personas.length} persona(s)`)

      if (personas.length === 0) {
        prompts.log.warn("No personas — add one with `iris brands personas add`")
        prompts.outro("Done"); return
      }

      printDivider()
      for (const p of personas) {
        const star = p.is_default ? "★ " : "  "
        console.log(`${star}${bold(p.name)}  ${dim(`#${p.id}`)}${p.archetype ? dim(` [${p.archetype}]`) : ""}`)
        if (p.tone) console.log(`    ${dim("tone: " + String(p.tone).slice(0, 100))}`)
        if (p.voice_sample_id) console.log(`    ${dim("voice_sample_id: " + p.voice_sample_id)}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PersonasAddCommand = cmd({
  command: "add <brandId>",
  aliases: ["create"],
  describe: "add a persona to a brand",
  builder: (yargs) =>
    yargs
      .positional("brandId", { describe: "brand ID", type: "number", demandOption: true })
      .option("name", { describe: "persona name", type: "string", demandOption: true })
      .option("archetype", { describe: "trusted_planner|hype_curator|newscaster|...", type: "string" })
      .option("tone", { describe: "free-form tone", type: "string" })
      .option("system-prompt", { describe: "AI system prompt", type: "string" })
      .option("voice-sample-id", { describe: "FK voice_samples.id", type: "number" })
      .option("default", { describe: "make this the default persona", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add persona to brand #${args.brandId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const body: Record<string, unknown> = { name: args.name, is_default: args.default }
    if (args.archetype) body.archetype = args.archetype
    if (args.tone) body.tone = args.tone
    if (args["system-prompt"]) body.system_prompt = args["system-prompt"]
    if (args["voice-sample-id"] != null) body.voice_sample_id = args["voice-sample-id"]

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/personas`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create persona"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const p = data?.data ?? data
      spinner.stop(`Created ${bold(p.name)} ${dim(`#${p.id}`)}`)
      prompts.outro(`${dim("iris brands personas list " + args.brandId)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PersonasUpdateCommand = cmd({
  command: "update <brandId> <personaId>",
  describe: "update a persona",
  builder: (yargs) =>
    yargs
      .positional("brandId", { describe: "brand ID", type: "number", demandOption: true })
      .positional("personaId", { describe: "persona ID", type: "number", demandOption: true })
      .option("name", { describe: "name", type: "string" })
      .option("archetype", { describe: "archetype", type: "string" })
      .option("tone", { describe: "tone", type: "string" })
      .option("system-prompt", { describe: "AI system prompt", type: "string" })
      .option("voice-sample-id", { describe: "FK voice_samples.id", type: "number" })
      .option("default", { describe: "make default", type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update persona #${args.personaId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const body: Record<string, unknown> = {}
    if (args.name) body.name = args.name
    if (args.archetype) body.archetype = args.archetype
    if (args.tone) body.tone = args.tone
    if (args["system-prompt"]) body.system_prompt = args["system-prompt"]
    if (args["voice-sample-id"] != null) body.voice_sample_id = args["voice-sample-id"]
    if (args.default != null) body.is_default = args.default
    if (Object.keys(body).length === 0) { prompts.log.warn("Nothing to update"); prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/personas/${args.personaId}`, { method: "PATCH", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Update persona"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Updated")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PersonasDeleteCommand = cmd({
  command: "delete <brandId> <personaId>",
  aliases: ["rm"],
  describe: "delete a persona",
  builder: (yargs) =>
    yargs
      .positional("brandId", { describe: "brand ID", type: "number", demandOption: true })
      .positional("personaId", { describe: "persona ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete persona #${args.personaId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/personas/${args.personaId}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete persona"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Deleted")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PersonasDefaultCommand = cmd({
  command: "default <brandId> <personaId>",
  describe: "set the default persona for a brand",
  builder: (yargs) =>
    yargs
      .positional("brandId", { describe: "brand ID", type: "number", demandOption: true })
      .positional("personaId", { describe: "persona ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set default persona`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const res = await irisFetch(`/api/v1/brands/${args.brandId}/personas/${args.personaId}/default`, { method: "POST", body: JSON.stringify({}) })
      const ok = await handleApiError(res, "Set default"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Default set")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PersonasGroup = cmd({
  command: "personas",
  describe: "manage brand personas (voice / tone / AI config)",
  builder: (yargs) =>
    yargs
      .command(PersonasListCommand)
      .command(PersonasAddCommand)
      .command(PersonasUpdateCommand)
      .command(PersonasDeleteCommand)
      .command(PersonasDefaultCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformBrandsCommand = cmd({
  command: "brands",
  aliases: ["brand"],
  describe: "manage first-class brands (personas, integrations, assets)",
  builder: (yargs) =>
    yargs
      .command(BrandsListCommand)
      .command(BrandsShowCommand)
      .command(BrandsCreateCommand)
      .command(BrandsUpdateCommand)
      .command(BrandsDeleteCommand)
      .command(BrandsAttachCommand)
      .command(BrandsDetachCommand)
      .command(PersonasGroup)
      .demandCommand(),
  async handler() {},
})
