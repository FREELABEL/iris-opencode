import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API } from "./iris-api"
import { homedir } from "os"
import { join } from "path"

// ============================================================================
// Article Quality Analysis — editorial content linter
//
// Fetches a Genesis page by slug, extracts EditorialSection body text, and
// scores it against a structured quality framework using gpt-4.1-nano.
// ============================================================================

const MODEL = "gpt-4.1-nano"

// ── Frameworks ──────────────────────────────────────────────────

interface QualityCriterion {
  key: string
  label: string
  description: string
}

interface QualityFramework {
  name: string
  criteria: QualityCriterion[]
}

const NCMA_6POINT: QualityFramework = {
  name: "ncma-6point",
  criteria: [
    { key: "named_sources", label: "Named Sources", description: "Does it cite at least 2 verifiable sources (named person, publication, regulation number, or URL)?" },
    { key: "dfw_anchor", label: "DFW Anchor", description: "Does it name at least 2 specific DFW employers, programs, or installations?" },
    { key: "action_items", label: "Action Items", description: "Does it include at least 3 concrete things the reader can do this week?" },
    { key: "unsourced_stats", label: "Unsourced Stats", description: "Is every number/percentage backed by a named source? (10 = no unsourced stats)" },
    { key: "zero_filler", label: "Zero Filler", description: "Does the conclusion provide specific value vs generic platitudes?" },
    { key: "google_test", label: "Google Test", description: "Does it provide a unique local perspective not easily found via search?" },
  ],
}

const FRAMEWORKS: Record<string, QualityFramework> = {
  "ncma-6point": NCMA_6POINT,
}

// ── OpenAI key resolution ───────────────────────────────────────

async function resolveOpenAIKey(): Promise<string | null> {
  // 1. Env var
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  // 2. SDK env file
  try {
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    const file = Bun.file(envPath)
    if (await file.exists()) {
      const raw = await file.text()
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      for (const line of text.split("\n")) {
        const m = line.match(/^OPENAI_API_KEY\s*=\s*(.+)/)
        if (m && m[1]) return m[1].trim()
      }
    }
  } catch {}
  // 3. Config file
  try {
    const configPath = join(homedir(), ".iris", "config.json")
    const file = Bun.file(configPath)
    if (await file.exists()) {
      const config = JSON.parse(await file.text())
      if (config?.openai_api_key) return config.openai_api_key
    }
  } catch {}
  return null
}

// ── AI call ─────────────────────────────────────────────────────

interface ScoreResult {
  scores: Record<string, { score: number; pass: boolean; reason: string }>
  overall: number
  top_issue: string
  suggested_fix: string
}

