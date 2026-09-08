/**
 * Reading a page out of a SERVER RENDER — the middle tier of `iris pages verify` (#183716).
 *
 * WHY A MIDDLE TIER EXISTS AT ALL.
 *
 * `verify` renders in a local browser. The person who most needs it does not have one: a
 * managed Windows machine, and the last install we pushed threw Abort/Retry/Ignore at her
 * mid-call (#183651). #183704 gave her a fallback that reads the page's STORED JSON, which
 * answers "are my words on the page" and is blind to everything the page fetches — measured
 * on pathways-dashboard, NEITHER of the two numbers that contradicted each other (a stat row
 * reading 1,182 above a board reading 16) appears anywhere in that JSON. Both are fetched.
 * So the honest fallback would have called that page healthy.
 *
 * The server can already render the whole thing. `PreviewRenderController` (GLD-04) hands a
 * page document to the SAME renderer `/p/` uses — brand tokens, cloudfile resolution, the
 * shared nav, the atlas gate, the bespoke `render_mode=html` branch, and crucially
 * `SsrDatasetInjector`, which resolves every dataset/collection binding server-side and
 * writes the ROWS into the payload. Reading that payload sees the data the stored JSON
 * cannot. No browser, no install.
 *
 * WHAT IT STILL CANNOT SEE, AND WHY THAT IS SAID OUT LOUD EVERYWHERE THIS IS USED.
 *
 * The payload is what the renderer HANDS the browser, not what the browser paints. A number
 * a component COMPUTES from its rows (a stat tile summing a board) is not in it — the rows
 * are, the sum is not. So a miss here is weaker evidence than a miss in a real render, and
 * `bindingHealth()` exists to say precisely how much weaker: with every binding resolved,
 * absence from the payload is a real absence from the page's inputs; with bindings still
 * unresolved, it is "not determined".
 *
 * Pure and dependency-free so it is testable without a server — see page-render-read.test.ts.
 */

export type PayloadLane = "composable" | "bespoke"

/**
 * How much of the page's data actually arrived in the render.
 *
 * `SsrDatasetInjector` REWRITES a resolved `type: 'dataset'` source into `type: 'static'` with
 * its rows in `staticData`, and writes `props.data` onto a resolved component binding. So the
 * shape of the payload is itself the record of what resolved — there is nothing to trust and
 * nothing to ask twice.
 *
 * `type: 'api'` sources never resolve here by design: the browser fetches those. They count as
 * unresolved, because from this tier's point of view that is exactly what they are.
 */
export interface BindingHealth {
  dataSources: number
  sourcesResolved: number
  sourcesUnresolved: number
  boundComponents: number
  componentsResolved: number
  componentsUnresolved: number
  /** Rows present in the payload — the evidence this tier has that the stored-JSON tier does not. */
  rows: number
  /** Nothing left for the browser to fetch. A miss is then a real miss, not an unknown. */
  complete: boolean
}

export interface PayloadReading {
  lane: PayloadLane
  gated: boolean
  title: string
  text: string
  headings: string[]
  /** Empty on the composable lane: the payload carries components, not h-tags. */
  headingsAvailable: boolean
  words: number
  bytes: number
  components: number
  bindings: BindingHealth
}

const EMPTY_HEALTH: BindingHealth = {
  dataSources: 0,
  sourcesResolved: 0,
  sourcesUnresolved: 0,
  boundComponents: 0,
  componentsResolved: 0,
  componentsUnresolved: 0,
  rows: 0,
  complete: true,
}

/** The five entities Blade writes into the `data-page` attribute, undone in the safe order. */
function decodeAttr(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/**
 * The Inertia props a composable render hydrates from, or null on the bespoke lane.
 *
 * Null is an ANSWER, not a failure — `public-html.blade` serves a bespoke page with no
 * `data-page` attribute at all, and reading that absence as a crash is the mistake
 * `detectLane` was written to stop (a data-page regex raising AttributeError on a page
 * that had published perfectly).
 */
export function parseInertiaProps(html: string): any | null {
  const m = (html ?? "").match(/\sdata-page\s*=\s*"([^"]*)"/)
  if (!m) return null
  try {
    return (JSON.parse(decodeAttr(m[1])) as any)?.props ?? null
  } catch {
    return null
  }
}

