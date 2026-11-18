/**
 * `iris pages components <slug> --json` (#191847) — the component inventory as data.
 *
 * Same envelope as `iris pages list --json` / `pages search --json` ({ data, meta } from
 * buildListEnvelope), plus the page it was read from:
 *
 *   {
 *     page: { id, slug, title, status },
 *     data: [{ index, path, id, type, preview }],
 *     meta: { returned, total, truncated: false }
 *   }
 *
 * `path` is the dot path `iris pages get|set <slug> <path>` takes, so a script can go from the
 * inventory straight to one component without counting. `preview` is the same title/text/content
 * line the human listing prints (untruncated), or null. Failures are handleApiError's JSON:
 * { success: false, error, ... } on stdout, exit 1.
 */

import { buildListEnvelope, type ListEnvelope } from "./list-envelope"
import { firstArray } from "../../util/array"

export interface PageComponentRow {
  index: number
  path: string
  id: string | null
  type: string | null
  preview: string | null
}

export interface PageComponentsJson extends ListEnvelope<PageComponentRow> {
  page: { id: number | string | null; slug: string; title: string | null; status: string | null }
}

export function componentPreview(c: any): string | null {
  const p = c?.props?.title ?? c?.props?.text ?? c?.props?.content
  return p === undefined || p === null || p === "" ? null : String(p)
}

export function buildPageComponentsJson(page: any, slug: string): PageComponentsJson {
  const components: any[] = firstArray(page?.json_content?.components)
  const rows = components.map((c, index) => ({
    index,
    path: `components.${index}`,
    id: c?.id != null ? String(c.id) : null,
    type: c?.type != null ? String(c.type) : null,
    preview: componentPreview(c),
  }))
  // A page's components arrive whole, so the total is known and nothing is withheld.
  const env = buildListEnvelope(rows, { total: rows.length })
  return {
    page: { id: page?.id ?? null, slug: String(page?.slug ?? slug), title: page?.title ?? null, status: page?.status ?? null },
    ...env,
  }
}
