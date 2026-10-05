/**
 * Mirror a published Genesis page into a directory any static host can serve.
 *
 * The renderer stays where it is. This copies what the browser already receives: the HTML (which
 * carries the page JSON inline), the build assets it needs, and the images it references. No
 * renderer, no compiler and no component library on the client's box — the browser is the renderer.
 *
 * Five things this has to get right, each learned by watching it fail:
 *
 *   1. GATED PAGES. A page behind a sign-in exports as the sign-in FORM, faithfully and uselessly:
 *      the session it posts to lives on our servers, so what lands on their machine is a lock with
 *      no key. Refuse up front, before fetching 700 assets.
 *   2. ATOMICITY. Assets are content-hashed per build. If a deploy lands between fetching the HTML
 *      and fetching its assets you mirror a TORN snapshot: the HTML asks for chunks that no longer
 *      exist, and the page renders blank. The build entry is recorded and re-checked at the end.
 *   3. COMPLETENESS. The asset graph is NOT discoverable from the HTML — Vite lazy-loads chunks.
 *      The manifest is the graph. One missing 462-byte icon chunk blanked a whole page, and the
 *      console named a DIFFERENT file, so a partial mirror fails in a way that is hard to read.
 *   4. EMPTY ≠ MISSING. At least one asset is legitimately zero bytes upstream, so the completeness
 *      check tests existence, not size.
 *   5. REQUIRED ≠ OPTIONAL. Three site-chrome paths are guesses, not graph members. A missing
 *      favicon must never fail an export, or the checker that catches the blank page becomes the
 *      checker everyone learns to override.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { isGatedPage } from "./export-data"

export type ExportFailure =
  | { kind: "gated" }
  | { kind: "torn"; before: string; after: string }
  | { kind: "incomplete"; missing: string[] }

export interface ExportResult {
  ok: boolean
  failure?: ExportFailure
  site: string
  buildEntry: string
  required: number
  optional: number
  files: number
  bytes: number
  log: string[]
}

function countFiles(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files++
        bytes += statSync(p).size
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { files, bytes }
}

/**
 * The asset graph: the Vite manifest (the real graph, including lazy chunks) plus every absolute,
 * extension-bearing path the HTML names directly.
 *
 * Static files under public/ — /js/iris-sdk-*.js, favicons, the webmanifest — are referenced
 * straight from the HTML and appear in no manifest. Missing the SDK cost a 404 that surfaced only
 * as a console error.
 */
export function assetGraph(manifest: Record<string, any>, html: string): { required: string[]; optional: string[] } {
  const files = new Set<string>()
  for (const v of Object.values(manifest)) {
    if (v && typeof v === "object") {
      if (typeof v.file === "string") files.add(v.file)
      for (const k of ["css", "assets"] as const) {
        for (const f of (v as any)[k] ?? []) files.add(f)
      }
    }
  }
  const paths = new Set<string>([...files].map((f) => "/build/" + f))

  for (const m of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) {
    const p = m[1]!
    if (!p.startsWith("//") && /\.[A-Za-z0-9]{2,6}$/.test(p)) paths.add(p)
  }

  // Site chrome that most IRIS pages have and some do not. Guesses, not graph members.
  const optional = ["/favicon.svg", "/icons/apple-touch-icon.png", "/icons/site.webmanifest"].filter(
    (p) => !paths.has(p),
  )
  return { required: [...paths].sort(), optional }
}

/**
 * The build hash, or "" when the page has none. A hand-written CustomHtml page has no Vue entry,
 * and that is a real page, not an error — the shell version died silently on exactly this, twice,
 * because `$(… | grep …)` under `set -o pipefail` treats "no match" as a fatal exit.
 */
export const buildEntryOf = (html: string) => html.match(/app-[A-Za-z0-9_-]+\.js/)?.[0] ?? ""

async function fetchText(url: string, timeoutMs = 30000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/**
 * Fetch every asset, in bounded parallel.
 *
 * An earlier shell version used xargs + `sh -c` and broke on filenames containing dots, fetching 33
 * of 730 — a partial mirror that reported success and rendered blank. Doing it here means no
 * quoting layer to get wrong.
 */
async function mirror(origin: string, site: string, paths: string[], concurrency = 12) {
  const got: string[] = []
  const missed: string[] = []
  let i = 0
  const worker = async () => {
    while (i < paths.length) {
      const p = paths[i++]!
      try {
        const res = await fetch(origin + p, { signal: AbortSignal.timeout(60000) })
        // An HTTP error body must NEVER land on disk as a .js file — it parses as garbage and the
        // console blames a different file entirely.
        if (!res.ok) {
          missed.push(p)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        const dest = join(site, p)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, buf)
        got.push(p)
      } catch {
        missed.push(p)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker))
  return { got, missed }
}

export async function exportPage(slug: string, outDir: string, opts: { origin: string }): Promise<ExportResult> {
  const { origin } = opts
  const site = join(outDir, "site")
  const log: string[] = []
  const blank = { site, buildEntry: "", required: 0, optional: 0, files: 0, bytes: 0, log }

  mkdirSync(site, { recursive: true })
  log.push(`exporting ${origin}/p/${slug}`)

  const html = await fetchText(`${origin}/p/${slug}`)
  writeFileSync(join(site, "index.html"), html)

  // 1. GATED — refuse here, before any asset work.
  if (isGatedPage(html)) return { ok: false, failure: { kind: "gated" }, ...blank }

  const buildEntry = buildEntryOf(html)
  log.push(`build entry: ${buildEntry || "none (hand-written page)"}`)

  const manifest = JSON.parse(await fetchText(`${origin}/build/manifest.json`))
  const { required, optional } = assetGraph(manifest, html)
  log.push(`${required.length} assets (manifest graph + page references), ${optional.length} optional`)

  await mirror(origin, site, required)
  // Optional assets are fetched but never gate the export. An absent one is the honest state.
  await mirror(origin, site, optional)

  // 4. EMPTY ≠ MISSING — existence, not size. Only REQUIRED paths are checked.
  const missing = required.filter((p) => !existsSync(join(site, p)))

  // 2. ATOMICITY — re-read the live page and compare the build hash.
  const after = buildEntryOf(await fetchText(`${origin}/p/${slug}`))
  if (buildEntry !== after) {
    return { ok: false, failure: { kind: "torn", before: buildEntry, after }, ...blank, buildEntry }
  }
  if (missing.length) {
    return { ok: false, failure: { kind: "incomplete", missing }, ...blank, buildEntry }
  }

  const { files, bytes } = countFiles(site)
  return { ok: true, site, buildEntry, required: required.length, optional: optional.length, files, bytes, log }
}

/**
 * Provenance, written OUTSIDE site/ so it is never served.
 *
 * Where a folder came from is otherwise a fact that lives only in the shell history of whoever ran
 * the export — and it is the fact `deploy` needs, both to pick the right verification baseline and
 * to notice it is about to replace one client's page with another's on the same target.
 */
export interface Provenance {
  slug: string
  origin: string
  page_url: string
  build_entry: string
  exported_at: string
  files: number
}

export function writeProvenance(outDir: string, p: Provenance) {
  writeFileSync(join(outDir, "export.json"), JSON.stringify(p, null, 2) + "\n")
}

export function readProvenance(siteDir: string): Provenance | null {
  try {
    return JSON.parse(readFileSync(join(siteDir, "..", "export.json"), "utf8"))
  } catch {
    return null
  }
}

/** Remove a half-written export so a refused run never leaves something that looks shippable. */
export function discard(outDir: string) {
  rmSync(outDir, { recursive: true, force: true })
}
