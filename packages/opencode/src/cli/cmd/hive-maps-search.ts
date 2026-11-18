/**
 * The Google-Maps scrape that `iris leads discover` and `iris venues search --web` dispatch to a
 * Hive node — the script it runs there, and how its output is read back.
 *
 * WHY THIS IS ITS OWN MODULE (#191700). The script lived inline in a TypeScript template literal,
 * and its node -e reader wrote `"...output\n"`. In a template literal `\n` is a real newline, so
 * the node program reached the machine with an unterminated string and died with
 * `SyntaxError: Invalid or unexpected token` — on EVERY node, before reading a single venue. Its
 * stdout was empty, the CLI's JSON fallback turned that into `[]`, the bash script still exited 0,
 * and `leads discover` printed "found 0 business(es)". Measured 2026-10-29 (task 01a18599-6fd on
 * iris-hive-002, "coffee shops in Austin TX"). Every agent-browser step also sent its errors to
 * /dev/null, so a node with no usable browser looked exactly like a city with no coffee shops.
 *
 * Now: the script names a missing dependency itself, ends with ONE `HIVE_SEARCH_RESULT=` line,
 * and the reader here refuses to turn anything it cannot account for into an empty list. Zero is
 * only ever returned with the reason the provider gave it (`explainEmpty`).
 */

export const RESULT_MARKER = "HIVE_SEARCH_RESULT="

export type HiveSearchResult = {
  ok: boolean
  feed?: number
  rows?: any[]
  title?: string | null
  url?: string | null
  error?: string
  dependency?: string
  detail?: string
  install?: string
}

export class HiveSearchError extends Error {
  constructor(message: string, readonly kind: "missing_dependency" | "no_result" | "blocked" | "stale_selectors" | "browser_failed") {
    super(message)
  }
}

/**
 * The node -e program that reads `agent-browser eval --json` from stdin and prints the result
 * line. Written WITHOUT backslash escapes on purpose — it is spliced into a template literal and
 * a bash single-quoted string, and an escape is exactly what broke it last time. Exported so the
 * test runs it with node, which is the only check that would have caught that.
 */
