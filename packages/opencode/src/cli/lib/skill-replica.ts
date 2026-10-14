// ============================================================================
// The identity of a generated skill replica — its ID and its description.
//
// A playbook becomes a skill by being copied to `.claude/skills/<id>/SKILL.md`, and every reader
// of that file is stricter than the playbook loader:
//
// - The IRIS Desktop app (OpenCode 1.18) keys a skill by its frontmatter `name` and drops a file
//   whose `name` is not a string. Claude Code keys it by the folder and accepts only lowercase
//   letters, digits and hyphens, at most 64 characters. A playbook named "Client Intake" or
//   "client_intake" is a valid playbook and an invalid skill in one reader or the other.
// - A skill with no description is not offered to the model at all (OpenCode leaves it out of
//   the list; Claude Code has nothing to match a task against). An EMPTY description is worse in
//   1.18: it is listed, as a blank entry the model can never choose on purpose.
//
// So the replica gets a portable ID (folder == frontmatter name) and a description that is never
// empty. Both are repaired rather than refused when the repair is unambiguous, and every repair
// is reported — a skill that silently changed name is its own kind of bug.
// ============================================================================

/** The portable skill ID shape both readers accept. */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_ID_MAX = 64
/** Claude Code truncates/refuses longer descriptions; OpenCode puts the whole thing in every prompt. */
export const SKILL_DESCRIPTION_MAX = 1024

export function isValidSkillId(id: string): boolean {
  return id.length >= 1 && id.length <= SKILL_ID_MAX && SKILL_ID_PATTERN.test(id)
}

/** "Client Intake_v2" → "client-intake-v2". Empty when nothing usable is left. */
export function toSkillId(name: string): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_ID_MAX)
    .replace(/-+$/g, "")
}

/** The first prose paragraph of a markdown body — skipping headings, fences, quotes, tables, lists. */
export function firstParagraph(body: string): string {
  const lines = String(body ?? "").split(/\r?\n/)
  let inFence = false
  const para: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      if (para.length) break
      continue
    }
    if (inFence) continue
    if (!line) {
      if (para.length) break
      continue
    }
    if (/^(#|>|\||[-*+]\s|\d+\.\s|<!--|---$)/.test(line)) {
      if (para.length) break
      continue
    }
    para.push(line)
  }
  return para.join(" ").replace(/\s+/g, " ").trim()
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "") + "…"
}

export interface ReplicaIdentity {
  /** Folder name AND frontmatter `name`. Null when no valid ID can be made — do not write. */
  id: string | null
  description: string
  /** One line per repair made, for the caller to print. Empty when the playbook was already fine. */
  repairs: string[]
}

/**
 * The ID and description a replica of `name` is written with. Never returns an empty description;
 * returns `id: null` only when the name has no letters or digits at all.
 */
export function replicaIdentity(input: { name: string; description: unknown; body?: string }): ReplicaIdentity {
  const repairs: string[] = []
  const name = String(input.name ?? "").trim()
  let id: string | null = name
  if (!isValidSkillId(name)) {
    const fixed = toSkillId(name)
    if (fixed && isValidSkillId(fixed)) {
      id = fixed
      repairs.push(`skill id "${name}" is not portable (lowercase letters, digits, hyphens, ≤${SKILL_ID_MAX}) — written as "${fixed}"`)
    } else {
      id = null
      repairs.push(`skill id "${name}" has no usable characters — no skill written`)
    }
  }

  let description = typeof input.description === "string" ? input.description : input.description == null ? "" : String(input.description)
  description = description.replace(/\s+/g, " ").trim()
  if (!description) {
    const para = firstParagraph(input.body ?? "")
    description = para ? clip(para, 300) : `The ${name || id} playbook. Run it with: iris playbook run ${name || id}`
    repairs.push(`no description — the model is never offered a skill without one; used ${para ? "the first paragraph" : "a generic line"} instead (add description: to the playbook)`)
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    description = clip(description, SKILL_DESCRIPTION_MAX)
    repairs.push(`description is longer than ${SKILL_DESCRIPTION_MAX} characters — clipped in the skill`)
  }
  return { id, description, repairs }
}

/** The line every install/sync prints so nobody waits on a session that cannot see the new skill (#189424). */
export function sessionRefreshNote(names: string[]): string {
  const what = names.length === 1 ? `"${names[0]}"` : "newly installed playbooks"
  // Measured on IRIS app 1.18.117: skills are scanned once per open project and never again, so a
  // NEW session in the same window does not help either — only a restart does.
  return `An IRIS app window that is already open will not offer ${what} as a skill until the app is restarted.`
}
