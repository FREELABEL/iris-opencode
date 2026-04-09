import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"

// ============================================================================
// Helpers
// ============================================================================

function partialsDir(custom?: string): string {
  return custom ?? join(process.cwd(), "partials")
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function getNestedValue(obj: any, path: string): unknown {
  const parts = path.split(".")
  let cur: any = obj
  for (const p of parts) {
    if (cur == null) return undefined
    const idx = /^\d+$/.test(p) ? Number(p) : p
    cur = cur[idx as any]
  }
  return cur
}

async function getPartialBySlug(slug: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/partials/${encodeURIComponent(slug)}`)
  if (!res.ok) {
    if (res.status === 404) return null
    await handleApiError(res, `Get partial ${slug}`)
    return null
  }
  const data = (await res.json()) as { data?: any }
  return data?.data ?? data
}

/**
 * Scan all pages for components that reference a given partial slug.
 * Returns a map of partialSlug -> array of pages using it.
 */
async function buildUsageMap(partialSlugs: string[]): Promise<Record<string, Array<{ slug: string; title: string }>>> {
  const map: Record<string, Array<{ slug: string; title: string }>> = {}
  for (const s of partialSlugs) map[s] = []
  try {
    // Use large per_page to capture all pages in a single request
    const res = await irisFetch("/api/v1/pages?include_json=1&per_page=500")
    if (!res.ok) return map
    const json = (await res.json()) as any
    // Handle both shapes: { data: [...] } or { data: { data: [...] } } (Laravel paginator)
    let pages: any[] = []
    if (Array.isArray(json?.data)) pages = json.data
    else if (Array.isArray(json?.data?.data)) pages = json.data.data
    else if (Array.isArray(json)) pages = json

    for (const page of pages) {
      const components = page?.json_content?.components ?? []
      for (const comp of components) {
        const ref = comp?.["$partial"]
        if (ref && map[ref] !== undefined) {
          map[ref].push({ slug: page.slug, title: page.title ?? "" })
        }
      }
    }
  } catch {
    // best-effort: return empty usage if scan fails
  }
  return map
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all shared partials",
  builder: (y) =>
    y
      .option("component-type", { describe: "filter by component type (e.g. SiteNavigation)", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false })
      .option("no-usage", { describe: "skip page usage scan (faster)", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Partials")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading partials…")
    try {
      const params = new URLSearchParams()
      if (args["component-type"]) params.set("component_type", args["component-type"] as string)
      const res = await irisFetch(`/api/v1/partials${params.toString() ? "?" + params : ""}`)
      if (!(await handleApiError(res, "List partials"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any[] }
      const partials = data?.data ?? []
      sp.stop(`${partials.length} partial(s)`)

      let usage: Record<string, Array<{ slug: string; title: string }>> = {}
      if (!args["no-usage"] && partials.length > 0) {
        const sp2 = prompts.spinner()
        sp2.start("Scanning page usage…")
        usage = await buildUsageMap(partials.map((p: any) => p.slug))
        sp2.stop(dim("Usage scanned"))
      }

      if (args.json) {
        console.log(JSON.stringify(partials.map((p: any) => ({ ...p, used_by: usage[p.slug] ?? [] })), null, 2))
        prompts.outro("Done")
        return
      }
      if (partials.length === 0) {
        prompts.log.warn("No partials found. Create one with: iris partials create --slug X --component-type Y")
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const p of partials) {
        const usedBy = usage[p.slug] ?? []
        const usedByLabel = args["no-usage"] ? "" : dim(`  used by ${usedBy.length} page${usedBy.length === 1 ? "" : "s"}`)
        console.log(`  ${bold(p.slug)}  ${dim(`[${p.component_type}]`)}${usedByLabel}`)
        if (p.label) console.log(`    ${dim(p.label)}`)
        console.log()
      }
      printDivider()
      prompts.outro(dim("iris partials view <slug>"))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ViewCmd = cmd({
  command: "view <slug>",
  describe: "show full partial details",
  builder: (y) =>
    y
      .positional("slug", { describe: "partial slug", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Partial: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const partial = await getPartialBySlug(args.slug as string)
      if (!partial) {
        sp.stop("Not found", 1)
        prompts.log.error(`Partial '${args.slug}' not found`)
        prompts.outro("Done")
        return
      }
      sp.stop(String(partial.label ?? partial.slug))

      if (args.json) {
        console.log(JSON.stringify(partial, null, 2))
        prompts.outro("Done")
        return
      }
      printDivider()
      printKV("Slug", partial.slug)
      printKV("Type", partial.component_type)
      printKV("Label", partial.label ?? "(none)")
      printKV("Owner", `${partial.owner_type ?? "system"}${partial.owner_id ? "#" + partial.owner_id : ""}`)
      printKV("Updated", partial.updated_at ?? "-")
      const propKeys = Object.keys(partial.props ?? {})
      printKV("Top-level props", propKeys.length > 0 ? propKeys.join(", ") : "(empty)")
      printDivider()
      prompts.outro(dim(`iris partials get ${args.slug} props`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCmd = cmd({
  command: "get <slug> [path]",
  describe: "read value at dot-notation path (no path = full partial)",
  builder: (y) =>
    y
      .positional("slug", { describe: "partial slug", type: "string", demandOption: true })
      .positional("path", { describe: "dot notation path", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const partial = await getPartialBySlug(args.slug as string)
    if (!partial) {
      console.error(`Partial '${args.slug}' not found`)
      process.exit(1)
    }
    if (!args.path) {
      console.log(JSON.stringify(partial, null, 2))
      return
    }
    const value = getNestedValue(partial, args.path as string)
    if (value === undefined || value === null) {
      console.error(`Path '${args.path}' not found in '${args.slug}'`)
      process.exit(1)
    }
    if (typeof value === "object") console.log(JSON.stringify(value, null, 2))
    else console.log(String(value))
  },
})

const SetCmd = cmd({
  command: "set <slug> <path> <value>",
  describe: "atomic update at dot-notation path (auto-detects JSON values)",
  builder: (y) =>
    y
      .positional("slug", { describe: "partial slug", type: "string", demandOption: true })
      .positional("path", { describe: "dot notation path under .props (e.g. 'links.0.label' or 'props.themeMode')", type: "string", demandOption: true })
      .positional("value", { describe: "new value (JSON or string)", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set ${args.slug} → ${args.path}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Updating…")
    try {
      const parsed = parseValue(args.value as string)
      // Backend update endpoint expects path RELATIVE to props, so strip leading "props."
      let path = args.path as string
      if (path.startsWith("props.")) path = path.slice(6)
      const res = await irisFetch(`/api/v1/partials/${encodeURIComponent(args.slug as string)}`, {
        method: "PUT",
        body: JSON.stringify({ path, value: parsed }),
      })
      if (!(await handleApiError(res, "Update partial"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success(`Updated ${args.path}`))
      prompts.outro(dim(`iris partials get ${args.slug} ${args.path}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCmd = cmd({
  command: "pull <slug>",
  describe: "download partial JSON to local file",
  builder: (y) =>
    y
      .positional("slug", { describe: "partial slug", type: "string", demandOption: true })
      .option("dir", { describe: "output directory", type: "string", default: "./partials" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Fetching…")
    try {
      const partial = await getPartialBySlug(args.slug as string)
      if (!partial) {
        sp.stop("Not found", 1)
        prompts.log.error(`Partial '${args.slug}' not found`)
        prompts.outro("Done")
        return
      }
      const dir = partialsDir(args.dir as string)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${args.slug}.json`)
      const exp = {
        slug: partial.slug,
        component_type: partial.component_type,
        label: partial.label ?? null,
        props: partial.props ?? {},
      }
      writeFileSync(filePath, JSON.stringify(exp, null, 2) + "\n")
      sp.stop(success(`Pulled → ${filePath}`))
      prompts.outro(dim(`iris partials push ${args.slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCmd = cmd({
  command: "push <slug>",
  describe: "upload local partial JSON (creates if missing, updates if exists)",
  builder: (y) =>
    y
      .positional("slug", { describe: "partial slug", type: "string", demandOption: true })
      .option("dir", { describe: "input directory", type: "string", default: "./partials" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    try {
      const filePath = join(partialsDir(args.dir as string), `${args.slug}.json`)
      if (!existsSync(filePath)) {
        prompts.log.error(`Local file not found: ${filePath}`)
        prompts.log.info(dim(`Pull first: iris partials pull ${args.slug}`))
        prompts.outro("Done")
        return
      }
      sp.start("Pushing…")
      const local = JSON.parse(readFileSync(filePath, "utf-8"))
      if (!local.component_type || !local.props) {
        sp.stop("Failed", 1)
        prompts.log.error("File must contain 'component_type' and 'props' fields")
        prompts.outro("Done")
        return
      }

      const existing = await getPartialBySlug(args.slug as string)
      if (existing) {
        // Update existing — full replacement of props/label/component_type
        const res = await irisFetch(`/api/v1/partials/${encodeURIComponent(args.slug as string)}`, {
          method: "PUT",
          body: JSON.stringify({
            label: local.label ?? null,
            component_type: local.component_type,
            props: local.props,
          }),
        })
        if (!(await handleApiError(res, "Update partial"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
        sp.stop(success(`Updated ${args.slug}`))
      } else {
        // Create new
        const res = await irisFetch(`/api/v1/partials`, {
          method: "POST",
          body: JSON.stringify({
            slug: args.slug,
            component_type: local.component_type,
            label: local.label ?? null,
            props: local.props,
            owner_type: local.owner_type ?? "system",
            owner_id: local.owner_id ?? null,
          }),
        })
        if (!(await handleApiError(res, "Create partial"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
        sp.stop(success(`Created ${args.slug}`))
      }
      prompts.outro(dim(`iris partials view ${args.slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCmd = cmd({
  command: "create",
  describe: "create a new empty partial",
  builder: (y) =>
    y
      .option("slug", { describe: "unique slug", type: "string", demandOption: true })
      .option("component-type", { describe: "component type (e.g. SiteNavigation)", type: "string", demandOption: true })
      .option("label", { describe: "human-readable label", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create partial: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Creating…")
    try {
      const res = await irisFetch("/api/v1/partials", {
        method: "POST",
        body: JSON.stringify({
          slug: args.slug,
          component_type: args["component-type"],
          label: args.label ?? null,
          props: {},
          owner_type: "system",
        }),
      })
      if (!(await handleApiError(res, "Create partial"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success(`Created ${args.slug}`))
      prompts.outro(dim(`iris partials set ${args.slug} <path> <value>`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCmd = cmd({
  command: "delete <slug>",
  aliases: ["rm"],
  describe: "soft-delete a partial",
  builder: (y) => y.positional("slug", { describe: "partial slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Deleting…")
    try {
      const res = await irisFetch(`/api/v1/partials/${encodeURIComponent(args.slug as string)}`, { method: "DELETE" })
      if (!(await handleApiError(res, "Delete partial"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success(`Deleted ${args.slug}`))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UsageCmd = cmd({
  command: "usage <slug>",
  describe: "list pages that reference this partial",
  builder: (y) =>
    y
      .positional("slug", { describe: "partial slug", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Usage: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Scanning pages…")
    try {
      const usage = await buildUsageMap([args.slug as string])
      const pages = usage[args.slug as string] ?? []
      sp.stop(`${pages.length} page(s) reference this partial`)

      if (args.json) {
        console.log(JSON.stringify(pages, null, 2))
        prompts.outro("Done")
        return
      }
      if (pages.length === 0) {
        prompts.log.warn("No pages reference this partial yet")
        prompts.outro(dim(`Add { type: '...', $partial: '${args.slug}', props: {} } to a page's components`))
        return
      }
      printDivider()
      for (const p of pages) {
        console.log(`  ${bold(p.slug)}  ${dim(p.title)}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformPartialsCommand = cmd({
  command: "partials",
  describe: "manage shared component partials referenced by pages via $partial",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(ViewCmd)
      .command(GetCmd)
      .command(SetCmd)
      .command(PullCmd)
      .command(PushCmd)
      .command(CreateCmd)
      .command(DeleteCmd)
      .command(UsageCmd)
      .demandCommand(),
  async handler() {},
})
