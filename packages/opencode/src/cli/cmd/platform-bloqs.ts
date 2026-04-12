import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, FL_API, promptOrFail, MissingFlagError, isNonInteractive } from "./iris-api"
import path from "path"

// ============================================================================
// Display helpers
// ============================================================================

function printBloq(b: Record<string, unknown>): void {
  const name = bold(String(b.name ?? `Bloq #${b.id}`))
  const id = dim(`#${b.id}`)
  const items = typeof b.items_count === "number" ? `  ${dim(String(b.items_count) + " items")}` : ""
  console.log(`  ${name}  ${id}${items}`)
  if (b.description) {
    console.log(`    ${dim(String(b.description).slice(0, 100))}`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const BloqsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your knowledge bases",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Bloqs")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading bloqs…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs?${params}`)
      const ok = await handleApiError(res, "List bloqs")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const bloqs: any[] = data?.data ?? []
      spinner.stop(`${bloqs.length} bloq(s)`)

      if (bloqs.length === 0) {
        prompts.log.warn("No bloqs found")
        prompts.outro(`Create one: ${dim("iris bloqs create")}`)
        return
      }

      printDivider()
      for (const b of bloqs) {
        printBloq(b)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${dim("iris bloqs get <id>")}  ·  ${dim("iris bloqs ingest <id> <file>")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsGetCommand = cmd({
  command: "get <id>",
  describe: "show bloq details and lists",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("files", { describe: "list files attached to this bloq", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Bloq #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/${args.id}`)
      const ok = await handleApiError(res, "Get bloq")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const b = data?.data ?? data
      spinner.stop(String(b.name ?? `Bloq #${b.id}`))

      printDivider()
      printKV("ID", b.id)
      printKV("Name", b.name)
      printKV("Description", b.description)
      printKV("Items", b.items_count)
      printKV("Created", b.created_at)
      console.log()

      // Load lists
      const listsRes = await irisFetch(`/api/v1/users/${userId}/bloqs/${args.id}/lists`)
      if (listsRes.ok) {
        const listsData = (await listsRes.json()) as { data?: any[] }
        const lists: any[] = listsData?.data ?? []
        if (lists.length > 0) {
          console.log(`  ${dim("Lists:")}`)
          for (const l of lists) {
            console.log(`    ${dim("—")} ${bold(String(l.name ?? l.id))} ${dim(`(${l.items_count ?? 0} items)`)}`)
          }
          console.log()
        }
      }

      // Load files if requested
      if (args.files) {
        const filesRes = await irisFetch(`/api/v1/users/${userId}/bloqs/${args.id}/files`)
        if (filesRes.ok) {
          const filesData = (await filesRes.json()) as { data?: any[] }
          const files: any[] = filesData?.data ?? []
          if (files.length > 0) {
            console.log(`  ${dim("Files:")}`)
            for (const f of files) {
              const name = f.original_name ?? f.name ?? f.filename ?? `File #${f.id}`
              const size = f.size ? dim(`(${formatBytes(f.size)})`) : ""
              console.log(`    ${dim("—")} ${name} ${size}`)
            }
            console.log()
          } else {
            console.log(`  ${dim("Files: none")}`)
            console.log()
          }
        }
      }

      printDivider()

      prompts.outro(
        `${dim("iris bloqs ingest " + args.id + " ./document.pdf")}  Add knowledge`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsCreateCommand = cmd({
  command: "create",
  describe: "create a new knowledge base",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "bloq name", type: "string" })
      .option("description", { describe: "bloq description", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Bloq")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "Bloq name",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    // --description is optional. In a TTY we still prompt for it; in
    // non-interactive mode we silently default to empty string instead of
    // hanging.
    let description = args.description
    if (description === undefined) {
      if (isNonInteractive()) {
        description = ""
      } else {
        description = (await prompts.text({
          message: "Description (optional)",
          placeholder: "e.g. Company knowledge base for Q1 2026",
        })) as string
        if (prompts.isCancel(description)) description = ""
      }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating bloq…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      })
      const ok = await handleApiError(res, "Create bloq")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const b = data?.data ?? data
      spinner.stop(`${success("✓")} Bloq created: ${bold(String(b.name ?? b.id))}`)

      printDivider()
      printKV("ID", b.id)
      printKV("Name", b.name)
      printDivider()

      prompts.outro(
        `${dim("iris bloqs ingest " + b.id + " ./document.pdf")}  Add knowledge`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsIngestCommand = cmd({
  command: "ingest <id> <file>",
  describe: "upload a file into a bloq",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("file", { describe: "path to file", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Ingest into Bloq #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Read file
    const filename = path.basename(args.file)

    const spinner = prompts.spinner()
    spinner.start(`Uploading ${dim(filename)}…`)

    try {
      const file = Bun.file(args.file)
      if (!(await file.exists())) {
        spinner.stop("File not found", 1)
        prompts.log.error(`Cannot read: ${args.file}`)
        prompts.outro("Done")
        return
      }

      const blob = await file.arrayBuffer()
      const formData = new FormData()
      formData.append("file", new Blob([blob]), filename)

      const res = await fetch(`${FL_API}/api/v1/users/${userId}/bloqs/${args.id}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        body: formData,
      })

      const ok = await handleApiError(res, "Ingest file")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any; message?: string }
      spinner.stop(`${success("✓")} ${filename} ingested`)

      if (data?.data?.id) {
        prompts.log.info(`File ID: ${dim(String(data.data.id))}`)
      }

      prompts.outro(dim(`iris bloqs get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsAddItemCommand = cmd({
  command: "add-item <bloq-id> <list-id> [content]",
  describe: "add a text item to a bloq list",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("list-id", { describe: "list ID", type: "number", demandOption: true })
      .positional("content", { describe: "item content", type: "string" })
      .option("title", { describe: "item title", type: "string" })
      .option("text", { describe: "item content (alternative to positional)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Item — Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    let content = args.content ?? args.text
    if (!content) {
      try {
        content = (await promptOrFail("content", () =>
          prompts.text({
            message: "Content to add",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(content)) { prompts.outro("Cancelled"); return }
    }

    let title = args.title
    if (title === undefined) {
      if (isNonInteractive()) {
        title = ""
      } else {
        title = (await prompts.text({
          message: "Title (optional)",
          placeholder: "e.g. Meeting notes 2026-04-01",
        })) as string
        if (prompts.isCancel(title)) title = ""
      }
    }

    const spinner = prompts.spinner()
    spinner.start("Adding item…")

    try {
      const payload: Record<string, unknown> = { content }
      if (title) payload.title = title

      const res = await irisFetch(
        `/api/v1/users/${userId}/bloqs/${args["bloq-id"]}/lists/${args["list-id"]}/items`,
        { method: "POST", body: JSON.stringify(payload) },
      )
      const ok = await handleApiError(res, "Add item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Item added`)
      prompts.outro(dim(`iris bloqs get ${args["bloq-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsComposeCommand = cmd({
  command: "compose",
  describe: "create a knowledge base with AI-assisted structure",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "bloq name", type: "string" })
      .option("description", { describe: "bloq description / topic", type: "string" })
      .option("lists", { describe: "number of lists to create", type: "number", default: 3 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Compose Knowledge Base")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Step 1: Get name
    let name = args.name
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "What is this knowledge base about?",
            placeholder: "e.g. Q1 2026 Marketing Strategy",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    // Step 2: Get description / topic for AI (optional — defaults to name in non-TTY)
    let description = args.description
    if (description === undefined) {
      if (isNonInteractive()) {
        description = name
      } else {
        description = (await prompts.text({
          message: "Describe what kind of content it will hold",
          placeholder: "e.g. Campaign plans, performance metrics, competitor research",
        })) as string
        if (prompts.isCancel(description)) description = name
      }
    }

    // Step 3: Confirm list structure
    const numLists = args.lists
    const suggestedLists = generateListSuggestions(name, description ?? "", numLists)

    prompts.log.info(`${bold("Suggested structure:")}`)
    for (let i = 0; i < suggestedLists.length; i++) {
      prompts.log.info(`  ${dim(`${i + 1}.`)} ${suggestedLists[i]}`)
    }

    let confirmed: boolean | symbol
    if (isNonInteractive()) {
      // Auto-confirm in non-interactive mode (compose is invoked deliberately)
      confirmed = true
    } else {
      confirmed = await prompts.confirm({
        message: "Create with this structure?",
      })
    }
    if (prompts.isCancel(confirmed) || !confirmed) {
      prompts.outro("Cancelled")
      return
    }

    // Step 4: Create bloq
    const spinner = prompts.spinner()
    spinner.start("Creating knowledge base…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      })
      const ok = await handleApiError(res, "Create bloq")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const bloq = data?.data ?? data
      const bloqId = bloq.id

      // Step 5: Create lists
      let listsCreated = 0
      for (const listName of suggestedLists) {
        const listRes = await irisFetch(`/api/v1/users/${userId}/bloqs/${bloqId}/lists`, {
          method: "POST",
          body: JSON.stringify({ name: listName }),
        })
        if (listRes.ok) listsCreated++
      }

      spinner.stop(`${success("✓")} Created: ${bold(name)} with ${listsCreated} list(s)`)

      printDivider()
      printKV("ID", bloqId)
      printKV("Name", name)
      printKV("Lists", listsCreated)
      printDivider()

      prompts.outro(
        `${dim(`iris bloqs get ${bloqId}`)}  ·  ${dim(`iris bloqs ingest ${bloqId} ./file.pdf`)}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Helpers
// ============================================================================

function generateListSuggestions(name: string, description: string, count: number): string[] {
  const topic = (description || name).toLowerCase()

  // Common patterns based on topic keywords
  if (topic.includes("marketing") || topic.includes("campaign")) {
    return ["Strategy & Plans", "Content & Assets", "Performance Metrics"].slice(0, count)
  }
  if (topic.includes("product") || topic.includes("roadmap")) {
    return ["Features & Requirements", "Research & Insights", "Decisions & Notes"].slice(0, count)
  }
  if (topic.includes("client") || topic.includes("customer")) {
    return ["Client Profiles", "Communications", "Deliverables"].slice(0, count)
  }
  if (topic.includes("research") || topic.includes("analysis")) {
    return ["Sources & Data", "Key Findings", "Recommendations"].slice(0, count)
  }
  if (topic.includes("project")) {
    return ["Tasks & Milestones", "Documentation", "Meeting Notes"].slice(0, count)
  }

  // Generic fallback
  return ["Reference Material", "Notes & Insights", "Action Items"].slice(0, count)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// Root command
// ============================================================================

export const PlatformBloqsCommand = cmd({
  command: "bloqs",
  aliases: ["kb", "knowledge", "memory", "projects"],
  describe: "manage knowledge bases (bloqs)",
  builder: (yargs) =>
    yargs
      .command(BloqsListCommand)
      .command(BloqsGetCommand)
      .command(BloqsCreateCommand)
      .command(BloqsIngestCommand)
      .command(BloqsAddItemCommand)
      .command(BloqsComposeCommand)
      .demandCommand(),
  async handler() {},
})
