import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, success } from "./iris-api"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join, basename, isAbsolute } from "path"

function publicUrl(slug: string): string {
  const env = process.env.IRIS_ENV ?? "production"
  return env === "local"
    ? `http://local.iris.freelabel.net:9300/p/${slug}`
    : `https://heyiris.io/p/${slug}`
}

async function getBySlug(slug: string): Promise<any | null> {
  const params = new URLSearchParams({ include_json: "0", include_drafts: "1" })
  const res = await irisFetch(`/api/v1/pages/by-slug/${encodeURIComponent(slug)}?${params}`)
  if (!res.ok) return null
  const data = (await res.json()) as { data?: any }
  return data?.data ?? data
}

interface BatchResult {
  slug: string
  title?: string | null
  action: "created" | "updated" | "failed"
  id?: number | null
  published?: boolean
  url?: string
  error?: string
}

export const PlatformPagesBatchCommand = cmd({
  command: "pages:batch <directory>",
  aliases: ["genesis:batch"],
  describe: "create or update multiple pages from a directory of JSON files",
  builder: (y) =>
    y
      .positional("directory", { describe: "directory containing *.json files", type: "string", demandOption: true })
      .option("publish", { describe: "auto-publish after create/update", type: "boolean", default: false })
      .option("owner-id", { describe: "default owner bloq ID", type: "number", default: 38 })
      .option("owner-type", { describe: "default owner type", type: "string", default: "bloq" })
      .option("dry-run", { describe: "show what would happen, don't execute", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!args.json) prompts.intro("◈  Pages Batch Import")

    let dir = args.directory
    if (!isAbsolute(dir)) dir = join(process.cwd(), dir)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      prompts.log.error(`Directory not found: ${dir}`)
      prompts.outro("Done")
      return
    }

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(dir, f))

    if (files.length === 0) {
      prompts.log.error(`No *.json files found in ${dir}`)
      prompts.outro("Done")
      return
    }

    if (!args.json) {
      prompts.log.info(`Directory: ${dir}`)
      prompts.log.info(`Files: ${files.length}  ·  Publish: ${args.publish ? "yes" : "no"}  ·  Owner: ${args["owner-id"]}`)
    }

    if (args["dry-run"]) {
      const rows: any[] = []
      for (const fp of files) {
        const filename = basename(fp, ".json")
        try {
          const data = JSON.parse(readFileSync(fp, "utf-8"))
          const wrapped = data.slug != null || data.json_content != null
          const slug = wrapped ? data.slug ?? filename : filename
          const title = wrapped ? data.title ?? slug : slug
          const jc = wrapped ? data.json_content : data
          const cnt = jc?.components?.length ?? 0
          rows.push({ file: basename(fp), slug, title, components: cnt, format: wrapped ? "wrapped" : "raw" })
        } catch (e) {
          rows.push({ file: basename(fp), slug: filename, status: "invalid JSON" })
        }
      }
      if (args.json) {
        console.log(JSON.stringify({ dry_run: true, pages: rows }, null, 2))
      } else {
        printDivider()
        for (const r of rows) {
          if (r.status) console.log(`  ${UI.Style.TEXT_DANGER}${r.file}${UI.Style.TEXT_NORMAL} ${r.status}`)
          else console.log(`  ${r.slug}  ${dim(`${r.components} comps · ${r.format}`)}`)
        }
        printDivider()
        prompts.outro("Run without --dry-run to execute")
      }
      return
    }

    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const results: BatchResult[] = []
    for (const fp of files) {
      const filename = basename(fp, ".json")
      try {
        const raw = readFileSync(fp, "utf-8")
        const data = JSON.parse(raw)
        const wrapped = data.slug != null || data.json_content != null
        const slug = wrapped ? (data.slug ?? filename) : filename
        const title = wrapped ? (data.title ?? slug.replace(/-/g, " ")) : slug.replace(/-/g, " ")
        const seoTitle = wrapped ? (data.seo_title ?? title) : title
        const seoDesc = wrapped ? data.seo_description : null
        const ownerType = wrapped ? (data.owner_type ?? args["owner-type"]) : args["owner-type"]
        const ownerId = wrapped ? (data.owner_id ?? args["owner-id"]) : args["owner-id"]
        const ogImage = wrapped ? data.og_image : null
        const jsonContent = wrapped ? data.json_content : data

        if (!args.json) prompts.log.info(`Processing ${slug}…`)

        const existing = await getBySlug(slug)
        let pageId: number | null = null
        let action: "created" | "updated" = "created"

        if (existing && existing.id) {
          const updateData: Record<string, unknown> = { title, seo_title: seoTitle }
          if (seoDesc) updateData.seo_description = seoDesc
          if (ogImage) updateData.og_image = ogImage
          if (jsonContent) updateData.json_content = jsonContent
          const res = await irisFetch(`/api/v1/pages/${existing.id}`, {
            method: "PUT",
            body: JSON.stringify(updateData),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          pageId = existing.id
          action = "updated"
        } else {
          const createData: Record<string, unknown> = {
            slug,
            title,
            seo_title: seoTitle,
            owner_type: ownerType,
            owner_id: ownerId,
            status: "draft",
          }
          if (seoDesc) createData.seo_description = seoDesc
          if (ogImage) createData.og_image = ogImage
          if (jsonContent) createData.json_content = jsonContent
          const res = await irisFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(createData) })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = (await res.json()) as { data?: any; id?: any }
          pageId = body?.data?.id ?? body?.id ?? null
          action = "created"
        }

        let published = false
        if (args.publish && pageId) {
          try {
            const pres = await irisFetch(`/api/v1/pages/${pageId}/publish`, { method: "POST" })
            published = pres.ok
          } catch {}
        }

        results.push({ slug, title, action, id: pageId, published, url: publicUrl(slug) })
        if (!args.json) {
          const label = action === "created" ? success("created") : `${UI.Style.TEXT_WARNING}updated${UI.Style.TEXT_NORMAL}`
          const pub = published ? ` + ${success("published")}` : ""
          prompts.log.success(`  → ${label}${pub} #${pageId}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        results.push({ slug: filename, action: "failed", error: msg })
        if (!args.json) prompts.log.error(`  Failed ${filename}: ${msg}`)
      }
    }

    const created = results.filter((r) => r.action === "created").length
    const updated = results.filter((r) => r.action === "updated").length
    const failed = results.filter((r) => r.action === "failed").length
    const published = results.filter((r) => r.published).length

    if (args.json) {
      console.log(JSON.stringify({
        summary: { total: results.length, created, updated, failed, published },
        pages: results,
      }, null, 2))
    } else {
      printDivider()
      prompts.outro(`${created} created, ${updated} updated, ${failed} failed${published ? `, ${published} published` : ""}`)
    }
    if (failed > 0) process.exitCode = 1
  },
})
