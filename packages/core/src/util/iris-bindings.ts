/**
 * Data for a page an agent draws inside the chat (epic #188930, ADR-01).
 *
 * ONE SHAPE, THE /p/ SHAPE. A bespoke heyiris.io/p/ page receives its data as
 *
 *     <script type="application/json" id="iris-bindings">{"ads": {"data": [...], "meta": {...}}}</script>
 *
 * and reads it through `window.iris.data` (iris-sdk: names / has / rows / meta). A chat artifact
 * gets exactly the same block and the same four calls, so a page written for one renders in the
 * other unchanged. A second, chat-only data API is the mistake this prevents: every page would
 * work in one place and render empty in the other, and "a page with no data" looks like a page
 * whose dataset is empty — nobody would notice.
 *
 * DATA IS FROZEN IN, NEVER FETCHED (ADR-02). The chat frame runs with `connect-src 'none'`; the
 * block below is the only data it ever sees, and it is whatever the tool chose to put there.
 * `iris.data.fetch` exists so a /p/ page that calls it fails loudly instead of hanging.
 *
 * Pure — no I/O — so the tool that writes the artifact and the card that draws it share it.
 */

export type BindingSpec = {
  /** A tool call from earlier in this conversation — its result becomes the rows. */
  call_id?: string
  /** An Atlas dataset slug — its first page of records becomes the rows. */
  dataset?: string
  /** Optional dot path into the value before it is turned into rows ("results.items"). */
  path?: string
}

export type Binding = {
  data: unknown[]
  meta: { source: string; rows: number; total?: number | null; truncated?: boolean }
}

export type Bindings = Record<string, Binding>

/** A frame is not a database. Past this, the tool refuses rather than drawing a partial page. */
export const MAX_BINDINGS_BYTES = 1_000_000

/** Binding ids are what page code types: `iris.data.rows('ads')`. Keep them identifiers. */
export const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

const START = "<!--iris-bindings:start-->"
const END = "<!--iris-bindings:end-->"

/** Keys a tool result commonly wraps its list in. Checked in this order. */
const LIST_KEYS = ["data", "rows", "results", "items", "records", "list"]

function dig(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let v: unknown = value
  for (const key of path.split(".").filter(Boolean)) {
    if (v == null || typeof v !== "object") return undefined
    v = (v as Record<string, unknown>)[key]
  }
  return v
}

/**
 * Any value → the rows a page iterates. An array is the rows. An object that wraps an array
 * under a usual key ({data: [...]}, {results: [...]}) is that array — one level only, so a
 * paginated envelope works and a deeply nested shape asks for an explicit `path`. Any other
 * object is ONE row. A string that is JSON is parsed first; plain text is one row `{text}`.
 */
export function rowsFrom(value: unknown, path?: string): unknown[] {
  let v = value
  if (typeof v === "string") {
    const s = v.trim()
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        v = JSON.parse(s)
      } catch {
        // not JSON after all — stays text
      }
    }
  }
  v = dig(v, path)
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  if (typeof v === "object") {
    for (const k of LIST_KEYS) {
      const inner = (v as Record<string, unknown>)[k]
      if (Array.isArray(inner)) return inner
    }
    return [v]
  }
  return [{ text: String(v) }]
}

/**
 * The value a completed tool call produced. Its OUTPUT when that is JSON (what the model saw),
 * else its metadata when that carries anything, else the output as text. Metadata alone is not
 * preferred because most tools put display hints there (title, truncated), not the result.
 */
export function toolResultValue(state: { output?: string; metadata?: Record<string, unknown> }): unknown {
  const out = (state.output ?? "").trim()
  if (out.startsWith("{") || out.startsWith("[")) {
    try {
      return JSON.parse(out)
    } catch {
      // fall through
    }
  }
  const meta = state.metadata ?? {}
  const useful = Object.keys(meta).filter((k) => !["title", "truncated", "preview", "outputPath"].includes(k))
  if (useful.length) return meta
  return out
}

/** JSON that is safe inside a <script> element: `</script>` and `<!--` cannot close or open it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/**
 * The iris-sdk data calls, for a frame that cannot load the SDK (no network). Defined only when
 * the page has not already got an `iris.data`, so a page that ships its own wins.
 */
const SHIM =
  "(function(){var w=window;w.iris=w.iris||{};if(w.iris.data)return;var s=null;" +
  "function seeded(){if(s)return s;s={};try{var el=document.getElementById('iris-bindings');" +
  "if(el&&el.textContent)s=JSON.parse(el.textContent)||{}}catch(e){s={}}return s}" +
  "w.iris.data={names:function(){return Object.keys(seeded())}," +
  "has:function(n){return Object.prototype.hasOwnProperty.call(seeded(),n)}," +
  "rows:function(n){var b=seeded()[n];return(b&&Array.isArray(b.data))?b.data:[]}," +
  "meta:function(n){var b=seeded()[n];return(b&&b.meta)?b.meta:null}," +
  "fetch:function(){return Promise.reject(new Error('iris.data.fetch: this page is drawn in a chat frame with no network; its data is what the agent bound when it made it'))}," +
  "slug:function(){return null}}})()"

/** The block itself: the JSON, then the shim, between markers so it can be replaced on update. */
export function bindingsBlock(bindings: Bindings): string {
  return (
    START +
    `<script type="application/json" id="iris-bindings">${scriptJson(bindings)}</script>` +
    `<script>${SHIM}</script>` +
    END
  )
}

/** Remove a block a previous write put in — an update must not end up with two. */
export function stripBindings(html: string): string {
  const a = html.indexOf(START)
  if (a === -1) return html
  const b = html.indexOf(END, a)
  if (b === -1) return html
  return html.slice(0, a) + html.slice(b + END.length)
}

/**
 * Put the block at the top of <head>, before any page script runs (rows() is synchronous on
 * first paint). With no bindings the html comes back unchanged apart from removing an old
 * block. A document without a <head> gets one.
 */
export function injectBindings(html: string, bindings: Bindings | undefined): string {
  const clean = stripBindings(html)
  if (!bindings || !Object.keys(bindings).length) return clean
  const block = bindingsBlock(bindings)
  const head = clean.match(/<head(\s[^>]*)?>/i)
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length
    return clean.slice(0, at) + block + clean.slice(at)
  }
  const html_ = clean.match(/<html(\s[^>]*)?>/i)
  if (html_ && html_.index !== undefined) {
    const at = html_.index + html_[0].length
    return clean.slice(0, at) + `<head>${block}</head>` + clean.slice(at)
  }
  return `<head>${block}</head>` + clean
}

/** Size of the block as written — what the cap is checked against. */
export function bindingsBytes(bindings: Bindings): number {
  return new TextEncoder().encode(scriptJson(bindings)).length
}
