/**
 * Likely-duplicate detection for `iris bug report` (#189153).
 *
 * The same bug gets filed twice because nobody checks the board first — and both copies get
 * verified and paid (#178357: #177544 and #177555, the same report, $1 each). The fix is not a
 * rule people must remember; it is the command looking before it files.
 *
 * Pure: no network. The caller fetches candidates (the board's own title search), this decides
 * which of them are close enough to show. Showing is all it does — a person decides, and an
 * unattended caller still files, warned. A check that can block an automated bug report would
 * lose real bugs to a false match, which is a worse failure than a duplicate.
 */

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "does", "doesnt", "for", "from",
  "has", "have", "in", "is", "it", "its", "no", "not", "of", "on", "or", "so", "that", "the",
  "then", "this", "to", "was", "when", "with", "without", "iris", "bug", "error", "fails", "broken",
  "low", "medium", "high", "critical",
])

/** Lower-case word stems worth comparing — severity prefixes, ticket refs and stop words removed. */
export function titleTokens(title: string): string[] {
  const words = String(title ?? "")
    .toLowerCase()
    .replace(/^\s*\[(low|medium|high|critical)\]\s*/, "")
    .replace(/#\d+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    // a crude stem: "reports"/"reported" and "report" should meet
    .map((w) => w.replace(/(ing|ed|s)$/, ""))
    .filter((w) => w.length > 2)
  return [...new Set(words)]
}

/**
 * The words to search the board with: the longest distinctive tokens, because the board's search
 * matches a substring and the full title would only ever find itself.
 */
export function searchTerms(title: string, max = 2): string[] {
  return titleTokens(title)
    .sort((a, b) => b.length - a.length)
    .slice(0, max)
}

export type DuplicateCandidate = { id: number; title: string; status?: string; score: number }

/**
 * Overlap of the two titles' tokens, measured against the SHORTER title — so a terse new title
 * that is wholly contained in a long existing one still scores high.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a)
  const tb = new Set(titleTokens(b))
  if (ta.length === 0 || tb.size === 0) return 0
  const shared = ta.filter((t) => tb.has(t)).length
  return shared / Math.min(ta.length, tb.size)
}

/**
 * Candidates at or above the threshold, best first, at most `limit`. Closed items are kept —
 * a bug that was "fixed" and is being filed again is exactly what the reporter needs to see —
 * but an open match always outranks a closed one at the same score.
 */
export function likelyDuplicates(
  title: string,
  items: Array<{ id?: number | string; title?: string; status?: string }>,
  { threshold = 0.6, limit = 3, minShared = 2 }: { threshold?: number; limit?: number; minShared?: number } = {},
): DuplicateCandidate[] {
  const mine = titleTokens(title)
  const seen = new Set<number>()
  const out: DuplicateCandidate[] = []
  for (const it of items ?? []) {
    const id = Number(it?.id)
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    const other = String(it?.title ?? "")
    const shared = mine.filter((t) => titleTokens(other).includes(t)).length
    // One shared word is a coincidence on a board of thousands; demand two unless the new title
    // only HAS one distinctive word.
    if (shared < Math.min(minShared, mine.length)) continue
    const score = titleSimilarity(title, other)
    if (score >= threshold) out.push({ id, title: other, status: it?.status, score: Math.round(score * 100) / 100 })
  }
  const closed = (s?: string) => /^(done|closed|resolved|archived)$/i.test(String(s ?? ""))
  return out
    .sort((x, y) => y.score - x.score || Number(closed(x.status)) - Number(closed(y.status)) || y.id - x.id)
    .slice(0, limit)
}
