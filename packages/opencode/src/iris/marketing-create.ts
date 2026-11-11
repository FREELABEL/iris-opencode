import { FL_API, IRIS_API, irisFetch, resolveUserId } from "./platform"

/**
 * MARKETING "+" MAKES MORE THAN A CAMPAIGN BOARD (#193233, follows #192627).
 *
 * Desktop › Marketing's wizard asks "what are you making?" first. A campaign review is
 * campaign-setup.ts. This module is the other two, the same calls the CLI makes:
 *
 *   brand kit     `iris brand create --bloq <id>`              fl-api  POST /api/v1/brands
 *   landing page  `iris pages create --template landing ...`   iris-api POST /api/v1/pages (owner = the board, draft)
 *
 * The engine only translates: a name the person typed becomes a slug, a taken slug gets one retry
 * with a suffix, and every refusal comes back in words a customer reads — never an id or an HTTP code.
 * The board picker is the campaign one (/iris/campaigns/boards: boards the account owns or edits).
 */

export type MakeKind = "brand" | "landing"
export type MakeErrorKind = "signed_out" | "not_allowed" | "not_deployed" | "invalid" | "busy" | "unreachable" | "failed"

export type MakeResult = {
  ok: boolean
  error?: { kind: MakeErrorKind; message: string }
  /** The brand's id (brand kit) — for opening it in Genesis › Brand kits. */
  id?: number
  /** The slug the platform stored. For a landing page, its /p/ address. */
  slug?: string
  name?: string
}

/** The seams a test replaces. */
export const marketingCreateDeps = {
  userId: () => resolveUserId(),
  brand: (body: Record<string, unknown>): Promise<Response> =>
    irisFetch("/api/v1/brands", FL_API, { method: "POST", body: JSON.stringify(body) }),
  page: (body: Record<string, unknown>): Promise<Response> =>
    irisFetch("/api/v1/pages", IRIS_API, { method: "POST", body: JSON.stringify(body) }),
  suffix: () => Math.random().toString(36).slice(2, 6),
}

/** "Acme Shoes — Spring!" → "acme-shoes-spring". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
}

const cleanName = (name: unknown) => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 120) : "")

export async function createBrandKit(input: { bloq_id: number; name: string }): Promise<MakeResult> {
  const name = cleanName(input.name)
  const check = precheck(input.bloq_id, name, "brand")
  if (check) return check
  const userId = await marketingCreateDeps.userId().catch(() => null)
  if (!userId) return fail("signed_out", "Sign in to IRIS first.")
  return withSlugRetry(name, async (slug) => {
    const res = await marketingCreateDeps
      .brand({ user_id: userId, name, slug, entity_type: "brand", bloq_id: input.bloq_id })
      .catch(() => undefined)
    if (!res) return { res }
    const json = res.ok ? ((await res.json().catch(() => null)) as { data?: any } | null) : null
    const b = json?.data ?? json
    return { res, made: b && Number.isFinite(Number(b.id)) ? { id: Number(b.id), slug: String(b.slug ?? slug), name: String(b.name ?? name) } : undefined }
  }, "brand")
}

export async function createLandingPage(input: { bloq_id: number; name: string }): Promise<MakeResult> {
  const name = cleanName(input.name)
  const check = precheck(input.bloq_id, name, "landing")
  if (check) return check
  return withSlugRetry(name, async (slug) => {
    const res = await marketingCreateDeps
      .page({
        slug,
        title: name,
        seo_title: name,
        owner_type: "bloq",
        owner_id: input.bloq_id,
        status: "draft",
        json_content: landingContent(slug, name),
      })
      .catch(() => undefined)
    if (!res) return { res }
    const json = res.ok ? ((await res.json().catch(() => null)) as { data?: any } | null) : null
    const p = json?.data ?? json
    return { res, made: p && typeof p.slug === "string" ? { id: Number(p.id) || undefined, slug: p.slug, name: String(p.title ?? name) } : undefined }
  }, "landing")
}

/** The same starting page `iris pages create --template landing` makes: a hero and a footer. */
export function landingContent(slug: string, title: string) {
  return {
    version: "1.0",
    type: "landing",
    theme: { mode: "dark", backgroundColor: "#000000", branding: { name: title, primaryColor: "#34d399" } },
    components: [
      { type: "Hero", id: `${slug}-hero`, props: { themeMode: "dark", title, subtitle: "", labelText: "NEW", labelColor: "#34d399", textAlign: "center" } },
      {
        type: "SiteFooter",
        id: `${slug}-footer`,
        props: { themeMode: "dark", brandName: title, copyright: `© ${new Date().getFullYear()} ${title}`, links: [] },
      },
    ],
  }
}

function precheck(bloqId: number, name: string, kind: MakeKind): MakeResult | undefined {
  if (!Number.isInteger(bloqId) || bloqId <= 0) return fail("invalid", "Pick a board first.")
  const what = kind === "brand" ? "brand" : "page"
  if (!name) return fail("invalid", `Give the ${what} a name first.`)
  if (!slugify(name)) return fail("invalid", `Use at least one letter or number in the ${what}'s name.`)
  return undefined
}

type Attempt = { res: Response | undefined; made?: { id?: number; slug: string; name: string } }

/** A taken address (409, or 422 naming the slug) gets one more try with a short suffix. */
async function withSlugRetry(name: string, attempt: (slug: string) => Promise<Attempt>, kind: MakeKind): Promise<MakeResult> {
  const base = slugify(name)
  let a = await attempt(base)
  if (a.res && (await slugTaken(a.res))) a = await attempt(`${base.slice(0, 54)}-${marketingCreateDeps.suffix()}`)
  if (!a.res) return fail("unreachable", "IRIS isn't answering right now. Nothing was made — try again in a moment.")
  if (!a.res.ok) return refusal(a.res.status, kind)
  if (!a.made) return fail("failed", "IRIS answered, but not with what was asked for. Check before trying again.")
  return { ok: true, ...a.made }
}

async function slugTaken(res: Response): Promise<boolean> {
  if (res.status === 409) return true
  if (res.status !== 422) return false
  const text = await res.clone().text().catch(() => "")
  return /slug/i.test(text) && /(taken|exists|unique|already)/i.test(text)
}

function refusal(status: number, kind: MakeKind): MakeResult {
  const what = kind === "brand" ? "brand kit" : "landing page"
  if (status === 401) return fail("signed_out", "Sign in to IRIS first.")
  if (status === 403) return fail("not_allowed", `You can't add a ${what} to this board. Ask its owner to make you an editor. Nothing was made.`)
  if (status === 404 || status === 405) return fail("not_deployed", "This part of IRIS isn't switched on yet. Nothing was made — try again after the next update.")
  if (status === 409 || status === 422) return fail("invalid", `IRIS couldn't use that name for a ${what}. Try a different one. Nothing was made.`)
  if (status === 429) return fail("busy", "Too many tries in a row. Wait a minute, then try again.")
  if (status >= 500) return fail("unreachable", `IRIS couldn't make the ${what} right now. Nothing was made — try again in a moment.`)
  return fail("failed", `IRIS couldn't make the ${what}. Nothing was made.`)
}

function fail(kind: MakeErrorKind, message: string): MakeResult {
  return { ok: false, error: { kind, message } }
}
