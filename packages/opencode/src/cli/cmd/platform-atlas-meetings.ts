import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"
import { executeIntegrationCall } from "./platform-run"

const COMPOSIO_KEY = "ak_c2m5Q0Av7lOHYK9NPTCn"

const EXTRACTION_PROMPT = `Analyze this meeting transcript and extract structured intelligence. Return your analysis in the following format with clear section headers:

## KEY PEOPLE
For each person mentioned, list:
- Name | Title/Role | Organization | Relevance

## DECISIONS MADE
Bullet list of concrete decisions reached during the meeting.

## ACTION ITEMS
For each action item:
- [ ] Task description | Owner: [name] | Deadline: [date or "TBD"]

## COMPANY/ORG REFERENCES
List all companies, organizations, and brands mentioned with context.

## STRATEGIC INSIGHTS
Key takeaways, risks, opportunities, and relationship dynamics noted.

## SUMMARY
2-3 sentence executive summary of the meeting.

Be specific and factual. Only include information explicitly stated or clearly implied in the transcript.

--- MEETING NOTES ---

`

const GMAIL_QUERIES = [
  'subject:"Notes: Meeting"',
  "from:meet-notes-noreply@google.com",
  'subject:"Notes by Gemini"',
]

// ============================================================================
// AI extraction via /api/chat/start + poll
// ============================================================================

async function runAgent(prompt: string, agentId: string, timeoutSecs = 300): Promise<string | null> {
  const startRes = await irisFetch("/api/chat/start", {
    method: "POST",
    body: JSON.stringify({
      query: prompt,
      agentId,
      conversationHistory: [{ role: "user", content: prompt }],
      enableRAG: false,
      contextPayload: { source: "iris-cli-atlas" },
    }),
  })
  if (!startRes.ok) throw new Error(`chat/start HTTP ${startRes.status}`)
  const { workflow_id } = (await startRes.json()) as { workflow_id?: string }
  if (!workflow_id) throw new Error("no workflow_id returned")

  const start = Date.now()
  while ((Date.now() - start) / 1000 < timeoutSecs) {
    await Bun.sleep(800)
    const res = await irisFetch(`/api/workflows/${workflow_id}`)
    if (!res.ok) continue
    const run = (await res.json()) as any
    if (run.status === "completed") return run.summary ?? run.response ?? run.output ?? null
    if (run.status === "failed") throw new Error(run.error ?? run.summary ?? "AI failed")
  }
  throw new Error("AI extraction timed out")
}

// ============================================================================
// Composio Google Docs fetch
// ============================================================================

