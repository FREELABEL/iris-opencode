import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, dim, bold, success, IRIS_API } from "./iris-api"

// Google Docs integration — fetch doc content via iris-api's execute-direct endpoint

function extractDocId(urlOrId: string): string | null {
  // Full URL: https://docs.google.com/document/d/DOC_ID/edit...
  const match = urlOrId.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
  if (match) return match[1]
  // Raw doc ID
  if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId)) return urlOrId
  return null
}

async function fetchDocContent(userId: number, docId: string): Promise<{ title: string; content: string } | null> {
  // Use google-drive's read_and_summarize_file or google-docs export via execute-direct
  const res = await irisFetch(
    `/api/v1/users/${userId}/integrations/execute-direct?user_id=${userId}`,
    {
      method: "POST",
      body: JSON.stringify({
        integration: "google-drive",
        action: "read_and_summarize_file",
        params: { file_id: docId },
      }),
    },
    IRIS_API,
  )

  if (!res.ok) {
    // Fallback: try google-docs integration
    const res2 = await irisFetch(
      `/api/v1/users/${userId}/integrations/execute-direct?user_id=${userId}`,
      {
        method: "POST",
        body: JSON.stringify({
          integration: "google-docs",
          action: "get_document",
          params: { document_id: docId },
        }),
      },
      IRIS_API,
    )
    if (!res2.ok) return null
    const data = (await res2.json()) as any
    return {
      title: data?.title || data?.data?.title || "Untitled",
      content: data?.content || data?.data?.content || data?.data?.body || JSON.stringify(data?.data),
    }
  }

  const data = (await res.json()) as any
  return {
    title: data?.title || data?.data?.title || data?.data?.name || "Untitled",
    content: data?.content || data?.data?.content || data?.data?.summary || JSON.stringify(data?.data),
  }
}

const DocsFetchCommand = cmd({
  command: "fetch <url>",
  aliases: ["get", "pull"],
  describe: "fetch a Google Doc by URL or ID",
  builder: (yargs) =>
    yargs
      .positional("url", { type: "string", demandOption: true, describe: "Google Docs URL or document ID" })
      .option("lead", { type: "number", describe: "log content to a lead (by ID)" })
      .option("bloq", { type: "number", describe: "add content to a bloq knowledge base (by ID)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    const docId = extractDocId(args.url)
    if (!docId) {
      prompts.log.error("Invalid Google Doc URL or ID. Expected: https://docs.google.com/document/d/DOC_ID/edit")
      return
    }

    UI.empty()
    const spinner = prompts.spinner()
    spinner.start(`Fetching document ${docId.slice(0, 12)}...`)

    const doc = await fetchDocContent(userId, docId)
    if (!doc) {
      spinner.stop("Failed to fetch document", 1)
      prompts.log.error("Could not fetch document. Ensure Google Drive integration is connected: iris run --connect google-drive")
      return
    }

    spinner.stop(success(`✓ Fetched: ${doc.title}`))

    // Log to lead if requested
    if (args.lead) {
      const noteRes = await irisFetch(`/api/v1/leads/${args.lead}/notes`, {
        method: "POST",
        body: JSON.stringify({
          content: `## ${doc.title}\n\n${doc.content}`,
          type: "meeting_notes",
        }),
      })
      if (noteRes.ok) {
        prompts.log.success(`Logged to lead #${args.lead}`)
      } else {
        prompts.log.error(`Failed to log to lead #${args.lead}`)
      }
    }

    // Add to bloq if requested
    if (args.bloq) {
      const itemRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.bloq}/items`, {
        method: "POST",
        body: JSON.stringify({
          title: doc.title,
          content: doc.content,
          type: "document",
          status: "active",
        }),
      })
      if (itemRes.ok) {
        prompts.log.success(`Added to bloq #${args.bloq}`)
      } else {
        prompts.log.error(`Failed to add to bloq #${args.bloq}`)
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ title: doc.title, content: doc.content, doc_id: docId }, null, 2))
      return
    }

    // Print content
    if (!args.lead && !args.bloq) {
      console.log("")
      console.log(bold(doc.title))
      printDivider()
      console.log(doc.content)
      console.log("")
      console.log(dim("Pipe to a lead:  iris docs fetch <url> --lead=418"))
      console.log(dim("Add to bloq:     iris docs fetch <url> --bloq=174"))
    }
  },
})

export const PlatformDocsCommand = cmd({
  command: "docs",
  aliases: ["doc", "google-docs"],
  describe: "fetch and ingest Google Docs",
  builder: (yargs) => yargs.command(DocsFetchCommand).demandCommand(),
  async handler() {},
})
