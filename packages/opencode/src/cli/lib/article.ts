import { irisFetch, IRIS_API } from "../cmd/iris-api"

// ============================================================================
// Text → a structured article.
//
// The prompts, the verification pass and the component mapping all live server-side, for the
// same reason the walkthrough prompts do: the moment a second surface needs them, a local copy
// stops being equal. `php artisan article:draft` and this file both call ArticleDraftService,
// so a draft produced here and one produced in a prod container are the same article.
//
// TRANSCRIPTION IS NOT HERE. This takes text. Audio goes through `resolveWalkthrough`, which
// transcribes on-device — the split is what lets audio stay on the machine, and what makes an
// already-transcribed transcript the normal input rather than a special case.
// ============================================================================

export interface ArticleSection {
  heading: string
  body: string
}

export interface ArticlePullQuote {
  quote: string
  attribution: string
}

export interface ArticleDocument {
  title: string
  dek: string
  sections: ArticleSection[]
  pullQuotes: ArticlePullQuote[]
  keyPoints: string[]
  gaps: string[]
  wordCount: number
}

/** One verification finding. `severity` is error | warning | info; errors block a publish. */
export interface LintFinding {
  rule: string
  severity: "error" | "warning" | "info"
  path: string
  message: string
}

export interface DraftedArticle {
  document: ArticleDocument
  markdown: string
  components: Array<{ type: string; id: string; props: Record<string, unknown> }>
  lint: LintFinding[]
}

/** What came back after filing it on a bloq. */
export interface FiledArticle extends DraftedArticle {
  item_id: number
  lane: string
  title: string
  published: boolean
  promotion?: { status?: string; reason?: string; promoted?: Array<{ slug?: string }> }
}

export interface DraftOptions {
  angle?: string
  model?: string
  title?: string
  bloqId?: number
  skipLint?: boolean
}

export interface FileOptions extends DraftOptions {
  bloqId: number
  lane?: string
  publish?: boolean
  force?: boolean
}

/**
 * The server distinguishes "your input is unusable" (422) from "we could not produce an article"
 * (502), and its message says which. Passing that through beats a status code the reader has to
 * decode — and on the publish path the 422 body also carries the lint findings that caused it,
 * which are the actionable part.
 */
async function fail(res: Response, fallback: string): Promise<never> {
  const body = await res.text().catch(() => "")
  let message = ""
  let lint: LintFinding[] = []
  try {
    const parsed = JSON.parse(body)
    message = parsed?.error ?? ""
    lint = Array.isArray(parsed?.lint) ? parsed.lint : []
  } catch {
    /* non-JSON body — fall back to the status */
  }
  const err = new Error(message || `${fallback} (HTTP ${res.status}).`) as Error & { lint?: LintFinding[] }
  if (lint.length) err.lint = lint
  throw err
}

/** Structure and verify. Writes nothing. */
export async function draftArticle(text: string, opts: DraftOptions = {}): Promise<DraftedArticle> {
  const res = await irisFetch(
    "/api/v1/article/structure",
    {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(opts.angle ? { angle: opts.angle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.bloqId ? { bloq_id: opts.bloqId } : {}),
        ...(opts.skipLint ? { skip_lint: true } : {}),
      }),
    },
    IRIS_API,
  )

  if (!res.ok) await fail(res, "Could not draft the article")

  const data = (await res.json()) as any
  const result = data?.data
  if (!result?.document) {
    // A 200 with no document is the silent-failure shape: it reads as "your transcript had
    // nothing in it" when the truth is that extraction returned nothing.
    throw new Error("Nothing came back. Your text is unchanged.")
  }

  return result as DraftedArticle
}

/** Structure, verify, and file it on a bloq — optionally publishing. */
export async function fileArticle(text: string, opts: FileOptions): Promise<FiledArticle> {
  const res = await irisFetch(
    "/api/v1/article/draft",
    {
      method: "POST",
      body: JSON.stringify({
        text,
        bloq_id: opts.bloqId,
        ...(opts.angle ? { angle: opts.angle } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.lane ? { lane: opts.lane } : {}),
        ...(opts.publish ? { publish: true } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.skipLint ? { skip_lint: true } : {}),
      }),
    },
    IRIS_API,
  )

  if (!res.ok) await fail(res, "Could not file the article")

  const data = (await res.json()) as any
  const result = data?.data
  if (!result?.item_id) {
    throw new Error("The article was not filed. Nothing was written.")
  }

  return result as FiledArticle
}

/** Filesystem-safe name from a title. Mirrors `slugify` in ./walkthrough. */
export function articleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}
