import { cmd } from "./cmd"
import { dim, bold, success, warn } from "./iris-api"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * `iris hive drive` — one folder mounted on every Hive node and agent sandbox (#188567, EVAL #188566).
 *
 * The ask (Compound's reel): agents on different machines cannot see each other's work; cloning and
 * pull requests mean nothing is live; git breaks on large files. Their fix — a metadata service plus
 * an object store, FUSE-mounted everywhere — is exactly JuiceFS (Apache-2.0). So this ADOPTS it and
 * wraps it; it does not write a filesystem.
 *
 * MEASURED 2026-10-08 with JuiceFS 1.4.1, two mounts sharing one Redis + one bucket:
 *   - a file written on mount A was visible on mount B after 7 ms;
 *   - reading 1 MB at offset 150 MB of a 200 MB file pulled 8 MB into B's cache, not 200 MB.
 *
 * What it needs, and deliberately does not provision for you: a metadata store every node can reach
 * (Redis/Postgres on one of your nodes over Tailscale, or a managed one) and a bucket (R2/S3; `file`
 * for a single machine). Choosing where your files live is yours.
 *
 * SECRETS. The metadata URL usually carries a password. It is stored 0600 in ~/.iris/drives, never
 * printed, and handed to juicefs as META_PASSWORD — not on the command line, where `ps` shows it.
 */

export const JUICEFS_VERSION = "1.4.1"
const NAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/

export const drivesDir = (home: string) => path.join(home, ".iris", "drives")
export const binPath = (home: string) => path.join(home, ".iris", "bin", "juicefs")

export type DriveConfig = { name: string; meta: string; mountpoint: string; created_at: string }

/** The URL without its password, and the password — so neither the screen nor argv sees it. */
export function splitMetaSecret(meta: string): { url: string; password: string | null } {
  try {
    const u = new URL(meta)
    if (!u.password) return { url: meta, password: null }
    const password = decodeURIComponent(u.password)
    u.password = ""
    // "redis://:@host" → "redis://host" when there was no username either.
    return { url: u.toString().replace(/\/\/:?@/, "//"), password }
  } catch {
    return { url: meta, password: null }
  }
}

/** For display: scheme, host and path only. */
export function redactMeta(meta: string): string {
  try {
    const u = new URL(meta)
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`
  } catch {
    return "(unparseable meta url)"
  }
}

export function assetName(platform: string, arch: string): string | null {
  const os_ = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null
  const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null
  return os_ && a ? `juicefs-${JUICEFS_VERSION}-${os_}-${a}.tar.gz` : null
}

/** The expected sha256 for an asset from the release's checksums.txt, or null. */
export function checksumFor(checksums: string, asset: string): string | null {
  for (const line of checksums.split("\n")) {
    const [sum, file] = line.trim().split(/\s+/)
    if (file === asset && /^[0-9a-f]{64}$/.test(sum)) return sum
  }
  return null
}

export function formatArgs(name: string, metaUrl: string, storage: string, bucket: string): string[] {
  return ["format", "--storage", storage, "--bucket", bucket, metaUrl, name]
}

export function mountArgs(metaUrl: string, mountpoint: string, cacheDir: string): string[] {
  return ["mount", "-d", "--cache-dir", cacheDir, metaUrl, mountpoint]
}

function readConfig(home: string, name: string): DriveConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(drivesDir(home), `${name}.json`), "utf8"))
  } catch {
    return null
  }
}

function writeConfig(home: string, c: DriveConfig) {
  fs.mkdirSync(drivesDir(home), { recursive: true, mode: 0o700 })
  const file = path.join(drivesDir(home), `${c.name}.json`)
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function listConfigs(home: string): DriveConfig[] {
  try {
    return fs.readdirSync(drivesDir(home)).filter((f) => f.endsWith(".json")).map((f) => readConfig(home, f.slice(0, -5))).filter(Boolean) as DriveConfig[]
  } catch {
    return []
  }
}

/** Is something mounted at this path? Reads the kernel's own table, not a pid file. */
export function isMounted(mountpoint: string, mountsTable?: string): boolean {
  const table = mountsTable ?? (() => {
    try { return fs.readFileSync("/proc/mounts", "utf8") } catch {}
    const r = Bun.spawnSync(["mount"], { stdout: "pipe" })
    return new TextDecoder().decode(r.stdout)
  })()
  const mp = path.resolve(mountpoint)
  return table.split("\n").some((l) => l.split(/\s+/).includes(mp) || l.includes(` on ${mp} `))
}

function juicefs(home: string): string | null {
  const b = binPath(home)
  if (fs.existsSync(b)) return b
  return Bun.which("juicefs")
}

function run(bin: string, args: string[], password: string | null) {
  const env = { ...process.env } as Record<string, string>
  if (password) env.META_PASSWORD = password
  const r = Bun.spawnSync([bin, ...args], { env, stdout: "pipe", stderr: "pipe" })
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr)
  return { ok: r.exitCode === 0, out }
}

const fail = (msg: string) => {
  console.error(warn(`  ✗ ${msg}`))
  process.exitCode = 1
}

const need = (home: string) => {
  const j = juicefs(home)
  if (!j) fail("juicefs is not installed — run: iris hive drive install")
  return j
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? ""

// ─── commands ────────────────────────────────────────────────────────────────

const InstallCmd = cmd({
  command: "install",
  describe: `install JuiceFS ${JUICEFS_VERSION} into ~/.iris/bin (checksum-verified)`,
  async handler() {
    const home = os.homedir()
    const asset = assetName(process.platform, process.arch)
    if (!asset) return fail(`no JuiceFS build for ${process.platform}/${process.arch}`)
    const base = `https://github.com/juicedata/juicefs/releases/download/v${JUICEFS_VERSION}`
    const sums = await fetch(`${base}/checksums.txt`).then((r) => (r.ok ? r.text() : ""))
    const want = checksumFor(sums, asset)
    if (!want) return fail(`could not read the published checksum for ${asset} — not installing an unverified binary`)
    const tgz = Buffer.from(await (await fetch(`${base}/${asset}`)).arrayBuffer())
    const got = createHash("sha256").update(tgz).digest("hex")
    if (got !== want) return fail(`checksum mismatch for ${asset} (got ${got.slice(0, 12)}…, want ${want.slice(0, 12)}…) — not installing`)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jfs-"))
    fs.writeFileSync(path.join(tmp, asset), tgz)
    const x = Bun.spawnSync(["tar", "xzf", path.join(tmp, asset), "-C", tmp, "juicefs"])
    if (x.exitCode !== 0) return fail("could not unpack the archive")
    fs.mkdirSync(path.dirname(binPath(home)), { recursive: true })
    fs.copyFileSync(path.join(tmp, "juicefs"), binPath(home))
    fs.chmodSync(binPath(home), 0o755)
    fs.rmSync(tmp, { recursive: true, force: true })
    const v = run(binPath(home), ["version"], null)
    console.log(success(`  ✓ ${lastLine(v.out)}`) + dim(`  ${binPath(home)} · sha256 verified`))
    if (process.platform === "darwin") console.log(dim("  macOS also needs macFUSE (https://osxfuse.github.io) before a drive can mount."))
  },
})

const CreateCmd = cmd({
  command: "create <name>",
  describe: "create a new drive: where its file list lives (--meta) and where its bytes live (--bucket)",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true })
      .option("meta", { describe: "metadata store every node can reach, e.g. redis://:pw@100.x.y.z:6379/1", type: "string", demandOption: true })
      .option("bucket", { describe: "where the bytes live, e.g. https://<acct>.r2.cloudflarestorage.com/<bucket>", type: "string", demandOption: true })
      .option("storage", { describe: "s3 (R2/S3/MinIO) or file (one machine only)", type: "string", default: "s3" })
      .option("mountpoint", { describe: "default ~/IrisDrive/<name>", type: "string" }),
  async handler(argv) {
    const home = os.homedir()
    const name = String(argv.name)
    if (!NAME.test(name)) return fail("name: 3–32 chars, lowercase letters, digits and dashes")
    if (readConfig(home, name)) return fail(`a drive called ${name} is already set up here — iris hive drive status`)
    const j = need(home)
    if (!j) return
    const { url, password } = splitMetaSecret(String(argv.meta))
    // Bucket credentials, when needed, come from ACCESS_KEY / SECRET_KEY in the environment — never argv.
    const r = run(j, formatArgs(name, url, String(argv.storage), String(argv.bucket)), password)
    if (!r.ok) return fail(`juicefs format failed: ${lastLine(r.out)}`)
    const mountpoint = path.resolve(String(argv.mountpoint || path.join(home, "IrisDrive", name)))
    writeConfig(home, { name, meta: String(argv.meta), mountpoint, created_at: new Date().toISOString() })
    console.log(success(`  ✓ drive ${bold(name)} created`) + dim(`  meta ${redactMeta(String(argv.meta))}`))
    console.log(dim(`  mount it here:       iris hive drive mount ${name}`))
    console.log(dim(`  on every other node: iris hive drive join ${name} --meta <the same meta url>`))
  },
})

