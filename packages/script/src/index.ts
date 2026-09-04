import { createHash } from "node:crypto"
import { $ } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

if (process.versions.bun !== expectedBunVersion) {
  throw new Error(`This script requires bun@${expectedBunVersion}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
}
const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

/**
 * The server stores a CLI version in 32 characters (#183539).
 *
 * A preview version is `0.0.0-<channel>-<YYYYMMDDHHMM>` — 19 fixed characters, so the channel
 * segment has a 13-character budget. `main` spends 4 and nothing ever noticed. A branch does not:
 *
 *     0.0.0-fix/hive-sessions-cli-202609032004    40 chars -> `iris how-to publish` 422s
 *     0.0.0-main-202609032035                     23 chars -> works
 *
 * And the 422 names the FIELD, not the cause — nothing connects "version too long" to "you are
 * on a branch", so the obvious readings (bad recipe, bad token, server problem) are all wrong.
 * It also fails at the LAST step, after the how-to is written, committed and pushed: the work
 * looks done and the artefact never reaches the web.
 *
 * Bounded here rather than by renaming branches. Note this shortens the VERSION segment only —
 * CHANNEL itself is untouched, because it is used as an npm dist-tag by four publish scripts and
 * truncating it there would publish under the wrong tag.
 */
const VERSION_MAX = 32
const VERSION_STAMP_LEN = 12 // YYYYMMDDHHMM
const CHANNEL_BUDGET = VERSION_MAX - "0.0.0-".length - 1 - VERSION_STAMP_LEN // 13

export function versionChannelSegment(channel: string): string {
  const slug = channel.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (slug.length <= CHANNEL_BUDGET) return slug

  // Keep a readable head, and disambiguate with a hash of the FULL name — two long branches
  // sharing a prefix (`feature/pathways-scope-a`, `feature/pathways-scope-b`) must not collapse
  // to the same version, or two different builds become indistinguishable by their own report.
  const hash = createHash("sha1").update(channel).digest("hex").slice(0, 4)
  // Trim a trailing hyphen so a slug cut mid-separator does not read as `feature--b4c4`.
  return `${slug.slice(0, CHANNEL_BUDGET - 5).replace(/-+$/, "")}-${hash}`
}

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  if (IS_PREVIEW) {
    const v = `0.0.0-${versionChannelSegment(CHANNEL)}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
    // Fail HERE, at build, naming the cause — not later with a 422 that names a column. An
    // assertion that should be unreachable is still worth keeping: it is the difference between
    // a build that refuses and a publish that fails after the work is done.
    if (v.length > VERSION_MAX) {
      throw new Error(
        `Built version "${v}" is ${v.length} chars; the server accepts ${VERSION_MAX}. ` +
          `Branch "${CHANNEL}" did not fit its ${CHANNEL_BUDGET}-char budget.`,
      )
    }
    return v
  }
  // For IRIS Code, start at 1.0.0 if no version specified
  // Check GitHub releases for latest version
  const version = await fetch("https://api.github.com/repos/FREELABEL/iris-opencode/releases/latest")
    .then((res) => {
      if (!res.ok) return { tag_name: "v0.0.0" }
      return res.json()
    })
    .then((data: any) => data.tag_name?.replace(/^v/, "") || "0.0.0")
    .catch(() => "0.0.0")
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.OPENCODE_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
}
console.log(`iris-code script`, JSON.stringify(Script, null, 2))
