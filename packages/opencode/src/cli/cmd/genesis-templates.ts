// Genesis starter templates — the catalogue (#188411, epic #188359).
//
// The catalogue is the public dataset `genesis-templates`, served by the gallery page
// /p/genesis-templates. The CLI reads the GALLERY PAGE, not the dataset API: the records endpoint
// is owner-scoped, so another account asking for "the templates" would read its own datasets. The
// published page is public and already carries the rows it renders (the first-paint bindings
// script), so one source feeds both the gallery a person browses and `iris genesis template list`.

export const TEMPLATE_GALLERY_SLUG = "genesis-templates"
export const TEMPLATE_BINDING = "templates"

export type TemplateRow = {
  slug: string
  name: string
  archetype?: string
  description?: string
  brief?: string
  audit_score?: number | string
  order?: number | string
  preview_url?: string
  /** Names the template's own sample copy contains — shown after a clone as "rewrite these". */
  source_names?: string
}

/** Pull the rows out of a published bespoke page's <script id="iris-bindings"> block. */
export function parseTemplateCatalogue(html: string, binding = TEMPLATE_BINDING): TemplateRow[] {
  const m = html.match(/<script[^>]*id="iris-bindings"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return []
  let data: any
  try {
    data = JSON.parse(m[1])
  } catch {
    return []
  }
  const rows: any[] = data?.[binding]?.data ?? []
  return rows
    .map((r) => (r && typeof r === "object" && r.data && typeof r.data === "object" ? r.data : r))
    .filter((r) => r && typeof r.slug === "string" && r.slug)
    .map((r) => r as TemplateRow)
    .sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99))
}

/** A template may be named by its slug or by its short name ("measured" for genesis-template-measured). */
export function findTemplate(rows: TemplateRow[], wanted: string): TemplateRow | undefined {
  const w = wanted.trim().toLowerCase()
  return (
    rows.find((r) => r.slug.toLowerCase() === w) ??
    rows.find((r) => r.slug.toLowerCase() === `genesis-template-${w}`) ??
    rows.find((r) => (r.name ?? "").toLowerCase() === w)
  )
}

/** The subject brief is stored one question per line. */
export function briefQuestions(row: TemplateRow): string[] {
  return String(row.brief ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter(Boolean)
}
