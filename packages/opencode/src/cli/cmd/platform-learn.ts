import { cmd } from "./cmd"
import { irisFetch, requireAuth, handleApiError, FL_API, IRIS_API, dim, bold } from "./iris-api"
import { existsSync, readFileSync } from "fs"
import { extname } from "path"

// ============================================================================
// `iris learn <source>` — agnostic ingestion adapter.
//
// Extract content from ANY source (YouTube/video, web page, PDF/doc, raw text),
// then route it: into a bloq (knowledge), a new playbook, or a skill.
//
//   iris learn "https://youtube.com/watch?v=..." --bloq 503
//   iris learn ./notes.md --create-playbook
//   iris learn "https://example.com/docs" --playbook my-runbook
//   iris learn ./process.txt              (auto-classify → bloq | playbook)
//
// Reuses: transcribeAudio (local media), fl-api /learn/extract (video+web via
// ContentStrategies), /learn/ingest (OkfUpsert dedup), iris-api /playbooks (store).
// ============================================================================

const NANO_MODEL = "gpt-4o-mini" // nano-tier only, per house rule

const TEXT_EXTS = [".md", ".txt", ".markdown", ".json", ".yaml", ".yml", ".csv", ".log", ".html", ".xml"]
const MEDIA_EXTS = [".mp3", ".mp4", ".m4a", ".wav", ".mov", ".webm", ".aac", ".ogg"]

async function nano(prompt: string, maxTokens = 1200): Promise<string> {
  const { generateText } = await import("ai")
  const { openai } = await import("@ai-sdk/openai")
  const res = await generateText({ model: openai(NANO_MODEL), prompt, maxOutputTokens: maxTokens })
  return res.text.trim()
}

function firstJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// ── extraction ──────────────────────────────────────────────────────────────

async function extract(source: string): Promise<{ title: string; content: string; source_type: string }> {
  // Local file
  if (existsSync(source)) {
    const ext = extname(source).toLowerCase()
    if (MEDIA_EXTS.includes(ext)) {
      const { transcribeAudio } = await import("../lib/transcription")
      const r = await transcribeAudio(source, {})
      return { title: source.split("/").pop() || "Recording", content: r.text, source_type: "media" }
    }
    if (TEXT_EXTS.includes(ext) || ext === "") {
      const content = readFileSync(source, "utf8")
      return { title: deriveTitle(content), content, source_type: "file" }
    }
    if (ext === ".pdf") {
      throw new Error("PDF files: extract text first (e.g. `pdftotext file.pdf -`) then `iris learn <text-file>`.")
    }
  }

  // URL or raw text → backend extractor (video via transcript, web via scrape, raw passthrough)
  const res = await irisFetch("/api/v1/learn/extract", { method: "POST", body: JSON.stringify({ source }) }, FL_API)
  if (!res.ok) {
    await handleApiError(res, "extract source")
    throw new Error("extraction failed")
  }
  const data = (await res.json()) as any
  if (!data.success) throw new Error(data.error || "extraction failed")
  return { title: data.title, content: data.content, source_type: data.source_type }
}

function deriveTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").trim()
    if (t) return t.slice(0, 80)
  }
  return "Untitled"
}

// ── routing ───────────────────────────────────────────────────────────────

async function routeToBloq(bloqId: number, doc: any, source: string): Promise<void> {
  const res = await irisFetch("/api/v1/learn/ingest", {
    method: "POST",
    body: JSON.stringify({ bloq_id: bloqId, title: doc.title, body: doc.content, source_url: source }),
  }, FL_API)
  if (!res.ok) { await handleApiError(res, "ingest into bloq"); return }
  const r = (await res.json()) as any
  console.log(`  ${bold(r.action === "updated" ? "Updated" : "Created")} concept in bloq ${bloqId}  ${dim("(#" + r.item_id + ")")}`)
}

/**
 * Shared scaffold for both --create-playbook and --create-skill. Both produce the same
 * marketplace entity (a playbook record that compiles to a Claude Code SKILL.md); the only
 * difference is the framing of the nano structuring: a "playbook" leans on step-by-step
 * process, a "skill" leans on a reusable capability + when-to-use trigger.
 *
 * @param kind 'playbook' | 'skill'
 */