async function scoreArticle(text: string, title: string, framework: QualityFramework): Promise<ScoreResult | null> {
  const apiKey = await resolveOpenAIKey()
  if (!apiKey) {
    prompts.log.error("No OpenAI API key found. Set OPENAI_API_KEY in your environment or ~/.iris/sdk/.env")
    return null
  }

  const criteriaBlock = framework.criteria
    .map((c, i) => `${i + 1}. **${c.label}** (key: "${c.key}"): ${c.description}`)
    .join("\n")

  const systemPrompt = `You are an editorial quality analyst. You score articles against a structured quality framework.
Return ONLY valid JSON — no markdown fences, no commentary outside the JSON object.`

  const userPrompt = `Score the following article against each criterion (1-10 scale).

## Quality Framework: ${framework.name}

${criteriaBlock}

## Article
Title: ${title}
---
${text}
---

Return this exact JSON structure:
{
  "scores": {
${framework.criteria.map((c) => `    "${c.key}": { "score": <1-10>, "pass": <true if score >= 6>, "reason": "<brief explanation>" }`).join(",\n")}
  },
  "overall": <average of all scores, 1 decimal>,
  "top_issue": "<single most impactful issue to fix>",
  "suggested_fix": "<concrete action to address the top issue>"
}`

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      }),
    })

    if (!res.ok) {
      const err = await res.text().catch(() => "")
      prompts.log.error(`OpenAI API error: HTTP ${res.status} ${err.slice(0, 200)}`)
      return null
    }

    const data = (await res.json()) as any
    const content: string = data?.choices?.[0]?.message?.content ?? ""

    // Strip markdown fences if model wraps output
    const cleaned = content.replace(/^```json?\s*/i, "").replace(/\s*```\s*$/i, "").trim()

    try {
      return JSON.parse(cleaned) as ScoreResult
    } catch {
      prompts.log.error("Failed to parse AI response as JSON")
      if (process.argv.includes("--print-logs")) {
        console.error("[article-qa] Raw response:", content)
      }
      return null
    }
  } catch (err) {
    prompts.log.error(`OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ── Page fetching ───────────────────────────────────────────────

function pagesFetch(path: string, options?: RequestInit): Promise<Response> {
  return irisFetch(path, options ?? {}, IRIS_API)
}

async function getBySlug(slug: string): Promise<any | null> {
  const params = new URLSearchParams({ include_json: "1", include_drafts: "1" })
  const res = await pagesFetch(`/api/v1/pages/by-slug/${encodeURIComponent(slug)}?${params}`)
  if (!res.ok) {
    await handleApiError(res, `Get page ${slug}`)
    return null
  }
  const data = (await res.json()) as { data?: any }
  return data?.data ?? data
}

async function listPages(prefix?: string): Promise<any[]> {
  const res = await pagesFetch("/api/v1/pages?per_page=100&include_json=1&include_drafts=1")
  if (!res.ok) return []
  const json = (await res.json()) as any
  let pages: any[] = []
  if (Array.isArray(json?.data)) pages = json.data
  else if (Array.isArray(json?.data?.data)) pages = json.data.data
  else if (Array.isArray(json)) pages = json
  if (prefix) {
    pages = pages.filter((p: any) => p.slug?.startsWith(prefix))
  }
  return pages
}

// ── Content extraction ──────────────────────────────────────────

function extractEditorialText(page: any): { text: string; title: string; wordCount: number } {
  const title = page?.title ?? page?.slug ?? "Untitled"
  const components: any[] = page?.json_content?.components ?? []

  const textParts: string[] = []

  for (const comp of components) {
    const type = comp?.type ?? ""
    // Extract from EditorialSection and similar text-heavy components
    if (type === "EditorialSection" || type === "Section" || type === "NewsletterBodyBlock") {
      const body = comp?.props?.body ?? comp?.props?.content ?? comp?.props?.text ?? ""
      if (body) textParts.push(stripHtml(body))
    }
    // Also grab titles and subtitles from any component
    if (comp?.props?.title) textParts.push(stripHtml(comp.props.title))
    if (comp?.props?.subtitle) textParts.push(stripHtml(comp.props.subtitle))
    if (comp?.props?.description) textParts.push(stripHtml(comp.props.description))
  }

  const text = textParts.join("\n\n").trim()
  const wordCount = text.split(/\s+/).filter(Boolean).length

  return { text, title, wordCount }
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// ── Display ─────────────────────────────────────────────────────

function verdictLabel(overall: number, threshold: number): string {
  if (overall >= 8.0) return `${success("PUBLISH")} ${success("✓")}`
  if (overall >= threshold) return `${highlight("REVIEW")} ${highlight("!")}`
  return `${UI.Style.TEXT_DANGER}REWRITE ${UI.Style.TEXT_NORMAL}x`
}

function scoreIndicator(score: number): string {
  if (score >= 8) return success("✓")
  if (score >= 6) return highlight("!")
  return `${UI.Style.TEXT_DANGER}x${UI.Style.TEXT_NORMAL}`
}

function padRight(s: string, len: number): string {
  // Account for ANSI codes when padding
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "")
  const pad = Math.max(0, len - visible.length)
  return s + " ".repeat(pad)
}

function printReport(title: string, wordCount: number, result: ScoreResult, framework: QualityFramework, threshold: number): void {
  console.log()
  console.log(`  Article: ${bold(`"${title}"`)}`)
  console.log(`  Word Count: ${wordCount}`)
  printDivider()

  for (const criterion of framework.criteria) {
    const s = result.scores[criterion.key]
    if (!s) continue
    const label = padRight(`${criterion.label}:`, 19)
    const scoreStr = `${s.score}/10`
    const indicator = scoreIndicator(s.score)
    const reason = dim(s.reason)
    console.log(`  ${label} ${scoreStr}  ${indicator}  ${reason}`)
  }

  printDivider()
  console.log(`  Overall:           ${bold(String(result.overall))}/10`)
  console.log(`  Verdict:           ${verdictLabel(result.overall, threshold)}`)
  console.log(`  Top Issue:         ${result.top_issue}`)
  console.log(`  Suggested Fix:     ${dim(result.suggested_fix)}`)
  console.log()
}

// ── Subcommands ─────────────────────────────────────────────────

const RunCmd = cmd({
  command: "$0 <slug>",
  describe: "analyze a single article by page slug",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("framework", { alias: "f", type: "string", default: "ncma-6point", describe: "scoring framework name" })
      .option("threshold", { alias: "t", type: "number", default: 6.0, describe: "minimum passing score" })
      .option("json", { type: "boolean", default: false, describe: "output as JSON" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Article QA — ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const framework = FRAMEWORKS[args.framework]
    if (!framework) {
      prompts.log.error(`Unknown framework: ${args.framework}. Available: ${Object.keys(FRAMEWORKS).join(", ")}`)
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start("Fetching page...")
    const page = await getBySlug(args.slug)
    if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }

    const { text, title, wordCount } = extractEditorialText(page)
    if (!text || wordCount < 10) {
      sp.stop("No editorial content found", 1)
      prompts.log.warn("This page has no EditorialSection or similar text components to analyze.")
      prompts.outro("Done")
      return
    }
    sp.stop(`${success("✓")} ${bold(title)} (${wordCount} words)`)

    const sp2 = prompts.spinner()
    sp2.start(`Scoring with ${MODEL}...`)
    const result = await scoreArticle(text, title, framework)
    if (!result) { sp2.stop("Scoring failed", 1); prompts.outro("Done"); return }
    sp2.stop(`${success("✓")} Analysis complete`)

    if (args.json) {
      console.log(JSON.stringify({
        slug: args.slug,
        title,
        word_count: wordCount,
        framework: framework.name,
        threshold: args.threshold,
        ...result,
        verdict: result.overall >= 8.0 ? "PUBLISH" : result.overall >= args.threshold ? "REVIEW" : "REWRITE",
      }, null, 2))
    } else {
      printReport(title, wordCount, result, framework, args.threshold)
    }
    prompts.outro("Done")
  },
})

const BatchCmd = cmd({
  command: "batch",
  aliases: ["all"],
  describe: "run QA on all pages matching a prefix",
  builder: (y) =>
    y
      .option("prefix", { alias: "p", type: "string", demandOption: true, describe: "slug prefix to match (e.g. ncma-)" })
      .option("framework", { alias: "f", type: "string", default: "ncma-6point", describe: "scoring framework name" })
      .option("threshold", { alias: "t", type: "number", default: 6.0, describe: "minimum passing score" })
      .option("json", { type: "boolean", default: false, describe: "output as JSON" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Article QA — batch (prefix: ${args.prefix})`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const framework = FRAMEWORKS[args.framework]
    if (!framework) {
      prompts.log.error(`Unknown framework: ${args.framework}. Available: ${Object.keys(FRAMEWORKS).join(", ")}`)
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start("Loading pages...")
    const pages = await listPages(args.prefix)
    if (pages.length === 0) {
      sp.stop("No pages found", 1)
      prompts.outro("Done")
      return
    }
    sp.stop(`${pages.length} page(s) matching "${args.prefix}"`)

    const results: any[] = []
    let passCount = 0
    let reviewCount = 0
    let rewriteCount = 0
    let skipCount = 0

    for (const page of pages) {
      const slug = page.slug ?? "unknown"

      // Fetch full page with json_content if not already included
      let fullPage = page
      if (!page?.json_content?.components) {
        fullPage = await getBySlug(slug)
        if (!fullPage) {
          prompts.log.warn(`Skipping ${slug} — could not fetch`)
          skipCount++
          continue
        }
      }

      const { text, title, wordCount } = extractEditorialText(fullPage)
      if (!text || wordCount < 10) {
        prompts.log.warn(`Skipping ${slug} — no editorial content`)
        skipCount++
        continue
      }

      const sp2 = prompts.spinner()
      sp2.start(`Scoring ${bold(slug)}...`)
      const result = await scoreArticle(text, title, framework)
      if (!result) {
        sp2.stop(`${slug} — scoring failed`, 1)
        skipCount++
        continue
      }

      const verdict = result.overall >= 8.0 ? "PUBLISH" : result.overall >= args.threshold ? "REVIEW" : "REWRITE"
      if (verdict === "PUBLISH") passCount++
      else if (verdict === "REVIEW") reviewCount++
      else rewriteCount++

      sp2.stop(`${slug} — ${result.overall}/10 ${verdict === "PUBLISH" ? success(verdict) : verdict === "REVIEW" ? highlight(verdict) : verdict}`)

      results.push({
        slug,
        title,
        word_count: wordCount,
        overall: result.overall,
        verdict,
        top_issue: result.top_issue,
        scores: result.scores,
        suggested_fix: result.suggested_fix,
      })
    }

    if (args.json) {
      console.log(JSON.stringify({
        framework: framework.name,
        threshold: args.threshold,
        summary: { total: results.length, publish: passCount, review: reviewCount, rewrite: rewriteCount, skipped: skipCount },
        articles: results,
      }, null, 2))
    } else {
      console.log()
      printDivider()
      console.log(`  ${bold("Summary")}`)
      printKV("Total analyzed", results.length)
      printKV("Skipped", skipCount)
      printKV("PUBLISH", passCount)
      printKV("REVIEW", reviewCount)
      printKV("REWRITE", rewriteCount)

      if (rewriteCount > 0) {
        console.log()
        console.log(`  ${bold("Needs rewrite:")}`)
        for (const r of results.filter((r) => r.verdict === "REWRITE")) {
          console.log(`    ${r.slug} (${r.overall}/10) — ${r.top_issue}`)
        }
      }
      printDivider()
    }
    prompts.outro("Done")
  },
})

const FrameworksCmd = cmd({
  command: "frameworks",
  aliases: ["fw"],
  describe: "list available scoring frameworks",
  builder: (y) => y,
  async handler() {
    UI.empty()
    prompts.intro("◈  QA Frameworks")
    printDivider()
    for (const [name, fw] of Object.entries(FRAMEWORKS)) {
      console.log(`  ${bold(name)}  (${fw.criteria.length} criteria)`)
      for (const c of fw.criteria) {
        console.log(`    ${dim(c.label)}: ${dim(c.description.slice(0, 70))}`)
      }
      console.log()
    }
    printDivider()
    prompts.outro(dim("iris article-qa <slug> --framework ncma-6point"))
  },
})

// ── Main export ─────────────────────────────────────────────────

export const PlatformArticleQaCommand = cmd({
  command: "article-qa",
  aliases: ["qa"],
  describe: "editorial content quality linter — score articles against quality frameworks",
  builder: (y) =>
    y
      .command(BatchCmd)
      .command(FrameworksCmd)
      .command(RunCmd)
      .demandCommand(0),
  async handler() {},
})
