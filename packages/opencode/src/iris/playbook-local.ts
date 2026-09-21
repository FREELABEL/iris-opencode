import { existsSync, statSync } from "fs"
import { homedir } from "os"
import path from "path"
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
