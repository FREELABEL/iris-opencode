import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, handleApiError, printKV, dim, bold, success } from "./iris-api"

const MagListCommand = cmd({
  command: "list",
  describe: "list magazine issues",
  builder: (yargs) =>
    yargs
      .option("published", { type: "boolean", description: "only published" })
      .option("course-id", { type: "number", description: "filter by course" }),
  async handler(argv) {
    const params = new URLSearchParams()
    if (argv.published) params.set("is_published", "1")
    if (argv["course-id"]) params.set("course_id", String(argv["course-id"]))
    const qs = params.toString() ? `?${params.toString()}` : ""
    const res = await irisFetch(`/api/v1/magazine-issues${qs}`)
    if (!res.ok) { await handleApiError(res, "list issues"); return }
    const body = await res.json() as Record<string, unknown>
    const issues = (body as any).data ?? []
    if (!issues.length) { prompts.outro("No magazine issues found"); return }
    for (const i of issues) {
      const pub = i.is_published ? success("published") : dim("draft")
      console.log(`  ${bold(i.title)}  ${dim(`#${i.id}`)}  ${pub}  pages: ${i.page_count ?? 0}`)
      if (i.slug) console.log(`    ${dim(`slug: ${i.slug}`)}`)
    }
    prompts.outro(`${issues.length} issue(s)`)
  },
})

const MagGetCommand = cmd({
  command: "get <slug>",
  describe: "get magazine issue detail",
  builder: (yargs) => yargs.positional("slug", { type: "string", demandOption: true }),
  async handler(argv) {
    const res = await irisFetch(`/api/v1/magazine-issues/${argv.slug}`)
    if (!res.ok) { await handleApiError(res, "get issue"); return }
    const body = await res.json() as Record<string, unknown>
    const issue = (body as any).data
    console.log()
    printKV("Title", issue.title)
    printKV("Slug", issue.slug)
    printKV("Issue #", issue.issue_number)
    printKV("Published", issue.is_published ? "Yes" : "No")
    printKV("Pages", issue.page_count)
    printKV("Price", issue.price_usd ? `$${issue.price_usd}` : "Free")
    if (issue.description) printKV("Description", issue.description)
    if (issue.pages?.length) {
      console.log(`\n  ${bold("Pages:")}`)
      for (const p of issue.pages) {
        console.log(`    ${p.page_number}. ${p.title ?? dim("untitled")}  [${p.content_type}]`)
      }
    }
    prompts.outro("Done")
  },
})

const MagCreateCommand = cmd({
  command: "create",
  describe: "create a new magazine issue",
  builder: (yargs) =>
    yargs
      .option("title", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("course-id", { type: "number" })
      .option("chapter-id", { type: "number" }),
  async handler(argv) {
    await requireAuth()
    const data: Record<string, unknown> = { title: argv.title }
    if (argv.description) data.description = argv.description
    if (argv["course-id"]) data.course_id = argv["course-id"]
    if (argv["chapter-id"]) data.chapter_id = argv["chapter-id"]

    const res = await irisFetch("/api/v1/magazine-issues", {
      method: "POST",
      body: JSON.stringify(data),
    })
    if (!res.ok) { await handleApiError(res, "create issue"); return }
    const body = await res.json() as Record<string, unknown>
    const issue = (body as any).data
    console.log(`\n  ${success("Created!")} ${bold(issue.title)}  ${dim(`#${issue.id}`)}  slug: ${issue.slug}`)
    prompts.outro("Done")
  },
})

const MagImportCommand = cmd({
  command: "import <issue-id>",
  describe: "import slides from a carousel directory",
  builder: (yargs) =>
    yargs
      .positional("issue-id", { type: "number", demandOption: true })
      .option("dir", { type: "string", demandOption: true, description: "carousel directory path" }),
  async handler(argv) {
    await requireAuth()
    const res = await irisFetch(`/api/v1/magazine-issues/${argv["issue-id"]}/import-carousel`, {
      method: "POST",
      body: JSON.stringify({ directory: argv.dir }),
    })
    if (!res.ok) { await handleApiError(res, "import carousel"); return }
    const body = await res.json() as Record<string, unknown>
    const issue = (body as any).data
    console.log(`\n  ${success("Imported!")} ${issue.page_count} pages from carousel`)
    prompts.outro("Done")
  },
})

const MagPublishCommand = cmd({
  command: "publish <issue-id>",
  describe: "publish a magazine issue",
  builder: (yargs) => yargs.positional("issue-id", { type: "number", demandOption: true }),
  async handler(argv) {
    await requireAuth()
    const res = await irisFetch(`/api/v1/magazine-issues/${argv["issue-id"]}/publish`, { method: "POST" })
    if (!res.ok) { await handleApiError(res, "publish issue"); return }
    console.log(`\n  ${success("Published!")}`)
    prompts.outro("Done")
  },
})

const MagDeliveryCommand = cmd({
  command: "delivery <issue-id>",
  describe: "get delivery options (PDF, zip, pages) for an issue",
  builder: (yargs) => yargs.positional("issue-id", { type: "number", demandOption: true }),
  async handler(argv) {
    const res = await irisFetch(`/api/v1/magazine-issues/${argv["issue-id"]}/delivery`)
    if (!res.ok) { await handleApiError(res, "get delivery"); return }
    const body = await res.json() as Record<string, unknown>
    const opts = (body as any).data
    console.log()
    if (opts.pdf) printKV("PDF", opts.pdf)
    if (opts.images_zip) printKV("Images ZIP", opts.images_zip)
    if (opts.pages?.length) {
      printKV("Pages", `${opts.pages.length} images`)
    }
    prompts.outro("Done")
  },
})

export const PlatformMagazineCommand = cmd({
  command: "magazine",
  describe: "manage magazine issues",
  builder: (yargs) =>
    yargs
      .command(MagListCommand)
      .command(MagGetCommand)
      .command(MagCreateCommand)
      .command(MagImportCommand)
      .command(MagPublishCommand)
      .command(MagDeliveryCommand)
      .demandCommand(1, "specify a magazine subcommand"),
  handler() {},
})
