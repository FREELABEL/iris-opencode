/**
 * Brand links (epic #192663) — the words the CLI uses for them, pure so they are tested alone.
 *
 *   brands.bloq_id          the board that owns the brand (B2 #192665)
 *   brands.design_brand_id  the brand whose design kit this one reads (B3 #192666)
 *   pages.brand_id          the brand a page wears (B2 #192665)
 *
 * The server (fl-api) enforces who may set each and what it may point at; this only parses
 * arguments and says what a brand record means.
 */

/** "680" → 680; "none" / "null" / "0" / "" → null (clear the link); anything else → "invalid". */
export function parseLinkArg(raw: unknown): number | null | "invalid" {
  const s = String(raw ?? "").trim().toLowerCase()
  if (s === "" || s === "none" || s === "null" || s === "0") return null
  if (!/^\d+$/.test(s)) return "invalid"
  return Number(s)
}

type BrandRef = { id?: number; slug?: string; name?: string; status?: string; design_brand_id?: number | null }

const ref = (b: BrandRef | undefined | null, id?: number | null) =>
  b?.id ? `#${b.id} ${b.slug ?? b.name ?? ""}`.trim() : id ? `#${id}` : ""

/**
 * What `iris brands show` says about the pair: which kit this brand reads, and which brands read
 * this one's. Lines are [label, value] for printKV.
 */
export function pairLines(b: {
  design_brand_id?: number | null
  design_brand?: BrandRef | null
  posting_brands?: BrandRef[] | null
}): [string, string][] {
  const out: [string, string][] = []
  if (b.design_brand_id) {
    const inactive = b.design_brand && b.design_brand.status && b.design_brand.status !== "active"
    out.push([
      "Design kit",
      `${ref(b.design_brand, b.design_brand_id)} — tokens are read from there${inactive ? ` (it is ${b.design_brand!.status}: its own copy is served until it is active)` : ""}`,
    ])
  }
  const readers = (b.posting_brands ?? []).filter((p) => p?.id)
  if (readers.length) out.push(["Read by", readers.map((p) => ref(p)).join(", ") + " — they wear this kit"])
  return out
}

/** The line `iris pages view` prints for a page's stored brand. */
export function pageBrandLine(brandId: unknown, brand?: BrandRef | null): string {
  const id = Number(brandId)
  if (!Number.isFinite(id) || id <= 0) return "none stored"
  return brand?.id ? `${ref(brand)}${brand.name && brand.slug !== brand.name ? ` (${brand.name})` : ""}` : `#${id}`
}
