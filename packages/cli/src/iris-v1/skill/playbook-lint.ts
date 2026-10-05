/**
 * Defects that pass `iris playbook test` and misbehave anyway.
 *
 * The schema validator answers "does this parse and match the schema". None of the rules
 * below are schema questions, and all four shipped to the public marketplace on 2026-09-04
 * having validated clean.
 *
 * Lives in src/ rather than script/ ON PURPOSE: the publish command needs it at runtime, and
 * `bun build --compile` bundles static imports, not files read from disk. A dev script would
 * simply be absent from the installed binary — the check would silently never run, which is
 * the failure mode this module exists to prevent.
 */

export type PlaybookRule = "AI_WRITES_FILE" | "READ_UNWRITTEN" | "TENANT_DEFAULT" | "AI_NO_PROMPT"

export interface PlaybookFinding {
  rule: PlaybookRule
  detail: string
  stepId?: string
}

export const PLAYBOOK_RULES: Record<PlaybookRule, string> = {
  AI_WRITES_FILE: "a `mode: ai` step is told to write a file — an AI step returns text and cannot write one",
  READ_UNWRITTEN: "a shell step reads a path no step here writes — it will read whatever a previous run left",
  TENANT_DEFAULT: "an id-shaped default on an installable playbook — a default here is a default for every tenant",
  AI_NO_PROMPT: "a `mode: ai` step whose prompt is empty — it would send nothing",
}

interface ParsedStep {
  id: string
  mode: string
  body: string
  code: string
  section: string
}

function parse(md: string): ParsedStep[] {
  const out: ParsedStep[] = []
  const heads = [...md.matchAll(/^### step:([\w-]+) +(.+)$/gm)]
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index! + heads[i][0].length
    const end = i + 1 < heads.length ? heads[i + 1].index! : md.length
    const section = md.slice(start, end)
    const yaml = section.match(/```yaml\n([\s\S]*?)```/)
    const mode = (yaml?.[1].match(/^mode:\s*(\S+)/m) || [])[1] || "manual"
    const fences = [...section.matchAll(/```(\w*)\n([\s\S]*?)```/g)].filter((f) => f[1] !== "yaml")
    out.push({
      id: heads[i][1],
      mode,
      body: section.replace(/```[\s\S]*?```/g, "").trim(),
      code: fences.map((f) => f[2]).join("\n"),
      section,
    })
  }
  return out
}

/** Lint one playbook's markdown. Pure — no fs, no network, so it is cheap enough to run on every publish. */
export function lintPlaybook(markdown: string): PlaybookFinding[] {
  const findings: PlaybookFinding[] = []
  const steps = parse(markdown)

  // Tenant-shaped arg defaults, from the frontmatter block.
  //
  // The terminator is `(?![\s\S])`, not `\Z`. JavaScript has no `\Z` — it matches a literal
  // "Z" — so the first version of this silently skipped the LAST declared arg unless a stray
  // capital Z happened to follow it. It passed on the real file by luck (the description of a
  // later arg contained one) and returned nothing on a minimal fixture. Found by the unit
  // test below, not by any of the corpus scans, which had been quietly under-reporting.
  const front = markdown.split(/^---$/m)[1] || ""
  for (const a of front.matchAll(/^ {2}([a-z_]+):\s*$([\s\S]*?)(?=^ {2}[a-z_]+:\s*$|(?![\s\S]))/gm)) {
    const [, arg, blk] = a
    const def = (blk.match(/^ {4}default:\s*(\S+)\s*$/m) || [])[1]
    if (def && /^\d{2,}$/.test(def) && /(bloq|list|agent|user|project|board|item)/i.test(arg))
      findings.push({ rule: "TENANT_DEFAULT", detail: `arg "${arg}" defaults to ${def}` })
  }

  // Which /tmp paths does this playbook actually write?
  const writes = new Set<string>()
  for (const s of steps)
    for (const w of s.section.matchAll(/(?:>|>>|tee(?:\s+-a)?|cat\s*>)\s*(\/tmp\/[\w.\-/]+)/g)) writes.add(w[1])

  const seen = new Set<string>()
  for (const s of steps) {
    if (s.mode === "ai" || s.mode === "prompt") {
      if (!(s.body.trim() ? s.body : s.code).trim())
        findings.push({ rule: "AI_NO_PROMPT", detail: `step "${s.id}" would send nothing`, stepId: s.id })
      const w = s.section.match(/[Ww]rite (?:it|them|the \w+) to (\/tmp\/[\w.\-/]+)/)
      if (w) findings.push({ rule: "AI_WRITES_FILE", detail: `step "${s.id}" is told to write ${w[1]}`, stepId: s.id })
    }
    if (s.mode === "shell")
      for (const r of s.section.matchAll(/(?:\[ -s |cat )(\/tmp\/[\w.\-/]+)/g)) {
        const key = `${s.id}:${r[1]}`
        if (!writes.has(r[1]) && !seen.has(key)) {
          seen.add(key)
          findings.push({ rule: "READ_UNWRITTEN", detail: `step "${s.id}" reads ${r[1]}`, stepId: s.id })
        }
      }
  }
  return findings
}

/**
 * Which findings BLOCK a publish at this scope.
 *
 * A tenant default only matters once other people can install the thing; on a private
 * playbook named after one tenant, hardcoding that tenant is correct. Everything else is a
 * defect at any scope — a stale draft is stale whoever reads it.
 */
export function blockingFindings(findings: PlaybookFinding[], scope: string): PlaybookFinding[] {
  const installableByOthers = scope === "public" || scope === "unlisted" || scope === "project"
  return findings.filter((f) => (f.rule === "TENANT_DEFAULT" ? installableByOthers : true))
}