async function findComposioAccount(appName: string): Promise<string | null> {
  try {
    const userId = (await requireUserId()) ?? 193
    const res = await fetch(
      `https://backend.composio.dev/api/v1/connectedAccounts?entityId=user-${userId}`,
      { headers: { "x-api-key": COMPOSIO_KEY } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as any
    for (const item of data.items ?? []) {
      if (item.appName === appName && item.status === "ACTIVE") return item.id
    }
  } catch {}
  return null
}

function extractTextFromDocContent(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  let text = ""
  for (const el of content) {
    const elements = el?.paragraph?.elements ?? []
    for (const e of elements) {
      if (e?.textRun?.content) text += e.textRun.content
    }
  }
  return text.trim() || JSON.stringify(content)
}

async function fetchGoogleDoc(docId: string): Promise<string | null> {
  // Try Composio direct
  try {
    const accountId = await findComposioAccount("googledocs")
    if (accountId) {
      const res = await fetch(
        "https://backend.composio.dev/api/v2/actions/GOOGLEDOCS_GET_DOCUMENT_BY_ID/execute",
        {
          method: "POST",
          headers: { "x-api-key": COMPOSIO_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ connectedAccountId: accountId, input: { id: docId } }),
        },
      )
      if (res.ok) {
        const result = (await res.json()) as any
        if (result.successful || result.successfull) {
          const data = result.data?.response_data ?? result.data ?? {}
          const content = data.body?.content ?? data.content
          if (content) return extractTextFromDocContent(content)
        }
      }
    }
  } catch {}

  // Fallback via fl-api integration
  try {
    const result = await executeIntegrationCall("google-docs", "get_document", { id: docId })
    if (result?.body?.content) return extractTextFromDocContent(result.body.content)
    if (typeof result?.content === "string") return result.content
    if (result?.content) return extractTextFromDocContent(result.content)
    if (typeof result?.text === "string") return result.text
    return JSON.stringify(result, null, 2)
  } catch {
    return null
  }
}

// ============================================================================
// Helpers
// ============================================================================

function extractGoogleDocId(emailData: any): string | null {
  const fields = [
    emailData?.body ?? "",
    emailData?.snippet ?? "",
    emailData?.html ?? "",
    emailData?.htmlBody ?? "",
    JSON.stringify(emailData ?? {}),
  ]
  const re = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/
  for (const text of fields) {
    const m = String(text).match(re)
    if (m) return m[1]
  }
  return null
}

interface ActionItem { title: string; owner: string | null; deadline: string }

function parseActionItems(content: string): ActionItem[] {
  const items: ActionItem[] = []
  const lines = content.split("\n")
  let inSection = false
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (/^##\s*ACTION ITEMS/i.test(trimmed)) { inSection = true; continue }
    if (inSection && /^##\s/.test(trimmed)) { inSection = false; continue }
    if (!inSection) continue
    let m = trimmed.match(/^-\s*\[[ x]?\]\s*(.+)/i) || trimmed.match(/^[-*]\s+(.{5,})/)
    if (!m) continue
    const parts = m[1].split("|").map((s) => s.trim())
    let owner: string | null = null
    let deadline: string | null = null
    for (const p of parts) {
      const om = p.match(/^Owner:\s*(.+)/i)
      if (om) owner = om[1].trim()
      const dm = p.match(/^Deadline:\s*(.+)/i)
      if (dm) deadline = dm[1].trim()
    }
    items.push({ title: parts[0], owner, deadline: deadline ?? "TBD" })
  }
  return items
}

async function fetchEmailData(emailId: string): Promise<any | null> {
  try {
    const result = await executeIntegrationCall("gmail", "read_emails", {
      messageId: emailId,
      id: emailId,
      maxResults: 1,
    })
    const emails = result?.emails ?? result?.messages ?? result?.data ?? []
    if (Array.isArray(emails)) {
      for (const e of emails) {
        if (e && typeof e === "object" && e.id === emailId) return e
      }
      if (emails.length === 1) return emails[0]
    }
    return null
  } catch {
    return null
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const ScanCommand = cmd({
  command: "scan",
  aliases: ["list"],
  describe: "list recent meeting notes from Gmail",
  builder: (y) =>
    y
      .option("days", { type: "number", default: 7 })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas — Meeting Scanner")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const days = args.days ?? 7
    const after = new Date(Date.now() - days * 86400_000)
    const ymd = `${after.getFullYear()}/${String(after.getMonth() + 1).padStart(2, "0")}/${String(after.getDate()).padStart(2, "0")}`
    const query = "(" + GMAIL_QUERIES.map((q) => `(${q})`).join(" OR ") + `) after:${ymd}`

    const spinner = prompts.spinner()
    spinner.start(`Searching Gmail (last ${days} days)…`)

    try {
      const result = await executeIntegrationCall("gmail", "search_emails", { query, maxResults: 20 })
      const messages: any[] = result?.messages ?? result?.data ?? result?.emails ?? []
      spinner.stop(`${messages.length} meeting note(s) found`)

      if (args.json) { console.log(JSON.stringify({ meetings: messages, count: messages.length, query, days }, null, 2)); prompts.outro("Done"); return }

      if (messages.length === 0) {
        prompts.log.warn(`No meeting notes in the last ${days} days.`)
        prompts.log.info("Make sure Gmail is connected: iris integrations connect gmail")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const m of messages) {
        const id = m.id ?? m.messageId ?? m.message_id ?? "?"
        const subject = m.subject ?? m.Subject ?? "(no subject)"
        const date = m.date ?? m.Date ?? m.internalDate ?? "—"
        console.log(`  ${highlight(String(id))}  ${bold(String(subject).slice(0, 50))}  ${dim(String(date))}`)
      }
      printDivider()
      prompts.outro(dim("iris atlas:meetings ingest <id> --lead=<id>"))
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const IngestCommand = cmd({
  command: "ingest [email_id]",
  aliases: ["pull"],
  describe: "ingest a meeting and route intel to a lead/bloq",
  builder: (y) =>
    y
      .positional("email_id", { type: "string" })
      .option("lead", { alias: "l", type: "number" })
      .option("bloq", { alias: "b", type: "number" })
      .option("doc", { type: "string", describe: "Google Doc ID (skip Gmail)" })
      .option("create-tasks", { type: "boolean" })
      .option("raw", { type: "boolean", describe: "Skip AI extraction" })
      .option("dry-run", { type: "boolean" })
      .option("agent", { alias: "a", type: "string", default: "11" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas — Meeting Ingestion")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const emailId = args.email_id as string | undefined
    const docId = args.doc as string | undefined
    const leadId = args.lead as number | undefined
    const bloqId = args.bloq as number | undefined
    const json = args.json === true
    const dryRun = args["dry-run"] === true
    const raw = args.raw === true
    const createTasks = args["create-tasks"] === true
    const agentId = String(args.agent ?? "11")

    if (!emailId && !docId) {
      prompts.log.error("email_id or --doc=<doc_id> required")
      prompts.outro("Done")
      return
    }
    if (!leadId && !bloqId) {
      prompts.log.error("Specify --lead=<id> or --bloq=<id>")
      prompts.outro("Done")
      return
    }

    let content: string | null = null

    try {
      if (docId) {
        const spinner = prompts.spinner()
        spinner.start(`Fetching Google Doc ${docId}…`)
        content = await fetchGoogleDoc(docId)
        if (!content) {
          spinner.stop("Failed", 1)
          prompts.log.error(`Could not fetch Google Doc: ${docId}`)
          prompts.outro("Done")
          return
        }
        spinner.stop("Doc fetched")
      } else if (emailId) {
        const spinner = prompts.spinner()
        spinner.start("Fetching meeting email…")
        const emailData = await fetchEmailData(emailId)
        if (!emailData) {
          spinner.stop("Failed", 1)
          prompts.log.error(`Could not retrieve email: ${emailId}`)
          prompts.outro("Done")
          return
        }
        const linkedDoc = extractGoogleDocId(emailData)
        if (linkedDoc) {
          content = await fetchGoogleDoc(linkedDoc)
        }
        if (!content) content = emailData.body ?? emailData.snippet ?? null
        if (!content) {
          spinner.stop("Failed", 1)
          prompts.log.error("No meeting content found. Try --doc=<DOC_ID> --raw")
          prompts.outro("Done")
          return
        }
        spinner.stop(`Content: ${content.length.toLocaleString()} chars`)
      }

      // Step 2: AI extraction or raw
      let extracted = content!
      const t0 = Date.now()
      if (!raw) {
        const spinner = prompts.spinner()
        spinner.start("Analyzing with AI…")
        const result = await runAgent(EXTRACTION_PROMPT + content, agentId)
        if (!result) {
          spinner.stop("Failed", 1)
          prompts.log.error("AI extraction returned empty")
          prompts.outro("Done")
          return
        }
        extracted = result
        spinner.stop(`Analysis done (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      }

      const actionItems = createTasks ? parseActionItems(extracted) : []

      if (dryRun) {
        if (json) {
          console.log(JSON.stringify({
            dry_run: true,
            destination: leadId ? `lead:${leadId}` : `bloq:${bloqId}`,
            extracted_content: extracted,
            action_items: actionItems,
          }, null, 2))
        } else {
          prompts.log.warn("DRY RUN — nothing saved")
          console.log(extracted)
        }
        prompts.outro("Done")
        return
      }

      // Step 3: Route
      const sourceId = emailId || (docId ? `doc:${docId}` : "unknown")

      if (leadId) {
        const noteContent = `## Meeting Intel (Atlas OS — Auto-Ingested)\n\nSource: ${sourceId}\n\n${extracted}`
        const noteRes = await irisFetch(`/api/v1/leads/${leadId}/notes`, {
          method: "POST",
          body: JSON.stringify({ message: noteContent }),
        })
        const ok = await handleApiError(noteRes, "Create note")
        if (!ok) { prompts.outro("Done"); return }
        const noteData = (await noteRes.json()) as any
        const noteId = noteData?.data?.id ?? noteData?.id

        let tasksCreated = 0
        if (createTasks && actionItems.length > 0) {
          for (const item of actionItems) {
            try {
              const r = await irisFetch(`/api/v1/leads/${leadId}/tasks`, {
                method: "POST",
                body: JSON.stringify({
                  title: item.title,
                  description: item.owner ? `Owner: ${item.owner}` : "",
                  due_date: item.deadline !== "TBD" ? item.deadline : null,
                  status: "pending",
                }),
              })
              if (r.ok) tasksCreated++
            } catch {}
          }
        }

        if (json) {
          console.log(JSON.stringify({ lead_id: leadId, note_id: noteId, tasks_created: tasksCreated }, null, 2))
        } else {
          console.log(`  ${success("✓")} Meeting intel saved to lead #${leadId}`)
          if (noteId) console.log(`  ${dim("Note ID:")} #${noteId}`)
          if (tasksCreated) console.log(`  ${dim("Tasks created:")} ${tasksCreated}`)
        }
      } else if (bloqId) {
        const res = await irisFetch(`/api/v1/bloqs/${bloqId}/items`, {
          method: "POST",
          body: JSON.stringify({
            title: `Meeting Intel — ${new Date().toLocaleDateString()}`,
            content: extracted,
            type: "note",
          }),
        })
        const ok = await handleApiError(res, "Create bloq item")
        if (!ok) { prompts.outro("Done"); return }
        const data = (await res.json()) as any
        const itemId = data?.data?.id ?? data?.id
        if (json) console.log(JSON.stringify({ bloq_id: bloqId, item_id: itemId }, null, 2))
        else console.log(`  ${success("✓")} Saved to bloq #${bloqId}${itemId ? " (item #" + itemId + ")" : ""}`)
      }

      prompts.outro("Done")
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformAtlasMeetingsCommand = cmd({
  command: "atlas:meetings",
  aliases: ["meetings"],
  describe: "[Atlas OS] Scan Gmail for meeting notes and extract intelligence",
  builder: (yargs) =>
    yargs
      .command(ScanCommand)
      .command(IngestCommand)
      .demandCommand(),
  async handler() {},
})
