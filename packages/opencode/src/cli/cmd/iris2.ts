import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, bold, success } from "./iris-api"
import { spawnSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { isCliReleaseTag } from "../../installation/pick-release"

// ============================================================================
// iris iris2 — the opt-in preview of IRIS on the opencode v2 engine (#188596)
// ============================================================================
//
// iris2 ships BESIDE the stable `iris` until it is ready to take over. Updating is decided by
// two facts, never by a hard-coded name:
//
//   SLOT    — the file being replaced: `iris` or `iris2` (`.exe` on Windows). A binary only
//             ever replaces ITSELF (selfUpdate) — or, for `iris iris2 install`, the iris2 file.
//             A file with any other name is never written.
//   CHANNEL — which releases it follows. `preview` = `iris2-vX.Y.Z-<pre>` tags with `iris2-*`
//             assets; `stable` = `vX.Y.Z` tags with `iris-*` assets (the ones `iris update`
//             already uses). A build's own channel comes from its version: a prerelease version
//             (1.5.0-beta.3) is a preview build, a bare one (1.5.0) is stable.
//
// planUpdate() turns (slot, current version, requested channel, releases) into one decision.
// The scenarios it has to get right — each is a test in iris2.test.ts:
//
//   iris2 upgrade                         preview → newest preview, writes iris2
//   iris2 upgrade --channel stable        REFUSED: an iris2 file holding a v1 build helps nobody
//   iris upgrade  (preview build, canary) preview → newest preview, writes iris
//   iris upgrade --channel stable         rollback: newest stable, writes iris (version may go DOWN)
//   iris2 upgrade after the switch        the v2 engine is stable iris now → says so, installs nothing
//   iris upgrade  (preview build) after   follows it into stable automatically
//   anything named something else         REFUSED
//
// The stable v1 `iris upgrade` that every user has today does not run this code at all; it is
// unchanged. Guarantees: a download whose .sha256 does not match is never installed, and a new
// binary that cannot print its version is rolled back to the previous one.

const REPO = "FREELABEL/iris-opencode"
export const TAG_PREFIX = "iris2-v"
/** The first stable release on the v2 engine. Once it exists, the preview has graduated. */
export const SWITCH_VERSION = "1.5.0"

export type Release = { tag_name: string; draft?: boolean; prerelease?: boolean; published_at?: string | null }
export type Slot = "iris" | "iris2"
export type Channel = "stable" | "preview"

export function slotFile(slot: Slot, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${slot}.exe` : slot
}

export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return slotFile("iris2", platform)
}

/** Which slot a path is, or null if it is neither iris nor iris2. */
export function slotOf(file: string): Slot | null {
  const base = path.basename(file).toLowerCase().replace(/\.exe$/, "")
  return base === "iris" || base === "iris2" ? base : null
}

export function isIris2Path(target: string): boolean {
  return slotOf(target) === "iris2"
}

export function channelOfVersion(version: string): Channel {
  return version.includes("-") ? "preview" : "stable"
}

export function defaultInstallPath(home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  return path.join(home, ".iris", "bin", binaryName(platform))
}

/** The release asset for this machine, or null where we do not publish one. */
export function assetName(
  platform: string = process.platform,
  arch: string = process.arch,
  channel: Channel = "preview",
): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null
  if (!os || !cpu) return null
  if (os === "windows" && cpu === "arm64") return null
  return `${channel === "stable" ? "iris" : "iris2"}-${os}-${cpu}.${os === "linux" ? "tar.gz" : "zip"}`
}

/** "iris2-v1.5.0-beta.3" → "1.5.0-beta.3" (preview); "v1.3.319" → "1.3.319" (stable); else null. */
export function versionOfTag(tag: string, channel: Channel = "preview"): string | null {
  if (channel === "stable") return isCliReleaseTag(tag) ? tag.slice(1) : null
  if (!tag.startsWith(TAG_PREFIX)) return null
  const v = tag.slice(TAG_PREFIX.length)
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null
}

export function tagFor(version: string, channel: Channel): string {
  const v = version.replace(TAG_PREFIX, "").replace(/^v/, "")
  return channel === "stable" ? `v${v}` : `${TAG_PREFIX}${v}`
}

/** Semver order, prerelease-aware (1.5.0-beta.10 > 1.5.0-beta.9 < 1.5.0). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const core = v.split("-", 1)[0]!
    return { core: core.split(".").map(Number), pre: v.length > core.length ? v.slice(core.length + 1).split(".") : [] }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/**
 * Newest release of one channel. Preview: highest version. Stable: newest-first, the same rule
 * `iris update` uses (pick-release.ts) — a re-cut release wins by recency.
 */
export function pickLatest(releases: Release[], channel: Channel = "preview"): { tag: string; version: string } | null {
  let best: { tag: string; version: string } | null = null
  for (const r of releases) {
    if (r.draft) continue
    const version = versionOfTag(r.tag_name, channel)
    if (!version) continue
    if (channel === "stable") return { tag: r.tag_name, version }
    if (!best || compareVersions(version, best.version) > 0) best = { tag: r.tag_name, version }
  }
  return best
}

export type Plan =
  | { kind: "install"; channel: Channel; tag: string; version: string; note?: string }
  | { kind: "current"; channel: Channel; version: string }
  | { kind: "refuse"; message: string }

/** The whole update decision, with no I/O. See the scenario table at the top of this file. */
export function planUpdate(input: {
  slot: Slot | null
  current: string
  requested?: Channel
  pinned?: string
  force?: boolean
  releases: Release[]
}): Plan {
  const { slot, current } = input
  if (!slot) {
    return { kind: "refuse", message: "updates only replace a file named iris or iris2 — reinstall with `iris iris2 install`" }
  }
  const build = channelOfVersion(current)
  let channel: Channel = input.requested ?? (slot === "iris2" ? "preview" : build)
  if (slot === "iris2" && channel === "stable") {
    return {
      kind: "refuse",
      message: "iris2 only follows the preview. To go back to stable, keep using `iris` and run `iris iris2 remove`.",
    }
  }

  const stable = pickLatest(input.releases, "stable")
  const graduated = stable !== null && compareVersions(stable.version, SWITCH_VERSION) >= 0
  if (channel === "preview" && graduated && !input.pinned) {
    if (slot === "iris2") {
      return {
        kind: "refuse",
        message: `iris2 has graduated: the v2 engine is the stable iris ${stable!.version} now. Run \`iris upgrade\`, then \`iris iris2 remove\`.`,
      }
    }
    channel = "stable" // a preview build in the iris slot follows the engine into stable
  }

  if (input.pinned) {
    const version = input.pinned.replace(TAG_PREFIX, "").replace(/^v/, "")
    if (slot === "iris2" && channelOfVersion(version) === "stable" && !input.pinned.startsWith(TAG_PREFIX)) {
      return { kind: "refuse", message: `${input.pinned} is a stable version; iris2 only installs previews (e.g. 1.5.0-beta.1)` }
    }
    const pinnedChannel = input.requested ?? (slot === "iris2" ? "preview" : channelOfVersion(version))
    if (!input.force && compareVersions(current, version) === 0) return { kind: "current", channel: pinnedChannel, version }
    return { kind: "install", channel: pinnedChannel, tag: tagFor(version, pinnedChannel), version }
  }

  const latest = channel === "stable" ? stable : pickLatest(input.releases, "preview")
  if (!latest) return { kind: "refuse", message: `no ${channel === "stable" ? "stable" : "iris2 preview"} release has been published yet` }
  if (channel !== build) {
    // Changing channel: versions are not comparable in the useful direction (rolling back to
    // stable 1.3.x from 1.5.0-beta is a DOWNgrade on purpose), so install without comparing.
    return {
      kind: "install",
      channel,
      tag: latest.tag,
      version: latest.version,
      note: `switching ${slot} from the ${build} channel to ${channel} (${current} → ${latest.version})`,
    }
  }
  if (!input.force && compareVersions(current, latest.version) >= 0) return { kind: "current", channel, version: current }
  return { kind: "install", channel, tag: latest.tag, version: latest.version }
}

