import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
} from "./iris-api"
import { existsSync, readFileSync } from "fs"
import { extname, isAbsolute, join } from "path"

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

--- TRANSCRIPT ---

`

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

function readTranscript(filePath: string): string | null {
  const path = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath)
  if (!existsSync(path)) return null
  const ext = extname(path).slice(1).toLowerCase()
  if (!["md", "txt", "text", "docx"].includes(ext)) return null
  if (ext === "docx") {
    // Best-effort: strip XML tags from document.xml inside zip — skip for now
    try {
      const buf = readFileSync(path)
      // crude: extract any printable text from buffer (won't be clean, recommend .md/.txt)
      const str = buf.toString("utf-8")
      return str.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    } catch {
      return null
    }
  }
  return readFileSync(path, "utf-8")
}

async function runAgent(prompt: string, agentId: string, timeoutSecs = 300): Promise<string | null> {
  const startRes = await irisFetch("/api/chat/start", {
    method: "POST",
    body: JSON.stringify({
      query: prompt,
      agentId,
      conversationHistory: [{ role: "user", content: prompt }],
      enableRAG: false,
      contextPayload: { source: "iris-cli-leads-meeting" },
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

export const PlatformLeadsMeetingCommand = cmd({
  command: "leads:meeting <lead_id> <file_path>",
  describe: "ingest a meeting transcript and extract intel for a lead",
  builder: (y) =>
    y
      .positional("lead_id", { type: "number", demandOption: true })
      .positional("file_path", { type: "string", demandOption: true })
      .option("agent", { alias: "a", type: "string", default: "11" })
      .option("create-tasks", { type: "boolean" })
      .option("raw", { type: "boolean", describe: "Skip AI extraction" })
      .option("dry-run", { type: "boolean" })
      .option("json", { type: "boolean" })
      .option("timeout", { alias: "t", type: "number", default: 300 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Meeting Intel — Lead #${args.lead_id}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const filePath = String(args.file_path)
    const transcript = readTranscript(filePath)
    if (!transcript) {
      prompts.log.error(`Could not read file: ${filePath} (supported: .md, .txt, .docx)`)
      prompts.outro("Done")
      return
    }

    if (!args.json) {
      printDivider()
      console.log(`  ${dim("Lead:")}       #${args.lead_id}`)
      console.log(`  ${dim("File:")}       ${filePath}`)
      console.log(`  ${dim("Characters:")} ${transcript.length.toLocaleString()}`)
      console.log(`  ${dim("Agent:")}      #${args.agent}`)
      console.log(`  ${dim("Dry run:")}    ${args["dry-run"] ? "yes" : "no"}`)
      console.log(`  ${dim("Tasks:")}      ${args["create-tasks"] ? "will create" : "notes only"}`)
      printDivider()
    }

    try {
      let extracted = transcript
      const t0 = Date.now()
      if (!args.raw) {
        const spinner = prompts.spinner()
        spinner.start("Analyzing transcript with AI…")
        const result = await runAgent(EXTRACTION_PROMPT + transcript, String(args.agent ?? "11"), args.timeout ?? 300)
        if (!result) {
          spinner.stop("Failed", 1)
          prompts.log.error("AI extraction returned empty content")
          prompts.outro("Done")
          return
        }
        extracted = result
        spinner.stop(`Analysis complete (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      }

      const actionItems = args["create-tasks"] ? parseActionItems(extracted) : []

      if (args["dry-run"]) {
        if (args.json) {
          console.log(JSON.stringify({
            dry_run: true,
            lead_id: args.lead_id,
            extracted_content: extracted,
            action_items: actionItems,
          }, null, 2))
        } else {
          prompts.log.warn("DRY RUN — nothing will be saved")
          console.log(extracted)
        }
        prompts.outro("Done")
        return
      }

      const noteContent = `## Meeting Intel (AI-Extracted)\n\n${extracted}`
      const noteRes = await irisFetch(`/api/v1/leads/${args.lead_id}/notes`, {
        method: "POST",
        body: JSON.stringify({
          message: noteContent,
          type: "meeting_intel",
          activity_type: "meeting",
          activity_icon: "clipboard-document-list",
        }),
      })
      const ok = await handleApiError(noteRes, "Create note")
      if (!ok) { prompts.outro("Done"); return }
      const noteData = (await noteRes.json()) as any
      const noteId = noteData?.data?.id ?? noteData?.id

      const createdTasks: any[] = []
      if (args["create-tasks"] && actionItems.length > 0) {
        for (const item of actionItems) {
          try {
            const r = await irisFetch(`/api/v1/leads/${args.lead_id}/tasks`, {
              method: "POST",
              body: JSON.stringify({
                title: item.title,
                description: item.owner ? `Owner: ${item.owner}` : "",
                due_date: item.deadline !== "TBD" ? item.deadline : null,
                status: "pending",
              }),
            })
            if (r.ok) {
              const td = (await r.json()) as any
              createdTasks.push({ id: td?.data?.id ?? td?.id, title: item.title, owner: item.owner, deadline: item.deadline })
            }
          } catch {}
        }
      }

      if (args.json) {
        console.log(JSON.stringify({
          lead_id: args.lead_id,
          note_id: noteId,
          extracted_content: extracted,
          tasks_created: createdTasks,
          file: filePath,
        }, null, 2))
      } else {
        console.log(`  ${success("✓")} Meeting intel saved to lead #${args.lead_id}`)
        if (noteId) console.log(`  ${dim("Note ID:")} #${noteId}`)
        if (createdTasks.length > 0) {
          console.log(`  ${bold("Tasks created:")} ${createdTasks.length}`)
          for (const t of createdTasks) {
            console.log(`    - ${t.title}${t.owner ? " (" + t.owner + ")" : ""}${t.deadline && t.deadline !== "TBD" ? " — " + t.deadline : ""}`)
          }
        }
      }
      prompts.outro("Done")
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})
