/**
 * Atlas Edge — export a page's data collections next to the page (#185860, tier 1).
 *
 * Bound components fetch a RELATIVE path with cookies:
 *
 *   CaseListTable.vue:18   endpoint: '/api/v1/app-data/pathways-dashboard/cases'
 *   CaseListTable.vue:71   fetch(endpoint, { credentials: 'include' })
 *
 * So on a client's box that request already targets their own origin. Nothing in the page needs
 * changing — a file at that exact path answers it. For a read-only dashboard, Atlas Edge is a
 * folder of JSON, not a database.
 *
 * The two refusals are the point of this module, not a safety afterthought:
 *
 *   ADR-02  a static file cannot scope per viewer. Exporting a collection whose rows differ by
 *           viewer publishes the whole table to anyone who can reach the box, with no error.
 *   ADR-03  PHI does not leave for a machine we do not operate without a human compliance
 *           decision. Deny-list posture: flagged means refused, never "probably fine".
 *
 * Ported from scripts/genesis-edge/export-data.mjs + export-data-cli.mjs.
 */
import fs from "fs"
import path from "path"
import { discoverCollections } from "./discover"

const PHI_HINT = /(^|[-_])phi([-_]|$)|patient|diagnosis|treatment|medical|clinical/i

const url = (origin: string, slug: string, collection: string): string =>
  `${origin}/api/v1/app-data/${encodeURIComponent(slug)}/${encodeURIComponent(collection)}`

export type FetchResult = { status: number; ok: boolean; text: string }

export type ViewerVariance =
  | { varies: null; unreachable: true; status: number }
  | { varies: boolean; unreachable?: undefined; anonymous: FetchResult; named: FetchResult }

export type ExportedCollection = {
  collection: string
  source: string
  bytes: number
  exported_at: string
}

export type RefusedCollection = { collection: string; reason: string }

async function fetchAs(target: string, identity: string | null): Promise<FetchResult> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (identity) headers.Cookie = `identity=${identity}`
  const res = await fetch(target, { headers })
  const text = await res.text()
  return { status: res.status, ok: res.ok, text }
}

/**
 * Does this collection return different rows to different viewers?
 *
 * Measured by DIFFING two identities, never inferred from the collection's name. "Looks scoped" is
 * not a measurement, and the cost of guessing wrong is publishing someone else's rows.
 */
export async function probeViewerVariance({
  origin,
  slug,
  collection,
}: {
  origin: string
  slug: string
  collection: string
}): Promise<ViewerVariance> {
  const target = url(origin, slug, collection)
  const anon = await fetchAs(target, null)
  const named = await fetchAs(target, "alice")

  if (!anon.ok || !named.ok) {
    return { varies: null, unreachable: true, status: anon.ok ? named.status : anon.status }
  }
  return { varies: anon.text !== named.text, anonymous: anon, named }
}

/**
 * Export the collections that are safe to export, refuse the rest, and record BOTH.
 *
 * A refusal that leaves no trace looks exactly like a collection nobody asked for, so every
 * decision lands in the edge manifest.
 */
export async function exportCollections({
  origin,
  slug,
  site,
  collections,
  allowPhi = false,
}: {
  origin: string
  slug: string
  site: string
  collections: string[]
  allowPhi?: boolean
}): Promise<{ exported: ExportedCollection[]; refused: RefusedCollection[] }> {
  const outDir = path.join(site, "api/v1/app-data", slug)
  const exported: ExportedCollection[] = []
  const refused: RefusedCollection[] = []

  for (const collection of collections) {
    if (!allowPhi && PHI_HINT.test(collection)) {
      refused.push({ collection, reason: "PHI-flagged — needs a written compliance decision (ADR-03)" })
      continue
    }

    const probe = await probeViewerVariance({ origin, slug, collection })

    if (probe.unreachable) {
      refused.push({ collection, reason: `origin returned HTTP ${probe.status} — not written to disk` })
      continue
    }
    if (probe.varies) {
      refused.push({
        collection,
        reason: "rows differ by viewer — a static file cannot scope per viewer (ADR-02)",
      })
      continue
    }

    // A flagged payload is refused even when the name looked harmless.
    let parsed: any
    try {
      parsed = JSON.parse(probe.anonymous.text)
    } catch {
      refused.push({ collection, reason: "origin did not return JSON — not written to disk" })
      continue
    }
    if (!allowPhi && parsed && parsed.phi === true) {
      refused.push({ collection, reason: "payload is PHI-flagged — refused (ADR-03)" })
      continue
    }

    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, collection), probe.anonymous.text)
    exported.push({
      collection,
      source: url(origin, slug, collection),
      bytes: Buffer.byteLength(probe.anonymous.text),
      exported_at: new Date().toISOString(),
    })
  }

  writeEdgeManifest(site, slug, exported, refused)
  return { exported, refused }
}

/**
 * Provenance, so a dashboard can say whether it is live or a snapshot and how old it is. Without
 * it a stale board is indistinguishable from a current one — which is the quiet way an edge
 * deployment starts lying.
 */
