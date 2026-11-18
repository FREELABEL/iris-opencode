/**
 * Publish a Genesis artifact as a Genesis PAGE (the ladder: artifact → page → site).
 *
 *   artifact  local draft, this machine, this session                 (Artifacts.write)
 *   page      Genesis, at a URL, with a SCOPE the user chose           (this module)
 *   site      pages grouped under navigation — a Genesis action on the page, not here
 *
 * The scope is asked every time and sent explicitly — never inferred, never defaulted
 * silently to public:
 *   public    /p/<slug> resolves and the page can be listed
 *   unlisted  only /p/<public_id> resolves — a link you hand out
 *   private   neither resolves; only the owner, signed in. This is "Save to Genesis".
 *
 * ONE PAGE PER ARTIFACT. The artifact remembers its page (meta.published); publishing again
 * UPDATES that page in place. Without the link-back, every click would mint another page and
 * /p/ would fill with copies of the same landing page.
 *
 * Standalone HTML lane (render_mode: html) — the same json_content `iris genesis
 * publish-html` sends, so the page renders and is sandboxed server-side exactly as a
 * CLI-published one (GENESIS_HTML_PAGES_RUNBOOK).
 */
import { Artifacts } from "./artifacts"
import { FL_API, irisFetch, resolveUserId } from "./platform"

export type PublishInput = {
  rootDir: string
  session: string
  id: string
  slug: string
  visibility: Artifacts.Visibility
  requiresAuth: boolean
  /** The board to own the page; without one the page is owned by the signed-in user. */
  bloqId?: number
  /** For markdown artifacts: the rendered page, from the panel (the engine has no markdown lib). */
  html?: string
  /**
   * Who may get a sign-in code (#193846): exact addresses and whole domains, stored as the page's
   * json_content.gate the way fl-api reads it (GateShape / SiteGate). Omitted = keep the page's
   * current list, whatever set it — the CLI, an agent, or a person by hand.
   */
  gate?: SignInList
}

export type SignInList = { allowedEmails: string[]; allowedDomains: string[] }

export type PublishResult = {
  ok: boolean
  reason?: string
  published?: Artifacts.Published
  /** fl-api's heads-up for a page served sandboxed (data.sandbox), passed through. */
  sandbox?: unknown
}

const PUBLIC_SITE = process.env.IRIS_PUBLIC_SITE ?? "https://heyiris.io"
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A title turned into a slug a page can have: lowercase, hyphenated, bounded. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "artifact"
  )
}

export function validSlug(s: string): boolean {
  return SLUG.test(s) && s.length <= 120
}