export const EVAL_READER = `
let s = "";
const emit = (o) => console.log("${RESULT_MARKER}" + JSON.stringify(o));
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let r = null;
  try { r = JSON.parse(s); } catch (e) {
    emit({ ok: false, error: "eval_unparseable", dependency: "agent-browser", detail: s.slice(-400) });
    return;
  }
  if (!r || r.success === false) {
    emit({ ok: false, error: "browser_failed", dependency: "agent-browser", detail: String((r && r.error) || "eval returned nothing").slice(0, 600), install: "npx --yes agent-browser install" });
    return;
  }
  const d = (r.data && r.data.result) || {};
  emit({ ok: true, feed: d.feed || 0, rows: d.rows || [], title: d.title || null, url: d.url || null });
});
`

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The bash script a Hive node runs (sandbox_execute). */
export function buildHiveSearchScript(query: string, limit: number): string {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`
  const n = Math.max(1, Math.floor(Number(limit) || 10))
  return `#!/bin/bash
set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.iris/runtime/bin:$PATH"
# A dependency that is missing is NAMED, never turned into an empty result.
dep () { printf '%s{"ok":false,"error":"missing_dependency","dependency":"%s","install":"%s"}\\n' "${RESULT_MARKER}" "$1" "$2"; exit 3; }
command -v node >/dev/null 2>&1 || dep node "install Node.js 20+ on this node (iris daemon update ships one)"
command -v npx >/dev/null 2>&1 || dep npx "install Node.js 20+ on this node (npx ships with it)"
AB="npx --yes agent-browser"

# The agent-browser daemon PERSISTS the browser between invocations, so a stale
# session plus a blind sleep will happily scrape the PREVIOUS query's feed and
# return confident, well-formed, wrong venues. Start clean, then wait on the
# thing we are about to read rather than on a timer.
$AB close --all >/dev/null 2>&1 || true
if ! OPEN_OUT="$($AB open ${shq(url)} 2>&1)"; then
  node -e 'console.log(process.argv[1] + JSON.stringify({ ok: false, error: "browser_failed", dependency: "agent-browser", detail: process.argv[2].slice(-600), install: "npx --yes agent-browser install" }))' "${RESULT_MARKER}" "$OPEN_OUT"
  exit 3
fi
$AB wait --load networkidle >/dev/null 2>&1 || true
$AB wait "[role=feed] a[href*='/maps/place/']" >/dev/null 2>&1 || true

$AB eval --stdin --json <<'VENUE_EVAL_EOF' | node -e '${EVAL_READER}'
(() => {
  const feed = document.querySelectorAll('[role=feed] > div').length;
  const rows = [];
  for (const el of document.querySelectorAll('[role=feed] > div')) {
    const a = el.querySelector('a[href*="/maps/place/"]');
    if (!a) continue;
    const lines = el.innerText.split('\\n').map(x => x.trim()).filter(Boolean);
    const name = a.getAttribute('aria-label') || lines[0];
    if (!name) continue;
    const meta = lines.find(x => x.includes('·')) || '';
    const parts = meta.split('·').map(x => x.trim()).filter(Boolean);
    rows.push({
      name,
      rating: lines.find(x => /^[0-9](\\.[0-9])?$/.test(x)) || null,
      type: parts[0] || null,
      address: parts.length > 1 ? parts[parts.length - 1] : null,
      source_url: a.href,
      source: 'google-maps',
    });
    if (rows.length >= ${n}) break;
  }
  return { feed, rows, title: document.title, url: location.href };
})()
VENUE_EVAL_EOF

$AB close --all >/dev/null 2>&1 || true`
}

/**
 * The text a finished sandbox_execute task printed. The task API returns it as `result` — an
 * OBJECT, `{ output, metadata, duration_ms }` — not a string; the old reader JSON.stringified that
 * object, parsed it back, saw "not an array" and returned [] — so even a scrape that WORKED read as
 * zero businesses (measured 2026-10-29, iris-hive-002). Strings are taken as they are.
 */
export function taskOutputText(t: any): string {
  const pick = (v: any): string => {
    if (v == null) return ""
    if (typeof v === "string") return v
    if (typeof v === "object") {
      const parts = [v.output, v.stdout, v.stderr].filter((x) => typeof x === "string" && x)
      if (parts.length) return parts.join("\n")
    }
    return JSON.stringify(v)
  }
  return pick(t?.output) || pick(t?.result) || ""
}

/**
 * Read a finished task's output. Returns the parsed result, or THROWS with the reason — there is
 * no path from "could not tell" to an empty array.
 */
export function parseHiveSearchOutput(output: unknown, ctx: { node: string; query: string }): HiveSearchResult & { rows: any[] } {
  const text = typeof output === "string" ? output : output == null ? "" : JSON.stringify(output)
  const line = text
    .split("\n")
    .map((l) => l.replace(/^\[stdout\]\s*/, "").trim())
    .filter((l) => l.startsWith(RESULT_MARKER))
    .pop()
  if (!line) {
    const tail = text.trim().split("\n").slice(-4).join(" | ").slice(-400)
    throw new HiveSearchError(
      `Hive node ${ctx.node} ran the Google Maps scrape but it reported no result — the node's script crashed or is out of date, so 0 would be a guess. ` +
        `Node output: ${tail || "(empty)"}`,
      "no_result",
    )
  }
  let r: HiveSearchResult
  try {
    r = JSON.parse(line.slice(RESULT_MARKER.length))
  } catch {
    throw new HiveSearchError(`Hive node ${ctx.node} returned an unreadable result line: ${line.slice(0, 200)}`, "no_result")
  }
  if (!r.ok) {
    if (r.error === "missing_dependency")
      throw new HiveSearchError(`Hive node ${ctx.node} is missing ${r.dependency}, which the Google Maps scrape needs. Install: ${r.install}`, "missing_dependency")
    throw new HiveSearchError(
      `Hive node ${ctx.node} could not drive a browser (${r.dependency ?? "agent-browser"}): ${(r.detail ?? r.error ?? "").trim().slice(0, 400)}` +
        ` — install its browser with: iris hive run ${ctx.node} '${r.install ?? "npx --yes agent-browser install"}'`,
      "browser_failed",
    )
  }
  const rows = Array.isArray(r.rows) ? r.rows : []
  const feed = Number(r.feed ?? 0)
  if (feed > 0 && rows.length === 0)
    throw new HiveSearchError(
      `Google Maps rendered ${feed} result(s) for "${ctx.query}" on node ${ctx.node} but the extractor matched none — the page's selectors changed. This is a scraper bug, not an empty market.`,
      "stale_selectors",
    )
  if (rows.length === 0 && /consent\.google|\/sorry\/|unusual traffic/i.test(`${r.url ?? ""} ${r.title ?? ""}`))
    throw new HiveSearchError(`Google served a consent/robot-check page to node ${ctx.node} (${r.url}) instead of results for "${ctx.query}".`, "blocked")
  return { ...r, rows, feed }
}

/** Why there are zero results — always a sentence, never a bare 0. */
export function explainEmpty(r: { feed?: number; title?: string | null; url?: string | null }, ctx: { node: string; query: string }): string {
  return `No results from Google Maps (via Hive node ${ctx.node}) for "${ctx.query}" — the page loaded (${r.title || r.url || "untitled"}) and listed ${r.feed ?? 0} place(s). Try a broader niche or location.`
}

/**
 * What `iris leads discover` asks a provider for. `dispatch` is the provider (the Hive scrape in
 * production, a fake in tests). Returns the businesses AND, when there are none, the sentence that
 * says why — a caller has nothing to print a bare 0 with. A provider error propagates.
 */
export async function discoverBusinesses(
  dispatch: () => Promise<{ rows: any[]; feed?: number; title?: string | null; url?: string | null }>,
  ctx: { node: string; query: string; limit: number },
): Promise<{ businesses: any[]; empty_reason: string | null }> {
  const r = await dispatch()
  const businesses = (Array.isArray(r?.rows) ? r.rows : []).slice(0, ctx.limit)
  return { businesses, empty_reason: businesses.length ? null : explainEmpty(r ?? {}, ctx) }
}