/** `sha256sum` output ("<hex>  file") or a bare hex digest. */
export function parseSha256(text: string): string | null {
  const m = text.trim().match(/^([a-fA-F0-9]{64})\b/)
  return m ? m[1].toLowerCase() : null
}

function ghHeaders(): Record<string, string> {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]
  return { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

export async function fetchReleases(): Promise<Release[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`)
  return (await res.json()) as Release[]
}

export async function fetchLatest(channel: Channel = "preview"): Promise<{ tag: string; version: string } | null> {
  return pickLatest(await fetchReleases(), channel)
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000), redirect: "follow" })
  if (!res.ok || !res.body) throw new Error(`download ${path.basename(url)}: HTTP ${res.status}`)
  // Stream to disk: `Bun.write(dest, response)` can hang if the Response is collected mid-download.
  const sink = Bun.file(dest).writer()
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    await sink.write(value)
  }
  await sink.end()
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function extract(archive: string, into: string): void {
  const r = archive.endsWith(".tar.gz")
    ? spawnSync("tar", ["-xzf", archive, "-C", into], { stdio: "pipe" })
    : process.platform === "win32"
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${into}'`],
          { stdio: "pipe" },
        )
      : spawnSync("unzip", ["-oq", archive, "-d", into], { stdio: "pipe" })
  if (r.status !== 0) throw new Error(`could not unpack ${path.basename(archive)}: ${r.stderr?.toString().trim() || r.error}`)
}