const JoinCmd = cmd({
  command: "join <name>",
  describe: "use a drive created on another node (same --meta url)",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true })
      .option("meta", { type: "string", demandOption: true })
      .option("mountpoint", { type: "string" }),
  async handler(argv) {
    const home = os.homedir()
    const name = String(argv.name)
    if (!NAME.test(name)) return fail("name: 3–32 chars, lowercase letters, digits and dashes")
    const j = need(home)
    if (!j) return
    const { url, password } = splitMetaSecret(String(argv.meta))
    // Prove the metadata store is reachable AND holds this drive before saving anything.
    const s = run(j, ["status", url], password)
    if (!s.ok) return fail(`cannot reach that metadata store: ${lastLine(s.out)}`)
    if (!new RegExp(`"Name":\\s*"${name}"`).test(s.out)) return fail(`that metadata store holds no drive called ${name}`)
    const mountpoint = path.resolve(String(argv.mountpoint || path.join(home, "IrisDrive", name)))
    writeConfig(home, { name, meta: String(argv.meta), mountpoint, created_at: new Date().toISOString() })
    console.log(success(`  ✓ joined ${bold(name)}`) + dim(`  — iris hive drive mount ${name}`))
  },
})

const MountCmd = cmd({
  command: "mount <name>",
  describe: "mount a drive on this machine",
  builder: (y) => y.positional("name", { type: "string", demandOption: true }),
  async handler(argv) {
    const home = os.homedir()
    const c = readConfig(home, String(argv.name))
    if (!c) return fail(`no drive called ${argv.name} on this machine — create or join it first`)
    if (isMounted(c.mountpoint)) return void console.log(dim(`  already mounted at ${c.mountpoint}`))
    const j = need(home)
    if (!j) return
    fs.mkdirSync(c.mountpoint, { recursive: true })
    const { url, password } = splitMetaSecret(c.meta)
    const cache = path.join(home, ".iris", "drive-cache", c.name)
    const r = run(j, mountArgs(url, c.mountpoint, cache), password)
    // Ask the kernel, not the exit code: a daemonised mount can exit 0 and still not be there.
    if (!r.ok || !isMounted(c.mountpoint)) return fail(`mount failed: ${lastLine(r.out)}`)
    console.log(success(`  ✓ ${bold(c.name)} mounted at ${c.mountpoint}`) + dim("  — reads stream on demand; writes are visible on every node"))
  },
})

