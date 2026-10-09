import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import path from "path"
import { filterRows } from "./pagination"
import { installState, playbookAction, type PlaybookAction } from "./playbook-install"

/**
 * Where a playbook is installed on this machine, if anywhere — for the session's project, not
 * only for the account's home directory.
 *
 * `iris playbook sync` writes a project's playbooks to <project>/.iris/playbooks and its skills to
 * <project>/.claude/skills; that is where a session in that project reads them. Checking only
 * ~/.iris/playbooks made the Marketplace call 17 of the first 25 playbooks "not installed" on a
 * machine whose project had them (#186277).
 *
 * Order is the order a session resolves them in: the project's copy first, because that is the
 * one this session runs; the synced skill next; the home install last.
 */
export type LocalWhere = "project" | "skill" | "home"

export interface LocalRoots {
  /** Defaults to the user's home directory. */
  home?: string
  /** The session's project directory, when there is one. */
  project?: string
}

const SLUG = /^[a-zA-Z0-9._-]+$/

export function findLocalPlaybook(
  name: string,
  roots: LocalRoots = {},
): { found: boolean; path: string; where: LocalWhere | null } {
  const home = roots.home ?? homedir()
  const homeFile = path.join(home, ".iris", "playbooks", SLUG.test(name) ? name : "_", "PLAYBOOK.md")
  // The name lands in a filesystem path: a slug, nothing else ("..", "/" never get this far).
  if (!SLUG.test(name) || name === "." || name === "..") return { found: false, path: homeFile, where: null }
  const candidates: [LocalWhere, string][] = []
  if (roots.project) {
    candidates.push(["project", path.join(roots.project, ".iris", "playbooks", name, "PLAYBOOK.md")])
    candidates.push(["skill", path.join(roots.project, ".claude", "skills", name, "SKILL.md")])
  }
  candidates.push(["home", homeFile])
  for (const [where, file] of candidates) if (existsSync(file)) return { found: true, path: file, where }
  return { found: false, path: homeFile, where: null }
}

/**
 * A project directory sent by a client, or undefined. Only an absolute path to an existing
 * directory counts: this value lands in filesystem paths, and a relative one would resolve
 * against the server's own working directory — "installed" by accident.
 */
export function projectRoot(dir: unknown): string | undefined {
  if (typeof dir !== "string" || !dir || !path.isAbsolute(dir)) return undefined
  try {
    return statSync(dir).isDirectory() ? path.resolve(dir) : undefined
  } catch {
    return undefined
  }
}

/** Set `hasLocal` (and `localWhere`) on a page of playbook rows by the rule above. */
export function markLocal<T extends { name: string; hasLocal: boolean; version?: number }>(
  rows: T[],
  roots: LocalRoots = {},
): (T & { localWhere?: LocalWhere; installedVersion?: number; edited?: boolean; action: PlaybookAction })[] {
  return rows.map((r) => {
    const hit = findLocalPlaybook(r.name, roots)
    // A synced skill (SKILL.md) is not a Marketplace install; only a PLAYBOOK.md can carry a record.
    const st = hit.found && hit.where !== "skill" ? installState(hit.path) : { installedVersion: undefined, edited: false }
    return {
      ...r,
      hasLocal: hit.found,
      localWhere: hit.where ?? undefined,
      installedVersion: st.installedVersion,
      edited: st.edited || undefined,
      action: playbookAction({ hasLocal: hit.found, installedVersion: st.installedVersion, version: r.version }),
    }
  })
}

/**
 * Where a row in the All view comes from (#all-tab). More than one is normal — a playbook you own,
 * published, and installed carries three — and the panel shows every one, because "why is this
 * here" is the question a union list raises and a single tag answers it wrong for most rows.
 *
 * - project:     attached to this board, filed against it, or on disk in this session's project
 * - installed:   in ~/.iris/playbooks on this machine
 * - account:     owned by the signed-in account on the platform
 * - marketplace: published (public or unlisted) — a TAG only, never a reason to be listed
 */
export type PlaybookSource = "project" | "installed" | "account" | "marketplace"

/** The fields of a platform row the All view reads. */
export interface AllViewRow {
  name: string
  description?: string
  attached: boolean
  steps: { title: string }[]
  args: unknown[]
  hasLocal: boolean
  owned: boolean
  bloqId?: number
  scope?: string
}

const docName = (dir: string, file: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => SLUG.test(n) && n !== "." && n !== ".." && existsSync(path.join(dir, n, file)))
  } catch {
    return []
  }
}