/**
 * The named entities that actually turn up in authored page copy.
 *
 * NOT a full HTML5 table, and not a guess either: these are what a bespoke page written with
 * real typography contains. `&amp;` is decoded in the SAME pass as the rest rather than after
 * it, so `&amp;lt;` stays the literal text `&lt;` instead of becoming a `<`.
 */
const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", middot: "\u00b7", bull: "\u2022",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  laquo: "\u00ab", raquo: "\u00bb", times: "\u00d7", deg: "\u00b0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", euro: "\u20ac", pound: "\u00a3",
}

/**
 * Undo HTML entities — numeric (decimal AND hex) and the named ones above.
 *
 * NOT cosmetic. The browser tier reads `innerText` off a real DOM, where every entity is
 * already a character; leaving `&#x27;` in this tier's text would make
 * `--expect "Children's Hospital"` fail on a page that plainly says it — a confident wrong
 * statement about somebody's own work, from the tier built to stop making them. Measured on
 * /p/patsy-resume, which carries `&#x27;`, `&middot;` and `&mdash;`.
 *
 * An entity this does not know is left exactly as it was: a mangled character is worse than a
 * visible `&frac12;`, and a needle typed from the page will carry the same literal.
 */
export function decodeEntities(input: string): string {
  return (input ?? "").replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Elements that do NOT break a word, and therefore must not become a space.
 *
 * Replacing every tag with a space is the obvious implementation and it is wrong in the one
 * way that matters here: a display headline is line-broken with inline markup, so
 * `without the <em>salary line</em>.` came back as "without the salary line ." and
 * `--expect "salary line."` failed on a page that says exactly that. A browser's `innerText`
 * — which is what the tier ABOVE this one matches against — inserts nothing at an inline
 * boundary, so the two tiers have to agree here or they disagree about the same page.
 */
const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark",
  "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub", "sup", "time",
  "u", "var", "wbr", "font", "big", "tt", "ins", "del",
])

/** Strip markup to something comparable with what a reader sees. */
export function stripMarkup(html: string): string {
  return decodeEntities(
    (html ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_whole, tag: string) => (INLINE_TAGS.has(tag.toLowerCase()) ? "" : " "))
      // Comments, doctypes and anything else angle-bracketed that is not a tag.
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Every string anywhere in a value.
 *
 * Deliberately greedy, for the same reason the stored-JSON tier is: a missed prop is a false
 * NEGATIVE, and a false negative here reads as "your text is not on the page" — a confident
 * wrong statement about somebody's own work, which is the whole family of bug this sits in.
 */
export function collectStrings(v: any, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v)
  else if (typeof v === "number" || typeof v === "boolean") out.push(String(v))
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out)
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out)
  return out
}

function isBound(props: any): boolean {
  if (!props || typeof props !== "object") return false
  return (
    typeof props.datasetSlug === "string" ||
    typeof props.collection === "string" ||
    (props.collections && typeof props.collections === "object") ||
    (props.datasets && typeof props.datasets === "object")
  )
}

function boundResolved(props: any): boolean {
  if (!props || typeof props !== "object") return false
  if (Array.isArray(props.data)) return true
  return !!props.datasetsData && typeof props.datasetsData === "object"
}

function rowsOn(props: any): number {
  let n = Array.isArray(props?.data) ? props.data.length : 0
  const named = props?.datasetsData
  if (named && typeof named === "object") {
    for (const v of Object.values<any>(named)) if (Array.isArray(v?.data)) n += v.data.length
  }
  return n
}

/**
 * Walk components AND their slot children — nesting is where a binding most often hides, and
 * the injector recurses through slots for exactly that reason. Depth-capped at the renderer's
 * own MAX_SLOT_DEPTH: a page is data, and data can be cyclic.
 */
function walkComponents(list: any, visit: (props: any) => void, depth = 0): void {
  if (!Array.isArray(list) || depth > 8) return
  for (const c of list) {
    if (!c || typeof c !== "object") continue
    // Two shapes, both real: a top-level block is `{ type, props }`, a slot child is a FLAT
    // prop bag because the renderer does `v-bind="child"`. Reading only the first found no
    // nested bindings at all.
    const props = c.props && typeof c.props === "object" ? c.props : c
    visit(props)
    const slots = (props?.slots && typeof props.slots === "object" ? props.slots : null) ?? (c.slots && typeof c.slots === "object" ? c.slots : null)
    if (slots) for (const children of Object.values<any>(slots)) walkComponents(children, visit, depth + 1)
  }
}