async function routeToConcept(kind: "playbook" | "skill", name: string | undefined, doc: any, source: string): Promise<void> {
  const framing = kind === "skill"
    ? `Convert the following content into a reusable IRIS skill (a capability an agent can apply, Claude Code SKILL.md style).`
    : `Convert the following content into an IRIS playbook (a repeatable step-by-step process).`

  // One structuring prompt, one JSON shape — shared by both kinds.
  const prompt = `${framing} Return ONLY JSON with keys:
"name" (kebab-case slug${name ? `, use "${name}"` : ""}), "description" (one sentence), "trigger" (when to use it),
"steps" (array of short imperative step strings; may be empty for a context skill), "inputs" (array of input names).
Content:
${doc.content.slice(0, 8000)}`

  const parsed = firstJson(await nano(prompt)) || {}
  const slug = (name || parsed.name || doc.title || kind).toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const steps = Array.isArray(parsed.steps) ? parsed.steps.filter(Boolean) : []
  const inputs = Array.isArray(parsed.inputs) ? parsed.inputs.filter(Boolean) : []

  // Build the SKILL.md-style body (compiler-compatible: trigger folds into the doc).
  const triggerLine = parsed.trigger ? `\n\n**When to use:** ${parsed.trigger}` : ""
  const stepsBody = steps.length ? "\n\n## Steps\n" + steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n") : ""
  const content = `# ${parsed.name || doc.title}\n\n${parsed.description || ""}${triggerLine}${stepsBody}\n\n---\n_Learned from: ${source}_\n\n${doc.content}`

  const payload = {
    name: slug,
    description: parsed.description || doc.title,
    args_schema: inputs.reduce((a: any, k: string) => ({ ...a, [k]: { required: false } }), {}),
    steps_summary: steps.map((s: string, i: number) => ({ id: `step-${i + 1}`, title: s, mode: "prompt" })),
    content,
    version: 2,
  }
  const res = await irisFetch("/api/v1/playbooks", { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
  if (!res.ok) { await handleApiError(res, `create ${kind}`); return }
  const label = kind === "skill" ? "Skill" : "Playbook"
  console.log(`  ${bold(label)} ${slug} ${dim("created/updated")}  →  https://web.heyiris.io/marketplace/playbooks/${slug}`)
}

async function classify(doc: any): Promise<"bloq" | "playbook"> {
  const prompt = `Classify this content as either "playbook" (a repeatable how-to process with steps a person/agent could run) or "knowledge" (facts/reference/notes). Answer with ONLY one word: playbook or knowledge.

Title: ${doc.title}
${doc.content.slice(0, 2000)}`
  const ans = (await nano(prompt, 10)).toLowerCase()
  return ans.includes("playbook") ? "playbook" : "bloq"
}

// ── command ─────────────────────────────────────────────────────────────────

export const PlatformLearnCommand = cmd({
  command: "learn <source>",
  describe: "ingest any source (video, web, doc, text) into a bloq, playbook, or skill",
  builder: (y: any) =>
    y
      .positional("source", { type: "string", describe: "URL, file path, or raw text" })
      .option("bloq", { type: "number", describe: "ingest as knowledge into this bloq id" })
      .option("create-playbook", { type: "boolean", default: false, describe: "structure into a new playbook" })
      .option("playbook", { type: "string", describe: "create/update a playbook with this name" })
      .option("create-skill", { type: "boolean", default: false, describe: "alias for --create-playbook" }),
  async handler(args: any) {
    if (!(await requireAuth())) return

    console.log(dim(`  Extracting from ${String(args.source).slice(0, 70)}…`))
    let doc
    try {
      doc = await extract(String(args.source))
    } catch (e: any) {
      console.error("  " + (e?.message || "extraction failed"))
      return
    }
    if (!doc.content || doc.content.trim().length < 20) {
      console.error("  Nothing substantial extracted from that source.")
      return
    }
    console.log(`  ${bold("Extracted")} "${doc.title}" ${dim(`(${doc.source_type}, ${doc.content.length} chars)`)}`)

    // Explicit target?
    if (typeof args.bloq === "number") { await routeToBloq(args.bloq, doc, String(args.source)); return }
    if (args["create-skill"]) {
      await routeToConcept("skill", typeof args.playbook === "string" ? args.playbook : undefined, doc, String(args.source))
      return
    }
    if (args["create-playbook"] || args.playbook) {
      await routeToConcept("playbook", typeof args.playbook === "string" ? args.playbook : undefined, doc, String(args.source))
      return
    }

    // Auto-classify
    console.log(dim("  No target given — classifying…"))
    const target = await classify(doc)
    if (target === "playbook") {
      console.log(dim("  → looks like a playbook"))
      await routeToConcept("playbook", undefined, doc, String(args.source))
    } else {
      console.log(dim("  → looks like knowledge. Pass --bloq <id> to file it, e.g. iris learn <source> --bloq 503"))
    }
  },
})