/** The `description:` line of a document's frontmatter, if it has one. */
function frontmatterDescription(file: string): string | undefined {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf-8"))
    const d = m && /^description:\s*(.+)$/m.exec(m[1])
    const v = d?.[1].trim().replace(/^(["'])(.*)\1$/, "$2")
    return v || undefined
  } catch {
    return undefined
  }
}

/**
 * Every playbook this person can run: the union of this project's, the ones installed on this
 * machine, and the ones their account owns — one row per NAME, with every source reported.
 *
 * NOT the public catalogue. `/api/v1/playbooks` returns public + own, so the platform list holds
 * every published playbook on the platform; listing those here would make All the Marketplace
 * with a few extras, and the question All answers is "what do I have", not "what could I get".
 * A catalogue playbook appears here once it is installed or attached to this board — and then
 * carries a `marketplace` tag so its origin is still visible.
 *
 * Playbooks that exist only on disk (written locally, never published) are included too: the
 * platform cannot list them and they are exactly the ones a person forgets they have. A synced
 * skill in <project>/.claude/skills counts only when a platform playbook carries its name —
 * that directory also holds ordinary Claude skills, which are not playbooks.
 */
export function allPlaybooks<T extends AllViewRow>(
  platform: T[],
  opts: { bloqId: number; roots?: LocalRoots },
): (T & { sources: PlaybookSource[] })[] {
  const roots = opts.roots ?? {}
  const home = roots.home ?? homedir()
  const homeDir = path.join(home, ".iris", "playbooks")
  const projDir = roots.project ? path.join(roots.project, ".iris", "playbooks") : undefined
  const skillDir = roots.project ? path.join(roots.project, ".claude", "skills") : undefined

  const inHome = new Set(docName(homeDir, "PLAYBOOK.md"))
  const inProject = new Set(projDir ? docName(projDir, "PLAYBOOK.md") : [])
  const inSkills = new Set(skillDir ? docName(skillDir, "SKILL.md") : [])

  const byName = new Map<string, T & { sources: PlaybookSource[] }>()
  const add = (row: T, sources: PlaybookSource[]) => {
    const prev = byName.get(row.name)
    if (!prev) {
      byName.set(row.name, { ...row, sources })
      return
    }
    // Same name twice: keep the first row (the platform's own order puts the board's copy
    // first), and widen its sources — dedupe must never lose where something came from.
    for (const s of sources) if (!prev.sources.includes(s)) prev.sources.push(s)
  }

  for (const p of platform) {
    const sources: PlaybookSource[] = []
    if (p.attached || (p.bloqId != null && p.bloqId === opts.bloqId) || inProject.has(p.name) || inSkills.has(p.name))
      sources.push("project")
    if (inHome.has(p.name)) sources.push("installed")
    if (p.owned) sources.push("account")
    // Listed only for one of the reasons above; marketplace alone is the Marketplace tab's job.
    if (!sources.length) continue
    if ((p.scope === "public" || p.scope === "unlisted") && p.bloqId == null) sources.push("marketplace")
    add(p, sources)
  }

  // On disk and nowhere on the platform. Yours by construction — the file is on your machine —
  // so `owned`, or the panel would file it under "Owned by another account".
  const local = (name: string, file: string, sources: PlaybookSource[]) =>
    add(
      {
        name,
        description: frontmatterDescription(file),
        attached: false,
        steps: [],
        args: [],
        hasLocal: true,
        owned: true,
      } as unknown as T,
      sources,
    )
  const known = new Set(platform.map((p) => p.name))
  for (const n of inProject) if (!known.has(n)) local(n, path.join(projDir!, n, "PLAYBOOK.md"), ["project"])
  for (const n of inHome) if (!known.has(n)) local(n, path.join(homeDir, n, "PLAYBOOK.md"), ["installed"])

  return [...byName.values()].sort(byOwnerThenBoard)
}

/**
 * YOURS FIRST, then everyone else's; within each, this board's first; then by name. The panel
 * draws the "Owned by another account" heading where this order flips, so every list it renders
 * must be sorted by it.
 */
export function byOwnerThenBoard(a: { owned: boolean; attached: boolean; name: string }, b: typeof a): number {
  if (a.owned !== b.owned) return a.owned ? -1 : 1
  if (a.attached !== b.attached) return a.attached ? -1 : 1
  return a.name.localeCompare(b.name)
}

/**
 * The rows the playbooks route pages over, for one view and one search — the route's whole list
 * step, kept here so it is tested as the route runs it rather than as a copy.
 *
 * ALL is asked for by name. A client that sends no view keeps the old "everything the platform
 * returned" answer; the panel's All tab gets the union above.
 */
export function playbookRows<T extends AllViewRow>(
  platform: T[],
  opts: { view?: string; bloqId: number; q?: string; roots?: LocalRoots },
): (T & { sources?: PlaybookSource[] })[] {
  const listed: (T & { sources?: PlaybookSource[] })[] =
    opts.view === "all" ? allPlaybooks(platform, { bloqId: opts.bloqId, roots: opts.roots }) : platform
  // Description as well as name: playbooks are FOUND by what they do, and the name is a slug.
  // "restaurant-booking-cancel" is not how anyone looks for it.
  return filterRows(listed, opts.q, (p) => [p.name, p.description, p.scope, ...p.steps.map((s) => s.title)])
}