/**
 * What arrived and what did not.
 *
 * This is the number that decides whether a failed `--expect` is a FAILURE or an UNKNOWN, so
 * it is read off the payload's own shape rather than inferred from the page's intentions.
 */
export function bindingHealth(content: any): BindingHealth {
  if (!content || typeof content !== "object") return { ...EMPTY_HEALTH }

  const sources = Array.isArray(content.dataSources) ? content.dataSources : Array.isArray(content.data_sources) ? content.data_sources : []
  let sourcesResolved = 0
  let rows = 0
  for (const s of sources) {
    // A resolved source IS a static source carrying its rows — that rewrite is the injector's
    // record of success, so nothing here has to guess.
    if (s && typeof s === "object" && s.type === "static" && Array.isArray(s.staticData)) {
      sourcesResolved++
      rows += s.staticData.length
    }
  }

  let boundComponents = 0
  let componentsResolved = 0
  walkComponents(content.components, (props) => {
    if (!isBound(props)) return
    boundComponents++
    if (boundResolved(props)) {
      componentsResolved++
      rows += rowsOn(props)
    }
  })

  const sourcesUnresolved = sources.length - sourcesResolved
  const componentsUnresolved = boundComponents - componentsResolved
  return {
    dataSources: sources.length,
    sourcesResolved,
    sourcesUnresolved,
    boundComponents,
    componentsResolved,
    componentsUnresolved,
    rows,
    complete: sourcesUnresolved === 0 && componentsUnresolved === 0,
  }
}

/** h1/h2/h3 out of real markup. Only the bespoke lane has any. */
export function headingsFromHtml(html: string): string[] {
  const out: string[] = []
  const re = /<h[123]\b[^>]*>([\s\S]*?)<\/h[123]>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html ?? "")) !== null) {
    const t = stripMarkup(m[1])
    if (t) out.push(t)
  }
  return out
}

function bodyOf(html: string): string {
  const m = (html ?? "").match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return m ? m[1] : (html ?? "")
}

function titleOf(html: string): string {
  const m = (html ?? "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return m ? stripMarkup(m[1]) : ""
}

/**
 * Turn one server-rendered document into a reading.
 *
 * COMPOSABLE: the text is every string in the RESOLVED content tree — components plus the
 * rewritten data sources, which is where the injected rows live. That is the whole point of
 * this tier over the stored-JSON one.
 *
 * BESPOKE: `public-html.blade` returned the author's finished document; the browser adds
 * nothing to its text layer, so stripping the markup gives what a reader gets.
 */
export function readServerRender(html: string): PayloadReading {
  const src = html ?? ""
  const props = parseInertiaProps(src)

  if (!props) {
    const body = bodyOf(src)
    const text = stripMarkup(body)
    return {
      lane: "bespoke",
      // Same copy heuristic `detectGated` falls back to — a bespoke page has no payload to ask.
      gated: /Instant access\s*—\s*no code, no password/i.test(src),
      title: titleOf(src),
      text,
      headings: headingsFromHtml(body),
      headingsAvailable: true,
      words: text.split(/\s+/).filter(Boolean).length,
      bytes: src.length,
      components: 0,
      bindings: { ...EMPTY_HEALTH },
    }
  }

  const content = props.content ?? {}
  const gated = props.gateRequired === true
  const text = stripMarkup(collectStrings(content.components ?? []).concat(collectStrings(content.dataSources ?? content.data_sources ?? [])).join(" "))

  return {
    lane: "composable",
    gated,
    title: props.page?.title ?? props.meta?.title ?? titleOf(src) ?? "",
    text,
    // The payload holds components, not h-tags. Guessing which prop is a heading would be a
    // different measurement wearing the same name, so this tier declines the question.
    headings: [],
    headingsAvailable: false,
    words: text.split(/\s+/).filter(Boolean).length,
    bytes: src.length,
    components: Array.isArray(content.components) ? content.components.length : 0,
    bindings: bindingHealth(content),
  }
}
