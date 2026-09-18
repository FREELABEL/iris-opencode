/**
 * Put an export on a machine the client controls, and be able to take it back off.
 *
 * WHY THIS IS NOT `rsync -a site/ host:/srv/site/`. That is a deploy with no undo and a window in
 * which the site is half old and half new. Assets are content-hashed, so during the copy the
 * already-updated index.html asks for chunks that have not landed — the page renders blank for
 * exactly as long as the transfer takes, which on a 12MB export over a client's DSL is long enough
 * for them to see it. And when it goes wrong the only way back is to re-export the old page, which
 * nobody kept.
 *
 * So: upload to a NEW directory, verify, then move one symlink. The swap is atomic, the previous
 * release is still sitting there, and rollback transfers nothing.
 *
 *     /srv/site/releases/20260917-192200/   ← the export
 *     /srv/site/releases/20260917-184455/   ← the one before
 *     /srv/site/current -> releases/20260917-192200
 *
 * Point the web server at `current`. It never sees a partial release.
 */
import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync, readFileSync } from "fs"
import { basename } from "path"

const run = promisify(execFile)

export interface Target {
  type?: "ssh" | "local"
  host?: string
  path: string
  keep?: number
  url?: string
  source?: string
  sshArgs?: string[]
}

export interface DeployConfig {
  targets: Record<string, Target>
}

export const EXAMPLE_CONFIG = `{
  "targets": {
    "production": {
      "type": "ssh",  "host": "deploy@their-host",  "path": "/srv/site",
      "keep": 5,      "url": "https://theirsite.com/"
    }
  }
}`

export function loadConfig(path: string): DeployConfig {
  if (!existsSync(path)) throw new Error(`no deploy config at ${path}`)
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Release ids and slugs are the ONLY values interpolated into a remote shell command. Both are
 * produced by us, but a slug comes from export.json on disk — validate it rather than trust it.
 */
const SAFE = /^[A-Za-z0-9._-]+$/
export function assertSafe(label: string, value: string) {
  if (!SAFE.test(value)) throw new Error(`refusing unsafe ${label} "${value}" — only [A-Za-z0-9._-] may reach a remote shell`)
}

export class Remote {
  readonly type: "ssh" | "local"
  readonly root: string
  readonly label: string
  readonly keep: number

  constructor(
    readonly target: Target,
    readonly dryRun = false,
    private readonly onDry?: (script: string) => void,
  ) {
    this.type = target.type ?? (target.host ? "ssh" : "local")
    if (this.type === "ssh" && !target.host) throw new Error('target is type ssh but has no "host"')
    this.root = target.path.replace(/\/+$/, "")
    if (!/^\/[A-Za-z0-9._/-]*$/.test(this.root)) {
      throw new Error(`target path "${target.path}" must be absolute and contain only [A-Za-z0-9._/-]`)
    }
    this.label = this.type === "ssh" ? `${target.host}:${this.root}` : this.root
    this.keep = Number.isInteger(target.keep) ? target.keep! : 5
  }

  /**
   * Run a shell command on the target. For ssh this goes through one `sh -c` on the far side, so
   * nothing interpolated here may carry shell syntax — the path, release ids and slug are all
   * validated against a strict character class before they get here.
   */
  async sh(script: string): Promise<string> {
    if (this.dryRun) {
      this.onDry?.(script)
      return ""
    }
    const { stdout } =
      this.type === "ssh"
        ? await run("ssh", [...(this.target.sshArgs ?? []), this.target.host!, script], { encoding: "utf8" })
        : await run("sh", ["-c", script], { encoding: "utf8" })
    return stdout
  }

  async releases(): Promise<string[]> {
    // `|| true` so an empty or absent releases dir is an empty list, not a crash. A first deploy
    // has no releases, and that is not an error condition.
    const out = await this.sh(`ls -1 ${this.root}/releases 2>/dev/null | sort || true`)
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async current(): Promise<string | null> {
    const out = await this.sh(`readlink ${this.root}/current 2>/dev/null || true`)
    return basename(out.trim()) || null
  }

  /**
   * Point `current` at a release — and then CHECK that it moved.
   *
   * Every obvious way to write this silently does nothing when `current` is already a symlink to a
   * directory, because both `ln` and `mv` FOLLOW it by default and operate inside the old release:
   *
   *     ln -sf releases/X current                   → creates old-release/X, exit 0
   *     ln -sfn releases/X tmp && mv -f tmp current  → creates old-release/tmp, exit 0
   *
   * The second is what this shipped with first. The deploy printed `✓ live: 20260918-002905` while
   * the site kept serving 002821, and only `ls -l` showed it. `-n` makes `ln` treat the existing
   * symlink as a file rather than a directory to descend into, which is the fix — but the assertion
   * below is the part that matters, because the failure mode here is a command that reports success.
   */
  async pointAt(release: string): Promise<void> {
    assertSafe("release", release)
    await this.sh(`ln -sfn releases/${release} ${this.root}/current`)
    if (this.dryRun) return
    const now = await this.current()
    if (now !== release) {
      throw new Error(
        `the swap did not take: ${this.root}/current still points at ${now ?? "nothing"}, not ${release}. ` +
          `The release IS uploaded. Nothing is broken — but nothing changed either.`,
      )
    }
  }

  async deployedSlug(): Promise<string> {
    return (await this.sh(`cat ${this.root}/.genesis-slug 2>/dev/null || true`)).trim()
  }

  async recordSlug(slug: string): Promise<void> {
    assertSafe("slug", slug)
    await this.sh(`printf %s ${slug} > ${this.root}/.genesis-slug`)
  }

  /**
   * Upload the CONTENTS of `site` into a release directory.
   *
   * The trailing slash on the source is load-bearing in rsync: with it the contents land in the
   * release directory; without it a directory named `site` is created inside it and every path on
   * the served site gains a /site prefix. Same command, two very different sites.
   */
  async upload(site: string, dest: string): Promise<void> {
    const args = ["-az", "--delete", `${site}/`]
    if (this.type === "ssh") {
      if (this.target.sshArgs?.length) args.push("-e", `ssh ${this.target.sshArgs.join(" ")}`)
      args.push(`${this.target.host}:${dest}/`)
    } else {
      args.push(`${dest}/`)
    }
    if (this.dryRun) {
      this.onDry?.(`rsync ${args.join(" ")}`)
      return
    }
    await run("rsync", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  }

  /**
   * Prune oldest-first, and NEVER the live one. Keeping fewer than two releases means the next
   * rollback has nowhere to go, which is the only reason any of this structure exists.
   */
  async prune(live: string): Promise<number> {
    if (this.keep <= 0 || this.dryRun) return 0
    const all = await this.releases()
    const stale = all.filter((r) => r !== live).slice(0, Math.max(0, all.length - this.keep))
    for (const r of stale) {
      assertSafe("release", r)
      await this.sh(`rm -rf ${this.root}/releases/${r}`)
    }
    return stale.length
  }
}

/** Per-second ids. Two deploys inside the same second would collide, which deploy() refuses. */
export const newReleaseId = (now = new Date()) =>
  now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")
