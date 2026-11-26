/**
 * What a playbook needs installed before it can run.
 *
 * Two sources, merged:
 *   1. `requires:` in the frontmatter — the author's explicit list (a YAML list, or a
 *      comma-separated string). Use it for kits a step shells into, e.g. a render kit.
 *   2. Every `mode: playbook` step's `playbook:` target — a child it runs inline. Before this,
 *      a parent whose child was not installed failed mid-run with `Skill "<child>" not found`,
 *      and nothing told the person which install would have prevented it.
 *
 * Pure: takes the markdown, returns names. Install-time code decides what is missing.
 */
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i

function frontmatter(md: string): string {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1] : ""
}

function requiresFrom(fm: string): string[] {
  // requires: a, b        |  requires: [a, b]  |  requires:\n  - a\n  - b
  const inline = fm.match(/^requires:[ \t]*(.+)$/m)
  if (inline && inline[1].trim() && !inline[1].trim().startsWith("#")) {
    return inline[1].replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
  }
  const block = fm.match(/^requires:[ \t]*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m)
  if (!block) return []
  return block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]+-[ \t]*/, "").trim().replace(/^["']|["']$/g, ""))
}

function childPlaybooks(md: string): string[] {
  const out: string[] = []
  // Each step's ```yaml block: only blocks whose mode is playbook name a child.
  for (const m of md.matchAll(/```ya?ml\r?\n([\s\S]*?)```/g)) {
    const y = m[1]
    if (!/^mode:[ \t]*playbook[ \t]*$/m.test(y)) continue
    const p = y.match(/^(?:playbook|skill):[ \t]*["']?([^"'\s#]+)/m)
    if (p) out.push(p[1])
  }
  return out
}

export function playbookDependencies(md: string, self?: string): string[] {
  const seen = new Set<string>()
  for (const n of [...requiresFrom(frontmatter(md)), ...childPlaybooks(md)]) {
    if (!n || !NAME.test(n) || n === self) continue
    seen.add(n)
  }
  return [...seen]
}
