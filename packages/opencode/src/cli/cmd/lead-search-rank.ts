/**
 * `iris leads search` — the CLI half of #189943.
 *
 * The server decides WHICH rows match (the server agent is adding name-token + fuzzy matching).
 * The CLI decided, by accident, which of them you SEE: it asked for exactly `--limit` rows, so
 * the server's page order chose the cut, and a lead named "Darren Cummings" could lose its slot
 * to handles like "@darrenellis14". And a one-letter typo returned "No leads matching".
 *
 * Here: pass the query through intact, over-fetch, rank real name matches first, and when the
 * CRM says 0, try a typo-tolerant probe whose results are labelled as close matches — never as
 * exact ones.
 */

export function normalizeLeadQuery(q: unknown): string {
  return String(q ?? "").trim().replace(/\s+/g, " ")
}

/** Rows to ask the server for so ranking is ours, not the page order's. */
export function searchFetchSize(limit: number): number {
  const l = Math.max(1, Math.floor(Number(limit) || 10))
  return Math.min(200, Math.max(50, l * 5))
}

const tokens = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ]+/i)
    .filter(Boolean)

function nameOf(l: any): string {
  return [l?.name, l?.first_name, l?.last_name].filter(Boolean).join(" ")
}

function score(l: any, q: string): number {
  const ql = q.toLowerCase()
  const name = nameOf(l).toLowerCase().trim()
  const nameToks = tokens(nameOf(l))
  const qToks = tokens(q)
  const email = String(l?.email ?? "").toLowerCase()
  if (name && name === ql) return 100
  if (email && email === ql) return 95
  // A person named Darren outranks a social handle that happens to contain "darren".
  const personBonus = /^[^@#]\S*\s+\S/.test(String(l?.name ?? "").trim()) ? 5 : 0
  if (qToks.length && qToks.every((t) => nameToks.includes(t))) return 90 + personBonus
  if (qToks.length && qToks.every((t) => nameToks.some((n) => n.startsWith(t)))) return 70 + personBonus
  if (name.includes(ql)) return 50
  if (email.includes(ql) || String(l?.company ?? "").toLowerCase().includes(ql)) return 30
  return 10
}

/** Best match first; ties keep the server's order. */
export function rankLeads<T>(rows: T[], query: string): T[] {
  return rows
    .map((r, i) => ({ r, i, s: score(r, query) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
}

/** Damerau-Levenshtein (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[m][n]
}

const allowed = (len: number) => (len >= 8 ? 2 : len >= 5 ? 1 : 0)

/** Prefixes the server's substring search can answer, for the words long enough to fuzz. */
export function typoProbes(query: string): string[] {
  const out: string[] = []
  for (const t of tokens(query)) {
    if (allowed(t.length) === 0) continue
    const p = t.slice(0, Math.max(4, Math.ceil(t.length * 0.6)))
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/** Rows where EVERY query word is within the allowed edit distance of some name/email word. */
export function typoMatches<T>(rows: T[], query: string): T[] {
  const qToks = tokens(query)
  if (qToks.length === 0 || qToks.some((t) => allowed(t.length) === 0)) return []
  return rows.filter((r: any) => {
    const cands = [...tokens(nameOf(r)), ...tokens(String(r?.email ?? "").split("@")[0])]
    return qToks.every((t) => cands.some((c) => editDistance(t, c) <= allowed(Math.max(t.length, c.length))))
  })
}
