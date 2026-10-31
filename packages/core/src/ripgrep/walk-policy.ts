import os from "os"
import path from "path"

/**
 * Where a filesystem walk may go (#191073, #191071).
 *
 * Every Glob/Grep/find walk runs through Ripgrep.run, so this is the one place that decides
 * how far a walk reaches. Before it, the only stop was a result count: a pattern that matched
 * little or nothing (`**\/.git` can never match a repository — `.git` is a directory and
 * `--files` lists files) walked the entire disk from `/`, ran for 9+ minutes, and on macOS
 * entered ~/Library/Containers, where every other app's container raised its own
 * "IRIS would like to access data from other apps" prompt — thousands of them.
 *
 * Two rules:
 *  1. REFUSE a walk rooted at the whole disk or above the home folder. Nothing an agent wants
 *     is found by walking `/`, and the walk is what does the damage.
 *  2. PRUNE privacy-protected folders the walk would only pass through. A pruned directory is
 *     never opened, so macOS has nothing to prompt about. A walk that STARTS inside one of
 *     them (the user asked for it) is not pruned.
 */

export interface WalkEnv {
  readonly home: string
  readonly platform: NodeJS.Platform
}

export interface WalkScope {
  /** Set when the walk must not run. The message is written for the model to act on. */
  readonly refuse?: string
  /** ripgrep `--glob=!…` arguments that prune protected folders below cwd. */
  readonly excludes: readonly string[]
}

/** Folders inside the home directory that macOS guards per app (TCC) or that are not files at all. */
const MAC_PROTECTED_UNDER_HOME = [
  "Library",
  ".Trash",
]

/**
 * The same, matched anywhere below cwd — for a walk that starts above them without being the
 * home folder (another user's home, a copied home, a home inside a mounted volume) or that
 * starts inside ~/Library itself.
 */
const MAC_PROTECTED_ANYWHERE = [
  "**/Library/Containers",
  "**/Library/Group Containers",
  "**/Library/Mail",
  "**/Library/Messages",
  "**/Library/Safari",
  "**/Library/Calendars",
  "**/Library/Cookies",
  "**/Library/HomeKit",
  "**/Library/IdentityServices",
  "**/Library/Biome",
  "**/Library/Suggestions",
  "**/Library/Mobile Documents",
  "**/Library/CloudStorage",
  "**/Library/Metadata/CoreSpotlight",
  "**/Library/Application Support/AddressBook",
  "**/Library/Application Support/CallHistoryDB",
  "**/Library/Application Support/com.apple.TCC",
  "**/*.photoslibrary",
  "**/.Trash",
]

/** Never a sensible place to start a walk, even though they are not the filesystem root. */
const SYSTEM_ROOTS = ["/Volumes", "/System", "/private", "/mnt", "/media"]
/** Not files: walking into them is endless or meaningless. */
const PSEUDO_FS = ["/proc", "/sys", "/dev"]

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

const refusal = (cwd: string, why: string) =>
  `Refusing to search ${cwd}: ${why}. Search a project directory instead ` +
  `(pass a path such as your repository or ~/Documents/<folder>). ` +
  `To find git repositories, glob for **/.git/HEAD under a parent folder you know holds them.`

export function scope(cwd: string, env: WalkEnv = { home: os.homedir(), platform: process.platform }): WalkScope {
  const dir = path.resolve(cwd)
  const home = path.resolve(env.home)

  if (path.parse(dir).root === dir) return { refuse: refusal(dir, "that is the root of the disk"), excludes: [] }
  if (dir !== home && inside(home, dir)) {
    return { refuse: refusal(dir, "it holds every user's home folder"), excludes: [] }
  }
  if (env.platform !== "win32") {
    if (SYSTEM_ROOTS.includes(dir)) return { refuse: refusal(dir, "that is a system or mount root"), excludes: [] }
    if (PSEUDO_FS.some((p) => inside(dir, p))) {
      return { refuse: refusal(dir, "it is not a real directory of files"), excludes: [] }
    }
  }

  if (env.platform !== "darwin") return { excludes: [] }

  const excludes: string[] = []
  // Anchored ("/x" is relative to cwd in ripgrep globs) so only THIS home's folders are pruned.
  for (const name of MAC_PROTECTED_UNDER_HOME) {
    const abs = path.join(home, name)
    if (abs !== dir && inside(abs, dir)) excludes.push(`--glob=!/${path.relative(dir, abs).split(path.sep).join("/")}`)
  }
  // Starting inside ~/Library: prune its protected children by their path relative to cwd.
  for (const pattern of MAC_PROTECTED_ANYWHERE) {
    if (!pattern.startsWith("**/Library/")) continue
    const abs = path.join(home, pattern.slice(3))
    if (abs !== dir && inside(abs, dir) && !inside(home, dir)) {
      excludes.push(`--glob=!/${path.relative(dir, abs).split(path.sep).join("/")}`)
    }
  }
  for (const pattern of MAC_PROTECTED_ANYWHERE) excludes.push(`--glob=!${pattern}`)
  return { excludes: [...new Set(excludes)] }
}

/**
 * Place the excludes where they win. ripgrep resolves overlapping --glob rules by ORDER: the
 * LAST matching glob decides. Put first, a later `--glob=**\/*` (or `**`) re-includes
 * Library/Containers and the walk opens it anyway — found on the Mac, 2026-10-27; Linux never
 * sees it because nothing is pruned there. So they go after every other flag: before `--` when
 * there is one (grep), otherwise before the final path argument.
 */
export function withExcludes(args: readonly string[], excludes: readonly string[]): string[] {
  if (excludes.length === 0) return [...args]
  const dashdash = args.indexOf("--")
  const at = dashdash >= 0 ? dashdash : args.length - 1
  return [...args.slice(0, at), ...excludes, ...args.slice(at)]
}