function versionOf(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { stdio: "pipe", timeout: 30000 })
  if (r.status !== 0) return null
  return r.stdout.toString().trim().split("\n").pop() ?? null
}

/** Swap `fresh` into `target`, keep the old one until the new one proves it runs. */
function replaceBinary(fresh: string, target: string): string {
  if (!slotOf(target)) throw new Error(`refusing to write ${target}: only a file named iris or iris2 is ever replaced`)
  fs.chmodSync(fresh, 0o755)
  if (process.platform === "darwin") spawnSync("xattr", ["-cr", fresh], { stdio: "ignore" })
  const previous = target + ".previous"
  const had = fs.existsSync(target)
  if (had) {
    fs.rmSync(previous, { force: true })
    fs.renameSync(target, previous) // also frees the name of a running .exe on Windows
  }
  fs.renameSync(fresh, target)
  const version = versionOf(target)
  if (!version) {
    fs.rmSync(target, { force: true })
    if (had) fs.renameSync(previous, target)
    throw new Error(`the new ${path.basename(target)} did not start (\`${target} --version\` failed) — kept the previous one`)
  }
  return version
}

export type InstallResult = { target: string; version: string; tag: string; upToDate: boolean }

/** Download one channel's release, verify it, and swap it into `target`. */
export async function installRelease(opts: {
  target: string
  channel: Channel
  tag: string
  log?: (line: string) => void
}): Promise<InstallResult> {
  const log = opts.log ?? (() => {})
  const { target, channel, tag } = opts
  const slot = slotOf(target)
  if (!slot) throw new Error(`refusing to write ${target}: only a file named iris or iris2 is ever replaced`)
  if (slot === "iris2" && channel === "stable") throw new Error(`refusing to put a stable build in ${target}`)
  const asset = assetName(process.platform, process.arch, channel)
  if (!asset) throw new Error(`no build is published for ${process.platform}-${process.arch}`)
  // The binary inside the archive is named for its channel (iris2 in previews, iris in stable);
  // it is written under the target's own name, so a canary `iris` can hold a preview build.
  const inner = slotFile(channel === "stable" ? "iris" : "iris2")

  // IRIS2_RELEASE_BASE: tests (and a mirror, if we ever need one) serve the assets themselves.
  const base = `${process.env["IRIS2_RELEASE_BASE"] ?? `https://github.com/${REPO}/releases/download`}/${tag}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Stage beside the target: same filesystem, so the final rename is atomic.
  const stage = fs.mkdtempSync(path.join(path.dirname(target), ".iris2-update-"))
  try {
    log(`downloading ${asset} (${tag})`)
    const archive = path.join(stage, asset)
    const shaFile = archive + ".sha256"
    await download(`${base}/${asset}.sha256`, shaFile)
    const expected = parseSha256(fs.readFileSync(shaFile, "utf8"))
    if (!expected) throw new Error(`${asset}.sha256 is not a sha256 digest — not installing`)
    await download(`${base}/${asset}`, archive)
    const actual = sha256File(archive)
    if (actual !== expected) throw new Error(`checksum mismatch for ${asset} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — not installing`)
    log("checksum ok")
    const out = path.join(stage, "out")
    fs.mkdirSync(out)
    extract(archive, out)
    const fresh = path.join(out, inner)
    if (!fs.existsSync(fresh)) throw new Error(`${asset} does not contain ${inner}`)
    const version = replaceBinary(fresh, target)
    return { target, version, tag, upToDate: false }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** `iris iris2 install|update`: the iris2 file only, preview channel only. */
export async function installIris2(opts: {
  target?: string
  version?: string
  force?: boolean
  current?: string
  log?: (line: string) => void
}): Promise<InstallResult> {
  const target = opts.target ?? defaultInstallPath()
  if (!isIris2Path(target)) throw new Error(`refusing to write ${target}: not an iris2 path`)
  const releases = opts.version ? [] : await fetchReleases()
  const plan = planUpdate({
    slot: "iris2",
    current: opts.current ?? "0.0.0-none",
    pinned: opts.version,
    force: opts.force,
    releases,
  })
  if (plan.kind === "refuse") throw new Error(plan.message)
  if (plan.kind === "current") return { target, version: plan.version, tag: tagFor(plan.version, "preview"), upToDate: true }
  return installRelease({ target, channel: plan.channel, tag: plan.tag, log: opts.log })
}

/** Another `iris2` earlier on PATH would hide the one we install (the spike left a symlink in ~/.local/bin). */
export function shadowingIris2(target: string): string | null {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName())
    if (!fs.existsSync(candidate)) continue
    const real = (() => {
      try {
        return fs.realpathSync(candidate)
      } catch {
        return candidate
      }
    })()
    const targetReal = fs.existsSync(target) ? fs.realpathSync(target) : target
    return real === targetReal ? null : candidate
  }
  return null
}

