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