/** Split an authored HTML document into the fields a standalone Genesis page takes. */
export function htmlToPageContent(src: string, requiresAuth: boolean) {
  const title = src
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
  const description = src
    .match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([\s\S]*?)["']/i)?.[1]
    ?.trim()
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi
  const css = [...src.matchAll(styleRe)].map((m) => m[1].trim()).join("\n\n")
  const bodyMatch = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const body = (
    bodyMatch
      ? bodyMatch[1]
      : src
          .replace(/<!DOCTYPE[^>]*>/gi, "")
          .replace(/<\/?html[^>]*>/gi, "")
          .replace(/<head[\s\S]*?<\/head>/gi, "")
          .replace(/<\/?body[^>]*>/gi, "")
  )
    .replace(styleRe, "")
    .trim()
  return {
    title,
    description,
    json_content: { version: "2.0", type: "article", render_mode: "html", html: body, css, requireOtp: requiresAuth },
  }
}

/** Where a page can be opened, for the scope it has. */
export function pageUrl(
  page: { slug?: string; public_id?: string; public_url?: string },
  visibility: Artifacts.Visibility,
) {
  if (visibility === "unlisted" && page.public_id) return `${PUBLIC_SITE}/p/${page.public_id}`
  if (visibility === "public" && page.public_url) return page.public_url
  return `${PUBLIC_SITE}/p/${page.slug}`
}

function apiReason(j: any, status: number): string {
  if (status === 401) return "not signed in to IRIS — run `iris auth login`"
  const errors = j?.errors && typeof j.errors === "object" ? Object.values(j.errors).flat().join("; ") : ""
  return [`Genesis ${status}`, j?.message, errors].filter(Boolean).join(": ")
}

/**
 * Entries a person typed, split into the two lists the gate stores. An address is an email;
 * "@x.com", "x.com" and "https://x.com" are the domain x.com. Anything else is returned in `bad`
 * so the caller can refuse it out loud — fl-api refuses the whole gate (422) for one bad entry.
 */
export function splitSignInEntries(entries: string[]) {
  const clean = entries.map((e) => e.trim().toLowerCase()).filter(Boolean)
  const email = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  const domain = (e: string) => e.replace(/^https?:\/\//, "").replace(/^@/, "").replace(/\/.*$/, "")
  const isDomain = (e: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain(e))
  return {
    allowedEmails: [...new Set(clean.filter(email))],
    allowedDomains: [...new Set(clean.filter((e) => !email(e) && isDomain(e)).map(domain))],
    bad: clean.filter((e) => !email(e) && !isDomain(e)),
  }
}

/**
 * The page's current sign-in list, as stored. `known: false` when the page can't be read or its
 * gate is stored in a shape this can't trust (fl-api #270 repairs those on the next save).
 */
export async function readPageGate(pageId: number) {
  const res = await irisFetch(`/api/v1/pages/${pageId}`, FL_API).catch(() => null)
  if (!res?.ok) return { known: false, allowedEmails: [], allowedDomains: [], requireOtp: false }
  const j = (await res.json().catch(() => ({}))) as any
  const content = typeof (j?.data ?? j)?.json_content === "string" ? safeJson((j?.data ?? j).json_content) : (j?.data ?? j)?.json_content
  const gate = content?.gate
  if (gate !== undefined && (typeof gate !== "object" || gate === null))
    return { known: false, allowedEmails: [], allowedDomains: [], requireOtp: !!content?.requireOtp }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  return {
    known: true,
    allowedEmails: list(gate?.allowedEmails),
    allowedDomains: list(gate?.allowedDomains),
    requireOtp: !!content?.requireOtp,
    gate: (gate ?? undefined) as Record<string, unknown> | undefined,
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export async function publishArtifact(input: PublishInput): Promise<PublishResult> {
  if (!["public", "unlisted", "private"].includes(input.visibility)) return { ok: false, reason: "choose a scope" }
  if (!validSlug(input.slug)) return { ok: false, reason: "the address can use lowercase letters, numbers and hyphens" }
  const art = Artifacts.read(input.rootDir, input.session, input.id)
  if (!art) return { ok: false, reason: `no artifact ${input.id} in this session` }
  const typed = input.gate ? splitSignInEntries([...input.gate.allowedEmails, ...input.gate.allowedDomains]) : undefined
  if (typed?.bad.length) return { ok: false, reason: `not an email or a domain: ${typed.bad.join(", ")}` }
  if (art.truncated) return { ok: false, reason: "this artifact is over 2 MB — too large to publish as a page" }

  let source: string
  if (art.meta.kind === "html") source = art.content
  else if (art.meta.kind === "markdown" && input.html) source = input.html
  else
    return { ok: false, reason: `a ${art.meta.kind} artifact can't be published as a page yet — html and markdown can` }

  const content = htmlToPageContent(source, input.requiresAuth)
  if (!content.json_content.html) return { ok: false, reason: "the artifact has no body to publish" }
  const title = art.meta.title || content.title || input.slug

  const owner = input.bloqId
    ? { owner_type: "bloq", owner_id: input.bloqId }
    : await resolveUserId().then((id) => (id ? { owner_type: "user", owner_id: id } : null))
  if (!owner) return { ok: false, reason: "not signed in to IRIS — run `iris auth login`" }

  const prior = art.meta.published
  // Republishing used to PUT a fresh json_content, which silently dropped the page's sign-in
  // list — so a list set by the CLI or by hand (Pathways, #192655) vanished on the next publish
  // from Desktop. Read what is there and keep every gate key; replace only the lists given.
  const existing = prior?.pageId ? await readPageGate(prior.pageId) : undefined
  if (existing && !existing.known && !typed)
    return { ok: false, reason: "couldn't read this page's sign-in list, so it wasn't overwritten — try again" }
  const gate = typed
    ? { ...(existing?.gate ?? {}), allowedEmails: typed.allowedEmails, allowedDomains: typed.allowedDomains }
    : existing?.gate
  if (gate) Object.assign(content.json_content, { gate })
  const common = {
    title,
    seo_title: title,
    ...(content.description ? { seo_description: content.description } : {}),
    json_content: content.json_content,
    visibility: input.visibility,
    requires_auth: input.requiresAuth,
  }

  try {
    let page: any
    let sandbox: unknown
    if (prior?.pageId) {
      // Update the SAME page — slug changes are allowed, a second page is not.
      const res = await irisFetch(`/api/v1/pages/${prior.pageId}`, FL_API, {
        method: "PUT",
        body: JSON.stringify({ ...common, ...(input.slug !== prior.slug ? { slug: input.slug } : {}) }),
      })
      const j = (await res.json().catch(() => ({}))) as any
      if (!res.ok) return { ok: false, reason: apiReason(j, res.status) }
      page = j?.data ?? j
      sandbox = j?.data?.sandbox
      const pub = await irisFetch(`/api/v1/pages/${prior.pageId}/publish`, FL_API, { method: "POST" })
      if (!pub.ok) return { ok: false, reason: apiReason(await pub.json().catch(() => ({})), pub.status) }
    } else {
      const res = await irisFetch(`/api/v1/pages`, FL_API, {
        method: "POST",
        body: JSON.stringify({ ...owner, slug: input.slug, ...common, auto_publish: true }),
      })
      const j = (await res.json().catch(() => ({}))) as any
      if (!res.ok) {
        const taken = res.status === 422 && JSON.stringify(j?.errors ?? {}).includes("slug")
        return {
          ok: false,
          reason: taken ? `the address ${input.slug} is taken — pick another` : apiReason(j, res.status),
        }
      }
      page = j?.data ?? j
      sandbox = j?.data?.sandbox
    }

    const pageId = Number(page?.id ?? prior?.pageId)
    if (!Number.isInteger(pageId)) return { ok: false, reason: "Genesis saved the page but did not say which one" }
    // A stale cached render reads as "the publish didn't work" — same purge publish-html does.
    await irisFetch(`/api/internal/cache/purge-page`, FL_API, {
      method: "POST",
      body: JSON.stringify({ slug: input.slug }),
    }).catch(() => {})

    const published: Artifacts.Published = {
      pageId,
      slug: String(page?.slug ?? input.slug),
      url: pageUrl(
        { slug: page?.slug ?? input.slug, public_id: page?.public_id, public_url: page?.public_url },
        input.visibility,
      ),
      visibility: input.visibility,
      requiresAuth: input.requiresAuth,
      revision: art.meta.revision,
      at: new Date().toISOString(),
    }
    Artifacts.setPublished(input.rootDir, input.session, input.id, published)
    return { ok: true, published, sandbox }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
