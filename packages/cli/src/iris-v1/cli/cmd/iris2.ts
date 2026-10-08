import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, bold, success } from "./iris-api"
import { spawnSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

// ============================================================================
// iris iris2 — the opt-in preview of IRIS on the opencode v2 engine (#188596)
// ============================================================================
//
// iris2 ships BESIDE the stable `iris`, never in place of it, until it is ready to take over.
// Two guarantees hold everything else up:
//
//   1. Nothing here ever writes the stable binary. Every write goes to a file named `iris2`
//      (`iris2.exe`), and `replaceBinary` refuses any other name. The stable `iris upgrade`
//      downloads `iris-<os>-<arch>.*` from `v*` tags; iris2 lives on `iris2-v*` tags with
//      `iris2-<os>-<arch>.*` assets, so neither updater can see the other's files.
//   2. A download that does not match its published .sha256 is never installed, and a binary
//      that cannot print its version after the swap is rolled back.
//
// This file is ALSO the updater iris2 runs on itself: the iris2 build vendors this source tree
// (packages/cli/script/sync-iris-v1.ts on the iris2 branch) and its front door calls
// `selfUpdate()` for `iris2 upgrade`. One implementation, so the two cannot drift.

const REPO = "FREELABEL/iris-opencode"
export const TAG_PREFIX = "iris2-v"

export type Release = { tag_name: string; draft?: boolean; prerelease?: boolean; published_at?: string | null }

export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "iris2.exe" : "iris2"
}

export function defaultInstallPath(home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  return path.join(home, ".iris", "bin", binaryName(platform))
}

/** The release asset for this machine, or null where we do not publish one. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null
  if (!os || !cpu) return null
  if (os === "windows" && cpu === "arm64") return null
  return `iris2-${os}-${cpu}.${os === "linux" ? "tar.gz" : "zip"}`
}

/** "iris2-v1.5.0-beta.3" → "1.5.0-beta.3"; anything else → null. */
export function versionOfTag(tag: string): string | null {
  if (!tag.startsWith(TAG_PREFIX)) return null
  const v = tag.slice(TAG_PREFIX.length)
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null
}

/** Semver order, prerelease-aware (1.5.0-beta.10 > 1.5.0-beta.9 < 1.5.0). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split("-", 2) as [string, string | undefined]
    return { core: core.split(".").map(Number), pre: pre === undefined ? [] : v.slice(core.length + 1).split(".") }
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

/** Newest published iris2 release. Stable `v*` tags and desktop tags are never candidates. */
export function pickLatest(releases: Release[]): { tag: string; version: string } | null {
  let best: { tag: string; version: string } | null = null
  for (const r of releases) {
    if (r.draft) continue
    const version = versionOfTag(r.tag_name)
    if (!version) continue
    if (!best || compareVersions(version, best.version) > 0) best = { tag: r.tag_name, version }
  }
  return best
}

/** `sha256sum` output ("<hex>  file") or a bare hex digest. */
export function parseSha256(text: string): string | null {
  const m = text.trim().match(/^([a-fA-F0-9]{64})\b/)
  return m ? m[1].toLowerCase() : null
}

/** Guarantee 1. The only file this module may replace is one named iris2 / iris2.exe. */
export function isIris2Path(target: string): boolean {
  return path.basename(target).toLowerCase() === "iris2" || path.basename(target).toLowerCase() === "iris2.exe"
}

function ghHeaders(): Record<string, string> {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]
  return { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

export async function fetchLatest(): Promise<{ tag: string; version: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`)
  return pickLatest((await res.json()) as Release[])
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
  if (!isIris2Path(target)) {
    throw new Error(`refusing to write ${target}: iris2 only ever replaces a file named ${binaryName()}`)
  }
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
    throw new Error(`the new iris2 did not start (\`${target} --version\` failed) — kept the previous one`)
  }
  return version
}

export type InstallResult = { target: string; version: string; tag: string; upToDate: boolean }

export async function installIris2(opts: {
  target?: string
  version?: string
  force?: boolean
  current?: string
  log?: (line: string) => void
}): Promise<InstallResult> {
  const log = opts.log ?? (() => {})
  const target = opts.target ?? defaultInstallPath()
  if (!isIris2Path(target)) throw new Error(`refusing to write ${target}: not an iris2 path`)
  const asset = assetName()
  if (!asset) throw new Error(`no iris2 build is published for ${process.platform}-${process.arch} yet`)

  const pick = opts.version
    ? { tag: opts.version.startsWith(TAG_PREFIX) ? opts.version : TAG_PREFIX + opts.version.replace(/^v/, ""), version: opts.version.replace(TAG_PREFIX, "").replace(/^v/, "") }
    : await fetchLatest()
  if (!pick) throw new Error("no iris2 release has been published yet")
  if (!opts.force && opts.current && compareVersions(opts.current, pick.version) >= 0) {
    return { target, version: opts.current, tag: pick.tag, upToDate: true }
  }

  // IRIS2_RELEASE_BASE: tests (and a mirror, if we ever need one) serve the assets themselves.
  const base = `${process.env["IRIS2_RELEASE_BASE"] ?? `https://github.com/${REPO}/releases/download`}/${pick.tag}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Stage beside the target: same filesystem, so the final rename is atomic.
  const stage = fs.mkdtempSync(path.join(path.dirname(target), ".iris2-update-"))
  try {
    log(`downloading ${asset} (${pick.tag})`)
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
    const fresh = path.join(out, binaryName())
    if (!fs.existsSync(fresh)) throw new Error(`${asset} does not contain ${binaryName()}`)
    const version = replaceBinary(fresh, target)
    return { target, version, tag: pick.tag, upToDate: false }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
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

/** `iris2 upgrade` / `iris2 update` — called by the iris2 front door on itself. */
export async function selfUpdate(args: string[], current: string): Promise<number> {
  const target = (() => {
    try {
      return fs.realpathSync(process.execPath)
    } catch {
      return process.execPath
    }
  })()
  const positional = args.find((a) => !a.startsWith("-"))
  const force = args.includes("--force")
  try {
    if (args.includes("--check")) {
      const latest = await fetchLatest()
      process.stdout.write(`iris2 ${current} — latest ${latest ? latest.version : "(none published)"}\n`)
      return 0
    }
    const r = await installIris2({ target, version: positional, force, current, log: (l) => process.stdout.write(`  ${l}\n`) })
    if (r.upToDate) {
      process.stdout.write(`iris2 ${current} is the latest (${r.tag})\n`)
      return 0
    }
    process.stdout.write(`iris2 updated to ${r.version}\n`)
    // v2's background service keeps the binary and config it started with (#187712 I15).
    spawnSync(target, ["service", "restart"], { stdio: "ignore", timeout: 30000 })
    return 0
  } catch (e) {
    process.stderr.write(`iris2 upgrade failed: ${e instanceof Error ? e.message : String(e)}\n`)
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
