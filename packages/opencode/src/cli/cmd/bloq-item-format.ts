// Shared, pure formatting helpers for rendering bloq items in the CLI.
// Extracted so `bloqs get --items` and list previews render identically and
// never leak "[object Object]" when an item's `content` is a structured object
// (e.g. fleet vehicles, form submissions, datasets).

/** Best-effort human title for a bloq item, checking title → content.title → string content. */
export function itemTitle(item: any): string {
  const contentObj = item && typeof item.content === "object" && item.content ? item.content : null
  const rawContent = item && typeof item.content === "string" ? item.content : ""
  return (
    (typeof item?.title === "string" && item.title) ||
    (contentObj && typeof contentObj.title === "string" && contentObj.title ? contentObj.title : "") ||
    (rawContent ? rawContent.replace(/[#\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "") ||
    "(untitled)"
  )
}

/**
 * Tokenized, order-independent search match. Splits the query into whitespace
 * tokens and requires EVERY token to appear somewhere in the haystack (AND),
 * case-insensitively. A raw substring `.includes()` treats the query as one
 * contiguous string, so a natural name like "Mayo Life Atlas" can never match a
 * stored "MAYO — Life Atlas" (the em-dash breaks the run). ANDing the tokens
 * fixes that and gives word-order independence for free.
 * Empty/whitespace query matches everything (same as no filter).
 *
 * Both sides are Unicode-normalized to NFC so that visually identical names
 * stored decomposed (e.g. "café" as e + combining accent) still match a query
 * typed composed. It does NOT accent-fold — "cafe" won't match "café"; that
 * typo tolerance belongs to the Typesense-backed search (#162213).
 */
export function matchesSearchQuery(haystack: string, query: string): boolean {
  const norm = (s: string) => String(s ?? "").normalize("NFC").toLowerCase()
  const hay = norm(haystack)
  const tokens = norm(query).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((t) => hay.includes(t))
}

/**
 * Normalize a user-supplied due date to a `YYYY-MM-DD` string the API stores as
 * a date, or return null if it isn't a real calendar date. Accepts `YYYY-MM-DD`
 * and full ISO timestamps (the date part is kept). Rejects nonsense like
 * "2026-13-40" or "tomorrow" so the CLI can give a clear error instead of
 * silently sending garbage the DB coerces to null.
 */
export function normalizeDueDate(input: string): string | null {
  const raw = String(input ?? "").trim()
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/)
  if (!m) return null
  const [, y, mo, d] = m
  const year = Number(y), month = Number(mo), day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // Round-trip through UTC to reject impossible days (e.g. Feb 30, Apr 31).
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null
  return `${y}-${mo}-${d}`
}

/** A short, readable one-line preview of an item's content — never "[object Object]". */
export function itemContentPreview(item: any, max = 120): string {
  const c = item?.content
  if (c == null) return ""
  if (typeof c === "string") return c.replace(/\n/g, " ").slice(0, max)
  if (typeof c === "object") {
    const obj = c as Record<string, unknown>
    // Prefer a descriptive field if one exists.
    for (const key of ["description", "summary", "text", "body"]) {
      const v = obj[key]
      if (typeof v === "string" && v.trim()) return v.replace(/\n/g, " ").slice(0, max)
    }
    // Otherwise build a compact key=value preview from scalar fields.
    const pairs = Object.entries(obj)
      .filter(([, v]) => v != null && typeof v !== "object")
      .slice(0, 4)
      .map(([k, v]) => `${k}=${String(v)}`)
    return pairs.join("  ").slice(0, max)
  }
  return String(c).slice(0, max)
}