const UnmountCmd = cmd({
  command: "unmount <name>",
  describe: "unmount a drive on this machine",
  builder: (y) => y.positional("name", { type: "string", demandOption: true }),
  async handler(argv) {
    const home = os.homedir()
    const c = readConfig(home, String(argv.name))
    if (!c) return fail(`no drive called ${argv.name} on this machine`)
    if (!isMounted(c.mountpoint)) return void console.log(dim("  not mounted"))
    const j = need(home)
    if (!j) return
    const r = run(j, ["umount", c.mountpoint], null)
    if (!r.ok || isMounted(c.mountpoint)) return fail(`unmount failed (files open?): ${lastLine(r.out)}`)
    console.log(success(`  ✓ unmounted ${c.name}`))
  },
})

const StatusCmd = cmd({
  command: "status",
  describe: "drives on this machine and whether each is mounted",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const home = os.homedir()
    const rows = listConfigs(home).map((c) => ({ name: c.name, mountpoint: c.mountpoint, mounted: isMounted(c.mountpoint), meta: redactMeta(c.meta) }))
    if (argv.json) return void console.log(JSON.stringify({ juicefs: juicefs(home), drives: rows }, null, 2))
    console.log()
    console.log(`  juicefs   ${juicefs(home) ? dim(juicefs(home)!) : warn("not installed — iris hive drive install")}`)
    if (!rows.length) console.log(dim("  no drives — iris hive drive create <name> --meta … --bucket …"))
    for (const r of rows) console.log(`  ${bold(r.name.padEnd(16))} ${r.mounted ? success("mounted  ") : dim("unmounted")} ${dim(r.mountpoint)}  ${dim(r.meta)}`)
    console.log()
  },
})

export const HiveDriveCommand = cmd({
  command: "drive",
  describe: "one folder mounted on every Hive node — streamed on demand, live everywhere (JuiceFS)",
  builder: (y) =>
    y.command(InstallCmd).command(CreateCmd).command(JoinCmd).command(MountCmd).command(UnmountCmd).command(StatusCmd).demandCommand(1),
  async handler() {},
})