function writeEdgeManifest(
  site: string,
  slug: string,
  exported: ExportedCollection[],
  refused: RefusedCollection[],
): void {
  const file = path.join(site, "api/v1/app-data/_edge.json")
  let manifest: any = { slugs: [], generated_at: null, collections: [] }
  if (fs.existsSync(file)) {
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      /* rewrite it */
    }
  }

  // Keyed by DATA SLUG + collection, not collection alone. A page can bind collections from more
  // than one data slug, and keying by name let `a/cases` and `b/cases` overwrite each other — so an
  // EXPORT under one slug could erase the record of a REFUSAL under another. The refusals are the
  // audit trail; that is the half that must never be lost. Entries written before this carry no
  // slug, so they inherit the manifest-level one they were written under.
  const keyOf = (c: any) => `${c.slug ?? manifest.slug ?? slug}/${c.collection}`
  const byKey = new Map<string, any>((manifest.collections || []).map((c: any) => [keyOf(c), { slug: c.slug ?? manifest.slug ?? slug, ...c }]))
  for (const e of exported) byKey.set(`${slug}/${e.collection}`, { slug, ...e, refused: false })
  for (const r of refused) byKey.set(`${slug}/${r.collection}`, { slug, collection: r.collection, refused: true, reason: r.reason })

  // `slug` used to be "whichever ran last". `slugs` is every data slug this export touched.
  const slugs = new Set<string>([...(manifest.slugs ?? []), ...(manifest.slug ? [manifest.slug] : []), slug])
  delete manifest.slug
  manifest.slugs = [...slugs].sort()
  manifest.generated_at = new Date().toISOString()
  manifest.collections = [...byKey.values()]

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
}

/**
 * The page payload is embedded in a data-page='...' ATTRIBUTE, so its JSON arrives HTML-entity
 * encoded: {&quot;requireOtp&quot;:true}. Every pattern below matches the decoded text, because a
 * regex written for literal quotes silently matches nothing — and "no gate found" on a gated page
 * exports a login form that passes every other check.
 */
const decode = (html: string): string =>
  html.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&")

/**
 * Every (slug, collection) pair referenced in the page payload.
 *
 * The DATA slug is not the PAGE slug: /p/catodrive-fleet binds to
 * /api/v1/app-data/catodrive-dashboard/fleet. Note this finds only endpoints the payload names —
 * components that default their endpoint in code are invisible here, which is why discovery also
 * watches what the browser actually requests.
 */
export function boundCollections(html: string): { slug: string; collection: string }[] {
  const re = /\/api\/v1\/app-data\/([\w-]+)\/([\w-]+)/g
  const out = new Map<string, { slug: string; collection: string }>()
  for (const m of decode(html).matchAll(re)) out.set(`${m[1]}/${m[2]}`, { slug: m[1], collection: m[2] })
  return [...out.values()]
}

/**
 * True when what we exported is an auth GATE rather than the dashboard behind it.
 *
 * T1 exports what an anonymous visitor receives. For a gated page that is the login form — 182
 * chars of "we'll email you a 6-digit code" — faithful, useless, and easy to mistake for a
 * working export.
 */
export function isGatedPage(html: string): boolean {
  return /"(?:requires_auth|requireOtp)":\s*true/.test(decode(html))
}

/**
 * Data paths are OFF LIMITS to the asset harvester.
 *
 * Harvest mirrors any same-origin 404 it sees. Without this it would pull
 * /api/v1/app-data/<slug>/phi-cases onto a client's box, past ADR-02 and ADR-03, because harvest
 * does not know what a collection is. Data goes through exportCollections or it does not go.
 */
export function isAppDataPath(p: string): boolean {
  try {
    const pathname = p.startsWith("http") ? new URL(p).pathname : p
    return pathname.startsWith("/api/v1/app-data/")
  } catch {
    return false
  }
}

/**
 * Find the collections a page binds to, export the safe ones, say what was refused and why.
 *
 * (Ported from export-data-cli.mjs. Log lines keep their original leading spaces; the caller
 * decides where they go.)
 */
export async function exportPageData(
  site: string,
  opts: { slug: string; origin: string; allowPhi?: boolean },
): Promise<{ gated: boolean; exported: any[]; refused: RefusedCollection[]; log: string[] }> {
  const { origin, allowPhi = false } = opts
  const log: string[] = []
  const exported: any[] = []
  const refused: RefusedCollection[] = []

  const html = fs.readFileSync(path.join(site, "index.html"), "utf8")

  if (isGatedPage(html)) {
    // What an anonymous visitor receives from a gated page is the LOGIN FORM. Serving that from a
    // client's box gives them a gate that cannot authenticate anyone, because the session it posts
    // to lives on fl-api. Gated pages are tier 4 — ADR-01, #185860.
    log.push("  data: page is AUTH-GATED — what was exported is the gate, not the dashboard")
    log.push("        not shippable to an edge box yet (#185860 tier 4); the OTP session lives on fl-api")
    return { gated: true, exported, refused, log }
  }

  // Static scrape first, then ask the browser — components that default their endpoint in code are
  // invisible to the scrape, and that is the common case for dashboards.
  const found = new Map<string, { slug: string; collection: string }>()
  for (const b of boundCollections(html)) found.set(`${b.slug}/${b.collection}`, b)
  try {
    const lines = await discoverCollections(site)
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
      const [slug, collection] = line.split("/")
      if (slug && collection) found.set(line, { slug, collection })
    }
  } catch (e: any) {
    log.push(`  data: discovery failed (${String(e?.message).slice(0, 60)}) — scrape only`)
  }

  if (found.size === 0) {
    log.push("  data: no bound collections — static page, nothing to export")
    return { gated: false, exported, refused, log }
  }

  let ok = 0
  let no = 0
  for (const { slug, collection } of found.values()) {
    const res = await exportCollections({ origin, slug, site, collections: [collection], allowPhi })
    for (const e of res.exported) {
      ok++
      exported.push(e)
      log.push(`    ✓ ${slug}/${e.collection} (${e.bytes}b)`)
    }
    for (const r of res.refused) {
      no++
      refused.push(r)
      log.push(`    ✗ ${slug}/${r.collection} — ${r.reason}`)
    }
  }
  log.push(`  data: ${ok} collection(s) exported, ${no} refused`)
  return { gated: false, exported, refused, log }
}
