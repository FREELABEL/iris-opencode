import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold } from "./iris-api"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"

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
  const meta = b.metadata as Record<string, unknown> | undefined
  const tokenGroups = meta?.design_tokens && typeof meta.design_tokens === "object" ? Object.keys(meta.design_tokens).length : 0
  const parts: string[] = []
  if (personas > 0) parts.push(`personas=${personas}`)
  if (integrations > 0) parts.push(`integrations=${integrations}`)
  if (assets > 0) parts.push(`assets=${assets}`)
  if (tokenGroups > 0) parts.push(`tokens=${tokenGroups}`)
  if (parts.length > 0) {
    console.log(`    ${dim(parts.join("  "))}`)
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
      .option("limit", { describe: "max results", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  IRIS Brands") }
    const token = await requireAuth(); if (!token) { if (!args.json) prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"]); if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading brands…")
    try {
      const params = new URLSearchParams({ user_id: String(userId), per_page: String(args.limit) })
      if (args.bloq != null) params.set("bloq_id", String(args.bloq))
      if (args.status) params.set("status", String(args.status))
      if (args.search) params.set("search", String(args.search))

      const res = await irisFetch(`/api/v1/brands?${params}`)
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "List brands"); prompts.outro("Done"); return
      }

      const data = (await res.json()) as { data?: any }
      const brands: any[] = (data?.data?.data ?? data?.data ?? []) as any[]

      if (args.json) { console.log(JSON.stringify(brands, null, 2)); return }

      if (spinner) spinner.stop(`${brands.length} brand(s)`)

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
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
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

      // Design tokens summary
      const dt = b.metadata?.design_tokens
      if (dt && typeof dt === "object" && Object.keys(dt).length > 0) {
        const groups = Object.keys(dt)
        console.log(bold("Design Tokens:"))
        console.log(`  ${groups.join(", ")}  ${dim(`(${groups.length} groups)`)}`)
        console.log()
      }

      printDivider()
      prompts.outro(
        `${dim("iris brands dt get " + (b.slug ?? b.id))}  ·  ${dim("iris brands personas add " + b.id)}  ·  ${dim("iris brands attach " + b.id + " <int_id>")}`,
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
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Brand #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
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
// brands design-tokens <subcommand>
// ============================================================================

function parseCssVars(css: string): Record<string, Record<string, string>> {
  const tokens: Record<string, Record<string, string>> = {}
  const varRe = /--([\w-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = varRe.exec(css)) !== null) {
    const name = m[1].trim()
    const value = m[2].trim()
    // Group by prefix: --sp-emerald-800 → emerald.800
    const parts = name.replace(/^sp-/, "").split("-")
    const group = parts[0]
    const key = parts.slice(1).join("-") || "default"
    if (!tokens[group]) tokens[group] = {}
    tokens[group][key] = value
  }
  return tokens
}

function tokensToCSS(tokens: Record<string, unknown>, brandSlug: string): string {
  const prefix = brandSlug.slice(0, 4).toLowerCase()
  const lines: string[] = [`:root {`]

  function flatten(obj: Record<string, unknown>, path: string): void {
    for (const [k, v] of Object.entries(obj)) {
      const varName = path ? `${path}-${k}` : k
      if (v && typeof v === "object" && !Array.isArray(v)) {
        flatten(v as Record<string, unknown>, varName)
      } else {
        lines.push(`  --${prefix}-${varName}: ${String(v)};`)
      }
    }
  }

  if (tokens.colors) flatten(tokens.colors as Record<string, unknown>, "")
  if (tokens.semantic) {
    lines.push("")
    for (const [k, v] of Object.entries(tokens.semantic as Record<string, string>)) {
      lines.push(`  --${prefix}-${k.replace(/_/g, "-")}: ${v};`)
    }
  }
  if (tokens.typography) {
    lines.push("")
    const typo = tokens.typography as Record<string, unknown>
    if (typo.heading && typeof typo.heading === "object") {
      const h = typo.heading as Record<string, unknown>
      lines.push(`  --${prefix}-font-serif: ${JSON.stringify(h.family)}, ${h.fallback || "serif"};`)
    }
    if (typo.body && typeof typo.body === "object") {
      const b = typo.body as Record<string, unknown>
      lines.push(`  --${prefix}-font-sans: ${JSON.stringify(b.family)}, ${b.fallback || "sans-serif"};`)
    }
  }
  lines.push("}")
  return lines.join("\n") + "\n"
}

function tokensToMarkdown(tokens: Record<string, unknown>, brandName: string): string {
  const lines: string[] = [`# ${brandName} Design Guidelines`, ""]

  if (tokens.colors && typeof tokens.colors === "object") {
    lines.push("## Colors", "")
    for (const [group, shades] of Object.entries(tokens.colors as Record<string, unknown>)) {
      lines.push(`### ${group.charAt(0).toUpperCase() + group.slice(1)}`, "")
      if (shades && typeof shades === "object") {
        lines.push("| Shade | Value |", "|-------|-------|")
        for (const [shade, val] of Object.entries(shades as Record<string, string>)) {
          lines.push(`| ${shade} | \`${val}\` |`)
        }
      } else {
        lines.push(`\`${String(shades)}\``)
      }
      lines.push("")
    }
  }

  if (tokens.typography && typeof tokens.typography === "object") {
    lines.push("## Typography", "")
    for (const [role, cfg] of Object.entries(tokens.typography as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const c = cfg as Record<string, unknown>
        lines.push(`- **${role}**: ${c.family} (weights: ${Array.isArray(c.weights) ? c.weights.join(", ") : "400"})`)
      }
    }
    lines.push("")
  }

  if (tokens.semantic && typeof tokens.semantic === "object") {
    lines.push("## Semantic Tokens", "")
    lines.push("| Token | Value |", "|-------|-------|")
    for (const [k, v] of Object.entries(tokens.semantic as Record<string, string>)) {
      lines.push(`| ${k} | \`${v}\` |`)
    }
    lines.push("")
  }

  if (tokens.components && typeof tokens.components === "object") {
    lines.push("## Components", "")
    for (const [comp, cfg] of Object.entries(tokens.components as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const pairs = Object.entries(cfg as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(", ")
        lines.push(`- **${comp}**: ${pairs}`)
      }
    }
    lines.push("")
  }

  if (tokens.voice && typeof tokens.voice === "object") {
    const v = tokens.voice as Record<string, unknown>
    lines.push("## Voice & Tone", "")
    if (v.tone) lines.push(`**Tone**: ${v.tone}`, "")
    if (v.vocabulary && typeof v.vocabulary === "object") {
      lines.push("**Vocabulary**:", "")
      for (const [k, val] of Object.entries(v.vocabulary as Record<string, string>)) {
        lines.push(`- ${k}: "${val}"`)
      }
      lines.push("")
    }
  }

  if (Array.isArray(tokens.donts) && tokens.donts.length > 0) {
    lines.push("## Don'ts", "")
    for (const d of tokens.donts) lines.push(`- ${d}`)
    lines.push("")
  }

  if (tokens.agent_guide_md) {
    lines.push("---", "", String(tokens.agent_guide_md))
  }

  return lines.join("\n") + "\n"
}

function printTokenSummary(tokens: Record<string, unknown>): void {
  if (tokens.colors && typeof tokens.colors === "object") {
    console.log(bold("Colors:"))
    for (const [group, shades] of Object.entries(tokens.colors as Record<string, unknown>)) {
      if (shades && typeof shades === "object") {
        const vals = Object.entries(shades as Record<string, string>).map(([k, v]) => `${k}=${v}`).join("  ")
        console.log(`  ${bold(group)}  ${dim(vals)}`)
      }
    }
    console.log()
  }
  if (tokens.typography && typeof tokens.typography === "object") {
    console.log(bold("Typography:"))
    for (const [role, cfg] of Object.entries(tokens.typography as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const c = cfg as Record<string, unknown>
        console.log(`  ${bold(role)}  ${c.family}  ${dim(`weights: ${Array.isArray(c.weights) ? c.weights.join(",") : "?"}`)}`)
      }
    }
    console.log()
  }
  if (tokens.semantic && typeof tokens.semantic === "object") {
    console.log(bold("Semantic:"))
    const entries = Object.entries(tokens.semantic as Record<string, string>)
    for (const [k, v] of entries) {
      console.log(`  ${dim(k + ":")} ${v}`)
    }
    console.log()
  }
  if (tokens.components && typeof tokens.components === "object") {
    console.log(bold("Components:"))
    for (const [comp, cfg] of Object.entries(tokens.components as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const pairs = Object.entries(cfg as Record<string, string>).map(([k, v]) => `${k}=${v}`).join("  ")
        console.log(`  ${bold(comp)}  ${dim(pairs)}`)
      }
    }
    console.log()
  }
  if (tokens.voice && typeof tokens.voice === "object") {
    const v = tokens.voice as Record<string, unknown>
    if (v.tone) console.log(`${bold("Voice:")} ${v.tone}`)
    console.log()
  }
}

const DesignTokensGetCommand = cmd({
  command: "get <slug>",
  describe: "fetch and display design tokens for a brand (public)",
  builder: (yargs) =>
    yargs.positional("slug", { describe: "brand slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Design Tokens — ${args.slug}`)

    const spinner = prompts.spinner()
    spinner.start("Fetching…")
    try {
      const res = await irisFetch(`/api/v1/public/brands/${args.slug}/design-tokens`)
      const ok = await handleApiError(res, "Get tokens"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as Record<string, unknown>
      const tokens = (data?.design_tokens ?? {}) as Record<string, unknown>
      spinner.stop(String(data?.name ?? args.slug))

      if (Object.keys(tokens).length === 0) {
        prompts.log.warn("No design tokens set")
        prompts.outro(`Set them: ${dim(`iris brands design-tokens set ${args.slug} --file tokens.json`)}`)
        return
      }

      printDivider()
      printTokenSummary(tokens)
      printDivider()
      prompts.outro(`${dim(`iris brands design-tokens export ${args.slug} --format css`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DesignTokensSetCommand = cmd({
  command: "set <slug>",
  describe: "set design tokens from a JSON file",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "brand slug", type: "string", demandOption: true })
      .option("file", { describe: "path to tokens JSON file", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set Design Tokens — ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let tokens: Record<string, unknown>
    try {
      tokens = JSON.parse(readFileSync(args.file!, "utf-8"))
    } catch (e) {
      prompts.log.error(`Failed to read ${args.file}: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Done"); return
    }

    // Resolve brand ID by slug
    const spinner = prompts.spinner()
    spinner.start("Resolving brand…")
    try {
      const listRes = await irisFetch(`/api/v1/brands?slug=${args.slug}&per_page=1`)
      const listOk = await handleApiError(listRes, "Find brand"); if (!listOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const listData = (await listRes.json()) as { data?: any }
      const brands: any[] = listData?.data?.data ?? listData?.data ?? []
      if (brands.length === 0) { spinner.stop("Not found", 1); prompts.log.error(`Brand "${args.slug}" not found`); prompts.outro("Done"); return }
      const brandId = brands[0].id

      spinner.message("Updating tokens…")
      const res = await irisFetch(`/api/v1/brands/${brandId}/design-tokens`, {
        method: "PATCH",
        body: JSON.stringify(tokens),
      })
      const ok = await handleApiError(res, "Set tokens"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Tokens updated")

      const keys = Object.keys(tokens)
      prompts.log.success(`Set ${keys.length} token group(s): ${keys.join(", ")}`)
      prompts.outro(`${dim(`iris brands design-tokens get ${args.slug}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DesignTokensExportCommand = cmd({
  command: "export <slug>",
  describe: "export design tokens as CSS, JSON, or markdown",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "brand slug", type: "string", demandOption: true })
      .option("format", { describe: "css|json|md", type: "string", default: "json" })
      .option("output", { describe: "output file path (default: stdout)", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Export Design Tokens — ${args.slug}`)

    const spinner = prompts.spinner()
    spinner.start("Fetching…")
    try {
      const res = await irisFetch(`/api/v1/public/brands/${args.slug}/design-tokens`)
      const ok = await handleApiError(res, "Get tokens"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as Record<string, unknown>
      const tokens = (data?.design_tokens ?? {}) as Record<string, unknown>
      const brandName = String(data?.name ?? args.slug)
      spinner.stop(brandName)

      if (Object.keys(tokens).length === 0) {
        prompts.log.warn("No design tokens to export")
        prompts.outro("Done"); return
      }

      let output: string
      const fmt = String(args.format).toLowerCase()
      if (fmt === "css") {
        output = tokensToCSS(tokens, String(args.slug))
      } else if (fmt === "md" || fmt === "markdown") {
        output = tokensToMarkdown(tokens, brandName)
      } else {
        output = JSON.stringify(tokens, null, 2) + "\n"
      }

      if (args.output) {
        writeFileSync(args.output, output)
        prompts.log.success(`Written to ${args.output}`)
      } else {
        process.stdout.write(output)
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DesignTokensImportCommand = cmd({
  command: "import <slug>",
  describe: "import design tokens from a CSS custom properties file",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "brand slug", type: "string", demandOption: true })
      .option("css", { describe: "path to CSS file with custom properties", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Import CSS → Design Tokens — ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let cssContent: string
    try {
      cssContent = readFileSync(args.css!, "utf-8")
    } catch (e) {
      prompts.log.error(`Failed to read ${args.css}: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Done"); return
    }

    const parsed = parseCssVars(cssContent)
    const groupCount = Object.keys(parsed).length
    const varCount = Object.values(parsed).reduce((n, g) => n + Object.keys(g).length, 0)
    prompts.log.info(`Parsed ${varCount} CSS variables across ${groupCount} groups`)

    // Build token schema from parsed CSS groups
    const colors: Record<string, Record<string, string>> = {}
    const semantic: Record<string, string> = {}
    const typography: Record<string, unknown> = {}

    for (const [group, shades] of Object.entries(parsed)) {
      // Semantic tokens (bg-*, fg-*, border-*, status-*)
      if (["bg", "fg", "border", "status"].some((p) => group === p)) {
        for (const [k, v] of Object.entries(shades)) {
          semantic[`${group}_${k.replace(/-/g, "_")}`] = v
        }
      // Typography
      } else if (group === "font") {
        for (const [k, v] of Object.entries(shades)) {
          if (k === "serif" || k === "sans" || k === "icon") {
            const family = v.replace(/^"([^"]+)".*/, "$1")
            const fallback = v.replace(/^"[^"]+"[, ]*/, "")
            if (k === "serif") typography.heading = { family, fallback, weights: [400, 700] }
            else if (k === "sans") typography.body = { family, fallback, weights: [300, 400, 700] }
          }
        }
      // Skip spacing/radius/shadow/text-size/ease/dur (layout tokens, not brand identity)
      } else if (["space", "radius", "shadow", "text", "ease", "dur"].includes(group)) {
        continue
      // Everything else is a color group
      } else {
        colors[group] = shades
      }
    }

    const tokens: Record<string, unknown> = {}
    if (Object.keys(colors).length > 0) tokens.colors = colors
    if (Object.keys(semantic).length > 0) tokens.semantic = semantic
    if (Object.keys(typography).length > 0) tokens.typography = typography

    prompts.log.info(`Built token schema: ${Object.keys(tokens).join(", ")}`)

    // Resolve brand ID
    const spinner = prompts.spinner()
    spinner.start("Resolving brand…")
    try {
      const listRes = await irisFetch(`/api/v1/brands?slug=${args.slug}&per_page=1`)
      const listOk = await handleApiError(listRes, "Find brand"); if (!listOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const listData = (await listRes.json()) as { data?: any }
      const brands: any[] = listData?.data?.data ?? listData?.data ?? []
      if (brands.length === 0) { spinner.stop("Not found", 1); prompts.log.error(`Brand "${args.slug}" not found`); prompts.outro("Done"); return }
      const brandId = brands[0].id

      spinner.message("Uploading tokens…")
      const res = await irisFetch(`/api/v1/brands/${brandId}/design-tokens`, {
        method: "PATCH",
        body: JSON.stringify(tokens),
      })
      const ok = await handleApiError(res, "Import tokens"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Tokens imported")

      printDivider()
      printTokenSummary(tokens)
      printDivider()
      prompts.outro(`${dim(`iris brands design-tokens get ${args.slug}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// --- pull / push / diff ---

const BRANDS_DIR = "brands"

function brandTokenPath(slug: string): string {
  return join(BRANDS_DIR, `${slug}-tokens.json`)
}

async function fetchPublicTokens(slug: string): Promise<{ tokens: Record<string, unknown>; name: string } | null> {
  const res = await irisFetch(`/api/v1/public/brands/${slug}/design-tokens`)
  if (!res.ok) return null
  const data = (await res.json()) as Record<string, unknown>
  return { tokens: (data.design_tokens ?? {}) as Record<string, unknown>, name: String(data.name ?? slug) }
}

const DesignTokensPullCommand = cmd({
  command: "pull <slug>",
  describe: "download brand design tokens to local ./brands/<slug>-tokens.json",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "brand slug", type: "string", demandOption: true })
      .option("output", { alias: "o", describe: "custom output path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Design Tokens — ${args.slug}`)

    const spinner = prompts.spinner()
    spinner.start("Fetching…")
    try {
      const result = await fetchPublicTokens(String(args.slug))
      if (!result || Object.keys(result.tokens).length === 0) {
        spinner.stop("Not found", 1)
        prompts.log.error(`No design tokens for "${args.slug}"`)
        prompts.outro("Done"); return
      }

      if (!existsSync(BRANDS_DIR)) mkdirSync(BRANDS_DIR, { recursive: true })
      const filepath = args.output ?? brandTokenPath(String(args.slug))
      writeFileSync(filepath, JSON.stringify(result.tokens, null, 2) + "\n")
      spinner.stop(`Pulled ${result.name}`)

      printDivider()
      printKV("Brand", result.name)
      printKV("Groups", Object.keys(result.tokens).join(", "))
      printKV("Saved to", filepath)
      printDivider()
      prompts.outro(`${dim(`iris brands dt push ${args.slug}`)}  ·  ${dim(`iris brands dt diff ${args.slug}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DesignTokensPushCommand = cmd({
  command: "push <slug>",
  describe: "upload local ./brands/<slug>-tokens.json to brand API",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "brand slug", type: "string", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file (default: brands/<slug>-tokens.json)", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Design Tokens — ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const filepath = args.file ?? brandTokenPath(String(args.slug))
    if (!existsSync(filepath)) {
      prompts.log.error(`Local file not found: ${filepath}`)
      prompts.log.info(`Run first: ${dim(`iris brands dt pull ${args.slug}`)}`)
      prompts.outro("Done"); return
    }

    let tokens: Record<string, unknown>
    try {
      tokens = JSON.parse(readFileSync(filepath, "utf-8"))
    } catch (e) {
      prompts.log.error(`Failed to parse ${filepath}: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Resolving brand…")
    try {
      const listRes = await irisFetch(`/api/v1/brands?slug=${args.slug}&per_page=1`)
      const listOk = await handleApiError(listRes, "Find brand"); if (!listOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const listData = (await listRes.json()) as { data?: any }
      const brands: any[] = listData?.data?.data ?? listData?.data ?? []
      if (brands.length === 0) { spinner.stop("Not found", 1); prompts.log.error(`Brand "${args.slug}" not found`); prompts.outro("Done"); return }

      spinner.message("Pushing tokens…")
      const res = await irisFetch(`/api/v1/brands/${brands[0].id}/design-tokens`, {
        method: "PATCH",
        body: JSON.stringify(tokens),
      })
      const ok = await handleApiError(res, "Push tokens"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Pushed")

      const keys = Object.keys(tokens)
      prompts.log.success(`Pushed ${keys.length} token group(s) from ${filepath}`)
      prompts.outro(`${dim(`iris brands dt get ${args.slug}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DesignTokensDiffCommand = cmd({
  command: "diff <slug>",
  describe: "compare local tokens file with remote API",
  builder: (yargs) =>
    yargs.positional("slug", { describe: "brand slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Design Tokens — ${args.slug}`)

    const filepath = brandTokenPath(String(args.slug))
    if (!existsSync(filepath)) {
      prompts.log.error(`Local file not found: ${filepath}`)
      prompts.log.info(`Run first: ${dim(`iris brands dt pull ${args.slug}`)}`)
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Fetching remote…")
    try {
      const result = await fetchPublicTokens(String(args.slug))
      if (!result) { spinner.stop("Not found", 1); prompts.log.error(`Brand "${args.slug}" not found`); prompts.outro("Done"); return }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))
      const remote = result.tokens
      spinner.stop(result.name)

      const localStr = JSON.stringify(local, null, 2)
      const remoteStr = JSON.stringify(remote, null, 2)

      if (localStr === remoteStr) {
        prompts.log.success("In sync — no differences")
        prompts.outro("Done"); return
      }

      // Find added, removed, changed keys at top level
      const localKeys = new Set(Object.keys(local))
      const remoteKeys = new Set(Object.keys(remote))
      const added: string[] = []
      const removed: string[] = []
      const changed: string[] = []

      for (const k of localKeys) {
        if (!remoteKeys.has(k)) added.push(k)
        else if (JSON.stringify(local[k]) !== JSON.stringify(remote[k])) changed.push(k)
      }
      for (const k of remoteKeys) {
        if (!localKeys.has(k)) removed.push(k)
      }

      printDivider()
      if (added.length > 0) console.log(`  ${bold("+ local only:")} ${added.join(", ")}`)
      if (removed.length > 0) console.log(`  ${bold("- remote only:")} ${removed.join(", ")}`)
      if (changed.length > 0) {
        console.log(`  ${bold("~ changed:")} ${changed.join(", ")}`)
        for (const k of changed) {
          const lKeys = typeof local[k] === "object" && local[k] !== null ? Object.keys(local[k]) : []
          const rKeys = typeof remote[k] === "object" && remote[k] !== null ? Object.keys(remote[k]) : []
          const lOnly = lKeys.filter(x => !rKeys.includes(x))
          const rOnly = rKeys.filter(x => !lKeys.includes(x))
          const both = lKeys.filter(x => rKeys.includes(x) && JSON.stringify((local[k] as any)[x]) !== JSON.stringify((remote[k] as any)[x]))
          if (lOnly.length > 0) console.log(`    ${dim(k + " + local:")} ${lOnly.join(", ")}`)
          if (rOnly.length > 0) console.log(`    ${dim(k + " - remote:")} ${rOnly.join(", ")}`)
          if (both.length > 0) console.log(`    ${dim(k + " ~ changed:")} ${both.join(", ")}`)
        }
      }
      printDivider()
      prompts.outro(`${dim(`iris brands dt push ${args.slug}`)}  to apply local  ·  ${dim(`iris brands dt pull ${args.slug}`)}  to overwrite local`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DesignTokensGroup = cmd({
  command: "design-tokens",
  aliases: ["tokens", "dt"],
  describe: "manage brand design tokens (colors, typography, components)",
  builder: (yargs) =>
    yargs
      .command(DesignTokensGetCommand)
      .command(DesignTokensSetCommand)
      .command(DesignTokensExportCommand)
      .command(DesignTokensImportCommand)
      .command(DesignTokensPullCommand)
      .command(DesignTokensPushCommand)
      .command(DesignTokensDiffCommand)
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
      .command(DesignTokensGroup)
      .demandCommand(),
  async handler() {},
})