function onPath(dir: string): boolean {
  return (process.env["PATH"] ?? "").split(path.delimiter).some((d) => path.resolve(d) === path.resolve(dir))
}

const PREVIEW_NOTE =
  "iris2 is a PREVIEW of IRIS on the new opencode v2 engine. Your stable `iris` is untouched and stays your default.\n" +
  "  Known gaps: chat history from `iris` does not carry over, you may need to log in once,\n" +
  "  and not every command has been verified yet. Report problems with `iris bug report`."

/**
 * `upgrade` / `update` on a v2-engine build, run by its front door on ITSELF. Which file it
 * replaces is the running binary's own; which releases it follows is planUpdate's call.
 *   iris2 upgrade [version] [--channel stable|preview] [--check] [--force]
 */
export async function selfUpdate(
  args: string[],
  current: string,
  opts: { execPath?: string; releases?: Release[] } = {},
): Promise<number> {
  const target = (() => {
    const p = opts.execPath ?? process.execPath
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  })()
  const flag = (name: string) => {
    const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return undefined
    return args[i]!.includes("=") ? args[i]!.split("=")[1] : args[i + 1]
  }
  const requestedRaw = flag("channel")
  if (requestedRaw !== undefined && requestedRaw !== "stable" && requestedRaw !== "preview") {
    process.stderr.write(`--channel must be stable or preview (got ${requestedRaw})\n`)
    return 1
  }
  const requested = requestedRaw as Channel | undefined
  const consumed = new Set<number>()
  args.forEach((a, i) => {
    if (a === "--channel") consumed.add(i + 1)
  })
  const pinned = args.find((a, i) => !a.startsWith("-") && !consumed.has(i))
  const slot = slotOf(target)
  const name = slot ?? path.basename(target)
  try {
    const releases = opts.releases ?? (await fetchReleases())
    const plan = planUpdate({ slot, current, requested, pinned, force: args.includes("--force"), releases })
    if (args.includes("--check")) {
      const line =
        plan.kind === "install"
          ? `${name} ${current} → ${plan.version} available (${plan.channel})${plan.note ? ` — ${plan.note}` : ""}`
          : plan.kind === "current"
            ? `${name} ${current} is the latest ${plan.channel} release`
            : plan.message
      process.stdout.write(line + "\n")
      return plan.kind === "refuse" ? 1 : 0
    }
    if (plan.kind === "refuse") {
      process.stderr.write(`${name} upgrade: ${plan.message}\n`)
      return 1
    }
    if (plan.kind === "current") {
      process.stdout.write(`${name} ${current} is the latest ${plan.channel} release\n`)
      return 0
    }
    if (plan.note) process.stdout.write(`  ${plan.note}\n`)
    const r = await installRelease({ target, channel: plan.channel, tag: plan.tag, log: (l) => process.stdout.write(`  ${l}\n`) })
    process.stdout.write(`${name} updated to ${r.version}\n`)
    // v2's background service keeps the binary and config it started with (#187712 I15). A
    // stable v1 build has no such service; the call fails quietly there.
    spawnSync(target, ["service", "restart"], { stdio: "ignore", timeout: 30000 })
    return 0
  } catch (e) {
    process.stderr.write(`${name} upgrade failed: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

export const Iris2Command = cmd({
  command: "iris2 [action] [release]",
  describe: "install or update iris2 — the opt-in preview of IRIS on the opencode v2 engine (your `iris` is untouched)",
  builder: (y) =>
    y
      .positional("action", {
        describe: "install | update | remove | status",
        type: "string",
        choices: ["install", "update", "remove", "status"],
        default: "status",
      })
      .positional("release", { describe: "a specific iris2 version (e.g. 1.5.0-beta.1); default: newest", type: "string" })
      .option("force", { describe: "reinstall even when already on that version", type: "boolean", default: false })
      .example("iris iris2 install", "put iris2 beside iris in ~/.iris/bin")
      .example("iris iris2 update", "move iris2 to the newest preview")
      .example("iris iris2 remove", "delete iris2; iris is not touched"),
  handler: async (args) => {
    const target = defaultInstallPath()
    const action = String(args.action ?? "status")
    const installed = fs.existsSync(target) ? versionOf(target) : null

    if (action === "status") {
      let latest: string | null = null
      try {
        latest = (await fetchLatest())?.version ?? null
      } catch (e) {
        latest = null
        prompts.log.warn(`could not reach GitHub: ${e instanceof Error ? e.message : e}`)
      }
      console.log(`${bold("iris2")}  ${installed ? `installed ${installed}` : "not installed"}  ${dim(target)}`)
      console.log(`  latest preview: ${latest ?? dim("none published yet")}`)
      if (!installed) console.log(dim("  install it: iris iris2 install"))
      else if (latest && compareVersions(installed, latest) < 0) console.log(dim("  update it:  iris iris2 update"))
      return
    }

    if (action === "remove") {
      if (!installed && !fs.existsSync(target)) {
        console.log(`iris2 is not installed at ${target}`)
        return
      }
      fs.rmSync(target, { force: true })
      fs.rmSync(target + ".previous", { force: true })
      console.log(success(`removed ${target}`) + dim("  (your iris and its data are untouched)"))
      return
    }

    // install | update
    if (action === "update" && !installed) {
      console.log(dim("iris2 is not installed yet — installing"))
    }
    if (action === "install" || !installed) console.log(dim(PREVIEW_NOTE))
    const spinner = prompts.spinner()
    spinner.start("fetching iris2")
    try {
      const r = await installIris2({
        target,
        version: args.release as string | undefined,
        force: Boolean(args.force) || action === "install",
        current: installed ?? undefined,
        log: (l) => spinner.message(l),
      })
      if (r.upToDate) {
        spinner.stop(`iris2 ${r.version} is already the latest`)
        return
      }
      spinner.stop(success(`iris2 ${r.version} installed`) + dim(`  ${r.target}`))
      if (installed) spawnSync(r.target, ["service", "restart"], { stdio: "ignore", timeout: 30000 })
    } catch (e) {
      spinner.stop(`iris2: ${e instanceof Error ? e.message : String(e)}`, 1)
      process.exitCode = 1
      return
    }
    const shadow = shadowingIris2(target)
    if (shadow) prompts.log.warn(`another iris2 comes first on your PATH: ${shadow} — remove it or \`iris2\` will run that one`)
    else if (!onPath(path.dirname(target))) prompts.log.warn(`${path.dirname(target)} is not on your PATH — run ${target} directly`)
    else console.log(`  run it: ${bold("iris2")}`)
  },
})
