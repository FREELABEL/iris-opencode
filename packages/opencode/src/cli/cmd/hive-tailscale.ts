/**
 * Reaching your OWN Hive nodes over Tailscale.
 *
 * WHY THIS EXISTS. The Hive task transport cannot be trusted to carry bytes: it returns the
 * tmux pane's PTY stream rather than the process's stdout, so the wrapper's own command line,
 * the shell prompt and ANSI escapes are interleaved with the program output and stdout/stderr
 * are merged irrecoverably (#182004). A base64 round-trip through it came back corrupted. It
 * is not a file channel and no amount of encoding makes it one.
 *
 * Tailscale is already deployed on every Mac in the mesh and key auth already works. So file
 * transfer and remote health checks go over ssh/scp, which is a byte-safe channel with an
 * exit code, and they do NOT inherit the transport's outage.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. ssh does not defeat macOS TCC. The ssh session on a
 * node has its own (usually empty) set of privacy grants, so `~/Library/Messages`,
 * `~/Library/Containers/<app>/` and the Calendar store refuse it with "Operation not
 * permitted" even though the daemon in the GUI session may read them fine. Staging through
 * /tmp helps with awkward directory permissions; it does not help with TCC. Callers must
 * report a TCC refusal as a permission problem, never as "file not found" (#182007).
 */

import { execFile, spawnSync } from "child_process"
import { promisify } from "util"
import { createHash } from "crypto"
import { randomUUID } from "crypto"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync, statSync } from "fs"
import { homedir, userInfo } from "os"
import { join, basename, dirname } from "path"

const pexec = promisify(execFile)

/** Where a resolved ssh user is remembered, so it is asked for at most once per node. */
/**
 * Where the node -> ssh-address bindings live.
 *
 * A function rather than a const so a test can redirect it. A module-level const bound to
 * homedir() meant the only way to exercise the cache was to write to the developer's real
 * ~/.iris, so this module shipped with no tests at all (#182368).
 */
function sshCachePath(): string {
  return process.env.IRIS_HIVE_SSH_CACHE || join(homedir(), ".iris", "hive-ssh.json")
}

export interface TailscalePeer {
  ip: string
  hostName: string
  dnsName: string
  online: boolean
  os: string
}

export interface SshTarget {
  /** Tailscale IPv4, e.g. 100.100.67.48 */
  host: string
  /** Unix user on the node, or null to let ssh/ssh_config decide. */
  user: string | null
  /** How the host was determined, for honest reporting. */
  via: "explicit" | "tailscale" | "cached" | "advertised"
  peer?: TailscalePeer
}

/** Quote a string for a POSIX shell. Node names and paths contain spaces — the DDJ-T1
 *  mapping is literally "Pioneer DDJ-T1.midi.xml" — and an unquoted path silently becomes
 *  two arguments. */
export function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/**
 * Quote a REMOTE path, preserving a leading `~`.
 *
 * shq() alone would emit '~/x', which the remote shell treats as a literal directory called
 * "~" — tilde expansion does not happen inside quotes. Paths on other people's machines are
 * almost always written with ~, so quoting it correctly is not a nicety.
 */
export function shqPath(p: string): string {
  if (p === "~") return '"$HOME"'
  if (p.startsWith("~/")) {
    const rest = p.slice(2)
    return rest ? '"$HOME"/' + shq(rest) : '"$HOME"'
  }
  return shq(p)
}

/**
 * Compare a Hive node name to a Tailscale hostname.
 *
 * They are never equal: the Hive calls a machine "MacBookPro", Tailscale calls the same
 * machine "alexs-macbook-pro-2", and its hostname is "Alexs-MacBook-Pro-11711.local". Strip
 * everything that is not a letter or digit, lowercase both, and ask whether either contains
 * the other. Exported because a fuzzy match is exactly the kind of thing that should be
 * pinned by tests rather than trusted.
 */
export function nameMatches(nodeName: string, peerName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const a = norm(nodeName)
  const b = norm(peerName)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Query `tailscale status --json`, returning both the peers AND whether the
 * query itself succeeded (#182104).
 *
 * The sibling platform-hive-vpn.ts's readStatus() was fixed for exactly this
 * failure shape after a real 2026-08-16 incident: one transient query failure
 * read as "not on the tailnet" seconds after the tailnet was confirmed
 * healthy. This module previously had no retry at all and could not tell a
 * caller "the query failed" from "the query succeeded and found nothing" —
 * the same gap, on the module whose own docblock frames it as the reliable
 * fallback specifically because it doesn't inherit the primary transport's
 * outages (#182004). One retry per binary before moving to the next.
 */
async function tailscaleStatusQuery(): Promise<{ peers: TailscalePeer[]; queryOk: boolean }> {
  const bins = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]
  for (const bin of bins) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await pexec(bin, ["status", "--json"], { timeout: 10_000, maxBuffer: 8 << 20 })
        const j = JSON.parse(stdout)
        const out: TailscalePeer[] = []
        const push = (p: any) => {
          if (!p) return
          const ip = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.find((x: string) => x.includes(".")) : null
          if (!ip) return
          out.push({
            ip,
            hostName: String(p.HostName ?? ""),
            dnsName: String(p.DNSName ?? "").replace(/\.$/, ""),
            online: p.Online === true,
            os: String(p.OS ?? ""),
          })
        }
        push(j.Self)
        for (const k of Object.keys(j.Peer ?? {})) push(j.Peer[k])
        return { peers: out, queryOk: true }
      } catch {
        // One retry on THIS binary (the failure this exists for is transient
        // and a second call costs milliseconds), then fall through to the
        // next binary path.
      }
    }
  }
  return { peers: [], queryOk: false }
}

/** Read the local Tailscale peer list. Returns [] when Tailscale is absent, not running, or the query failed. */
export async function tailscalePeers(): Promise<TailscalePeer[]> {
  return (await tailscaleStatusQuery()).peers
}

async function readSshCache(): Promise<Record<string, { host?: string; user?: string }>> {
  try {
    return JSON.parse(await readFile(sshCachePath(), "utf-8"))
  } catch {
    return {}
  }
}

async function writeSshCache(cache: Record<string, { host?: string; user?: string }>): Promise<void> {
  try {
    await mkdir(dirname(sshCachePath()), { recursive: true })
    await writeFile(sshCachePath(), JSON.stringify(cache, null, 2), "utf-8")
  } catch {
    // a cache that cannot be written is a lost convenience, not an error
  }
}

/**
 * Which registered node is THIS machine.
 *
 * Needed because the local node must never be dialled as a peer: it is already holding its own
 * copy of everything, and attempting ssh to yourself fails, which then gets reported as
 * "could not reach" for a machine that is demonstrably right here. Measured 2026-08-24:
 * `hive vault status` counted the local blobs as "this machine" AND listed the same node under
 * "could not reach" in the same breath.
 *
 * Resolution order matches `hive nodes list`, and for the same reason: config.node_id is a key
 * nothing reliably writes, and macOS rewrites the hostname on every mDNS collision, so a
 * hostname comparison compares a mutating name to a frozen one. The DAEMON knows its own id.
 */
export async function detectLocalNodeId(nodes: Array<{ id: string; name: string }>): Promise<string | null> {
  let configNodeId: string | null = null
  try {
    const cfg = join(homedir(), ".iris", "config.json")
    if (existsSync(cfg)) configNodeId = JSON.parse(await readFile(cfg, "utf-8")).node_id || null
  } catch { /* fall through */ }

  let daemonNodeId: string | null = null
  try {
    const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(1500) })
    if (res.ok) daemonNodeId = ((await res.json()) as any)?.node_id ?? null
  } catch { /* daemon not running — weaker sources below */ }

  const { resolveLocalNode } = await import("./hive-local-node")
  return resolveLocalNode({
    daemonNodeId,
    configNodeId,
    hostname: await hostnameSafe(),
    nodes: nodes.map((n) => ({ id: String(n.id), name: String(n.name) })),
  }).nodeId
}

async function hostnameSafe(): Promise<string> {
  try {
    const { stdout } = await pexec("hostname", [], { timeout: 5000 })
    return stdout.trim()
  } catch {
    return ""
  }
}

/**
 * Bind a Hive node to an ssh address, permanently.
 *
 * `--host` used to be honoured for exactly one invocation and thrown away, so a node whose
 * Hive name differs from its tailnet name needed --host typed again on EVERY call — including
 * every `hive vault` operation, which rides on this. Persisting it turns a permanent papercut
 * into a one-time binding.
 *
 * Safe precisely because a human asserted the identity. The alternative fix — loosening
 * nameMatches until the two names match — cannot distinguish the right machine from a
 * similarly-named one, and `hive fs push` WRITES FILES onto whatever it picks. On a tailnet
 * that carries other people's laptops that is a data leak, not a convenience.
 */
export async function rememberSshHost(nodeId: string, host: string, user?: string | null): Promise<void> {
  const cache = await readSshCache()
  cache[nodeId] = { ...(cache[nodeId] ?? {}), host, ...(user ? { user } : {}) }
  await writeSshCache(cache)
}

/**
 * Resolve a Hive node to something ssh can address.
 *
 * Order: an explicit --host, then the cache, then Tailscale. Never guesses an IP.
 */
export async function resolveSshTarget(
  nodeId: string,
  nodeName: string,
  opts: { host?: string; user?: string; advertised?: string | null } = {},
): Promise<SshTarget | { error: string }> {
  const cache = await readSshCache()
  const cached = cache[nodeId] ?? {}

  if (opts.host) {
    // Remember it, so this is the LAST time --host has to be typed for this node.
    await rememberSshHost(nodeId, opts.host, opts.user ?? cached.user ?? null)
    return { host: opts.host, user: opts.user ?? cached.user ?? null, via: "explicit" }
  }
  if (cached.host) return { host: cached.host, user: opts.user ?? cached.user ?? null, via: "cached" }

  // What the NODE ITSELF reported, from its heartbeat (#182368). This is the fix that matters:
  // matching a Hive name against a tailnet name is a guess, and when the two names were chosen
  // independently the guess fails and the FIRST call dead-ends — telling you to pass the IP you
  // were asking the tool to find.
  //
  // Ranked below the cache on purpose: an operator-asserted or probe-confirmed binding is not
  // overridden, so nothing that works today changes. This only fills the case that used to be
  // a dead end.
  //
  // Trimmed and checked for emptiness because "" is not an address — treating a blank as one
  // turns "the node told us nothing" into "connect to nowhere".
  const advertised = (opts.advertised ?? "").trim()
  if (advertised) return { host: advertised, user: opts.user ?? cached.user ?? null, via: "advertised" }

  // queryOk (#182104) distinguishes "couldn't ask" from "asked, zero peers" —
  // the same failure this module's docblock says it exists to survive.
  // Reporting them identically told someone to "start Tailscale" when it was
  // already running and a retry (now built into the query itself) would
  // have succeeded.
  const { peers, queryOk } = await tailscaleStatusQuery()
  if (peers.length === 0) {
    return {
      error: queryOk
        ? "Tailscale reports zero peers on this tailnet, so a node cannot be resolved to an address. Pass --host explicitly."
        : "Tailscale is not reachable on this machine (`tailscale status --json` failed twice), so a node cannot be resolved to an address. Pass --host explicitly, or start Tailscale.",
    }
  }

  const matches = peers.filter((p) => nameMatches(nodeName, p.hostName) || nameMatches(nodeName, p.dnsName.split(".")[0]))
  if (matches.length === 0) {
    const names = peers.map((p) => p.hostName || p.dnsName).filter(Boolean).join(", ")
    return { error: `No Tailscale peer matches Hive node "${nodeName}". Peers seen: ${names || "(none)"}. Pass --host to say which.` }
  }
  if (matches.length > 1) {
    const names = matches.map((p) => `${p.hostName} (${p.ip})`).join(", ")
    return { error: `Hive node "${nodeName}" matches more than one Tailscale peer: ${names}. Pass --host to disambiguate.` }
  }

  return { host: matches[0].ip, user: opts.user ?? cached.user ?? null, via: "tailscale", peer: matches[0] }
}

const SSH_BASE = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=accept-new",
]

function dest(t: SshTarget): string {
  return t.user ? `${t.user}@${t.host}` : t.host
}

export interface RemoteResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/**
 * Run a command on the node over ssh.
 *
 * Note this returns SEPARATED stdout/stderr and a real exit code — which is the entire
 * reason these commands do not go through the Hive task transport.
 */
export async function sshRun(t: SshTarget, command: string, timeoutMs = 60_000): Promise<RemoteResult> {
  try {
    const { stdout, stderr } = await pexec("ssh", [...SSH_BASE, dest(t), command], {
      timeout: timeoutMs,
      maxBuffer: 32 << 20,
    })
    return { ok: true, code: 0, stdout, stderr }
  } catch (e: any) {
    return {
      ok: false,
      code: typeof e?.code === "number" ? e.code : 1,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? ""),
    }
  }
}

/**
 * Find a working ssh user for a node, probing candidates in order, and remember it.
 *
 * The local username is usually NOT the remote one (this mesh: AlexMayo here,
 * mayoalexander there), so a single guess fails and the error looks like a network problem.
 */
export async function ensureSshUser(
  nodeId: string,
  t: SshTarget,
  opts: { askNode?: () => Promise<string | null> } = {},
): Promise<SshTarget | { error: string }> {
  const candidates: (string | null)[] = []
  if (t.user) candidates.push(t.user)
  candidates.push(null) // let ssh_config decide — a Host entry may already name the user
  try {
    candidates.push(userInfo().username)
  } catch {
    /* ignore */
  }

  const attempts: SshAttempt[] = []
  const probeOne = async (user: string | null): Promise<SshTarget | null> => {
    const probe: SshTarget = { ...t, user }
    const r = await sshRun(probe, "true", 15_000)
    if (!r.ok) {
      attempts.push({ user, stderr: r.stderr })
      return null
    }
    const cache = await readSshCache()
    cache[nodeId] = { host: t.host, ...(user ? { user } : {}) }
    await writeSshCache(cache)
    return probe
  }
  const unreachable = () => attempts.some((a) => isSshUnreachable(a.stderr))
  for (const user of candidates) {
    const hit = await probeOne(user)
    if (hit) return hit
    // Every other username would time out the same way — the problem is the route, not the account.
    if (unreachable()) break
  }
  // Last: ask the node who its daemon runs as. A Linux box set up by hand rarely shares a
  // username with the Mac dialling it (iris-hive-001: siralexmayo vs mayoalexander), and
  // every guess above then fails with an error that reads like a network problem. The
  // node's answer is still only a CANDIDATE — it is used once the ssh login with it works.
  if (opts.askNode && !unreachable()) {
    const asked = await opts.askNode().catch(() => null)
    if (asked && !candidates.includes(asked)) {
      const hit = await probeOne(asked)
      if (hit) return hit
    }
  }
  const config = sshConfigFor(t.host)
  return { error: describeSshFailure(t.host, attempts, { defaultUser: config.user, keyFound: sshKeyFound(config) }) }
}

export interface SshAttempt {
  /** null = no user given; ssh used its own default (ssh_config User, else the local login). */
  user: string | null
  stderr: string
}

export function isSshAuthRefused(stderr: string): boolean {
  return /permission denied|no supported authentication|too many authentication failures/i.test(stderr)
}

export function isSshUnreachable(stderr: string): boolean {
  return /connection refused|connection timed out|operation timed out|no route to host|network is unreachable|host is down|could not resolve hostname/i.test(
    stderr,
  )
}

/** What ssh itself would use for a host: its default user, and the identity files it would offer. */
export function sshConfigFor(host: string): { user: string | null; identityFiles: string[] } {
  const r = spawnSync("ssh", ["-G", host], { encoding: "utf8", timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return { user: null, identityFiles: [] }
  let user: string | null = null
  const identityFiles: string[] = []
  for (const line of r.stdout.split("\n")) {
    const [k, ...rest] = line.trim().split(/\s+/)
    const v = rest.join(" ")
    if (k === "user" && v) user = v
    if (k === "identityfile" && v) identityFiles.push(v.replace(/^~(?=\/)/, homedir()))
  }
  return { user, identityFiles }
}

/**
 * Whether this machine has ANY key ssh could offer: one loaded in the agent, or an identity file
 * that exists. "No key at all" is the one failure where no username can ever work (#187786).
 */
export function sshKeyFound(config: { identityFiles: string[] }): boolean {
  const agent = spawnSync("ssh-add", ["-l"], { encoding: "utf8", timeout: 5000 })
  if (agent.status === 0) return true
  const files = config.identityFiles.length
    ? config.identityFiles
    : ["id_ed25519", "id_ecdsa", "id_rsa", "id_ed25519_sk", "id_ecdsa_sk"].map((n) => join(homedir(), ".ssh", n))
  return files.some((f) => existsSync(f))
}

/**
 * Explain why every SSH attempt failed, naming the users tried and the cause that was actually
 * established — a route problem, no key on this machine, or a refusal — instead of asserting one.
 */
export function describeSshFailure(
  host: string,
  attempts: SshAttempt[],
  ctx: { defaultUser: string | null; keyFound: boolean },
): string {
  const label = (u: string | null) => u ?? (ctx.defaultUser ? `${ctx.defaultUser} (ssh default)` : "(ssh default)")
  const tried = attempts.map((a) => label(a.user)).join(", ") || "(none)"
  const last = attempts.at(-1)?.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""
  const someUser = attempts.find((a) => a.user)?.user ?? "<remote-user>"

  if (attempts.some((a) => isSshUnreachable(a.stderr))) {
    return (
      `Could not reach ${host} over SSH (${last}). This is a network problem, not a username or key problem: ` +
      `check that Tailscale is up on both machines and that SSH is enabled on the node (macOS: Remote Login).`
    )
  }
  if (!ctx.keyFound) {
    return (
      `No SSH key was found on this machine (none in ssh-agent, and none of ssh's identity files exist), ` +
      `so no username can work. Create one with: ssh-keygen -t ed25519 — then authorize it on the node: ` +
      `iris hive ssh-setup ${someUser}@${host}. Tried user(s): ${tried}.`
    )
  }
  if (attempts.length && attempts.every((a) => isSshAuthRefused(a.stderr))) {
    return (
      `${host} refused SSH for every user tried: ${tried}. This machine has a key, so either the remote ` +
      `username is wrong or this key is not authorized for it. The node's username is its own login name, ` +
      `usually not your IRIS account name — pass it with --user <name> (remembered after the first success). ` +
      `If the username is right, authorize this key: iris hive ssh-setup ${someUser}@${host}.`
    )
  }
  return `Could not open an SSH session to ${host}. Tried user(s): ${tried}. ssh said: ${last || "(nothing)"}`
}

/** A user remembered for this address in ~/.iris/hive-ssh.json by an earlier successful fs/doctor run. */
export async function rememberedUserForHost(host: string): Promise<string | null> {
  const cache = await readSshCache()
  const users = new Set(
    Object.values(cache)
      .filter((e) => e.host === host && e.user)
      .map((e) => e.user as string),
  )
  // Two nodes remembering different users for one address is a contradiction — don't pick one.
  return users.size === 1 ? [...users][0] : null
}

/** sha256 of a local file. */
export async function sha256Local(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash("sha256").update(buf).digest("hex")
}

/**
 * sha256 of a file on the node. macOS ships `shasum`, most Linux ships `sha256sum` — try
 * both rather than assuming the node is a Mac.
 */
export async function sha256Remote(t: SshTarget, remotePath: string): Promise<string | null> {
  const p = shqPath(remotePath)
  const r = await sshRun(t, `if command -v shasum >/dev/null 2>&1; then shasum -a 256 ${p}; else sha256sum ${p}; fi`)
  if (!r.ok) return null
  const m = /^([0-9a-f]{64})\b/m.exec(r.stdout.trim())
  return m ? m[1] : null
}

/**
 * Classify a remote failure so a permission refusal is never reported as a missing file.
 *
 * This distinction is the whole point of #182007: "Operation not permitted" on a TCC-protected
 * path means the ssh session lacks a privacy grant, which is a completely different problem
 * from the path not existing — and the wrong one sends people looking for a file that is
 * sitting right there.
 */
export function classifyRemoteError(stderr: string): { kind: "tcc" | "missing" | "denied" | "other"; hint: string } {
  const s = stderr.toLowerCase()
  if (s.includes("operation not permitted")) {
    return {
      kind: "tcc",
      hint:
        "macOS refused this path to the ssh session (TCC). The file may well exist and be readable by the daemon in the GUI session. ssh has its own privacy grants; granting Full Disk Access to the daemon does not grant it to sshd. See #182007.",
    }
  }
  if (s.includes("no such file") || s.includes("not found")) return { kind: "missing", hint: "The path does not exist on that node." }
  if (s.includes("permission denied")) return { kind: "denied", hint: "Unix permissions refused this path (not TCC)." }
  return { kind: "other", hint: stderr.trim().slice(0, 300) }
}

export interface TransferOutcome {
  ok: boolean
  localPath: string
  remotePath: string
  bytes: number
  sha256: string | null
  remoteSha256: string | null
  verified: boolean
  error?: string
}

/**
 * Parse the available 1K blocks from POSIX `df -Pk` output.
 *
 * Read as the column just before Capacity ("NN%"), not as field 4: a filesystem name can contain
 * spaces (macOS `map auto_home`, SMB shares), which shifts every column after it.
 */
export function parseAvailableBytes(output: string): number | null {
  const lines = output.trim().split(/\r?\n/)
  const fields = lines.at(-1)?.trim().split(/\s+/) ?? []
  const capacity = fields.findIndex((f, i) => i >= 4 && /^\d+%$/.test(f))
  if (capacity < 0 || !/^\d+$/.test(fields[capacity - 1])) return null
  const blocks = Number(fields[capacity - 1])
  return Number.isSafeInteger(blocks * 1024) ? blocks * 1024 : null
}

/** Free space a push must leave behind. Filling a disk to zero breaks the node, not just the copy. */
export const PUSH_FREE_SPACE_RESERVE_BYTES = 100 * 1024 * 1024

export function destinationSpaceError(bytes: number, dfOutput: string | null): string | null {
  const availableBytes = dfOutput === null ? null : parseAvailableBytes(dfOutput)
  if (availableBytes === null) return "could not verify free space on destination; refusing to push"
  if (availableBytes < bytes + PUSH_FREE_SPACE_RESERVE_BYTES) {
    return (
      `not enough free space on destination: ${availableBytes} bytes available, ${bytes} bytes required ` +
      `plus ${PUSH_FREE_SPACE_RESERVE_BYTES} bytes kept free`
    )
  }
  return null
}

export async function checkRemoteFreeSpace(t: SshTarget, remoteDir: string, bytes: number): Promise<string | null> {
  const space = await sshRun(t, `df -Pk ${shqPath(remoteDir)}`)
  const error = destinationSpaceError(bytes, space.ok ? space.stdout : null)
  return error ? `${error} (${remoteDir})` : null
}

export function localRegularFileSize(localPath: string): { size: number } | { error: string } {
  try {
    const stat = statSync(localPath)
    if (!stat.isFile()) return { error: `not a regular file: ${localPath} (directory pushes are not supported)` }
    return { size: stat.size }
  } catch (e: any) {
    return { error: `cannot inspect local path: ${String(e?.message ?? e)}` }
  }
}

/**
 * Copy one file OFF a node, staging through /tmp, and verify sha256 at BOTH ends.
 *
 * The verification is not decoration. A transfer through the Hive transport returned
 * PTY-corrupted bytes that looked plausible, and nothing in the output said so. A checksum
 * computed on the node and again here is the difference between "it copied" and "it copied
 * correctly" — so a mismatch is a hard failure, not a warning.
 */
export async function pullFile(t: SshTarget, remotePath: string, outDir: string): Promise<TransferOutcome> {
  const stage = `/tmp/iris-hive-${randomUUID()}`
  const name = basename(remotePath)
  const localPath = join(outDir, name)

  const staged = await sshRun(t, `mkdir -p ${shq(stage)} && cp ${shqPath(remotePath)} ${shq(stage + "/" + name)}`)
  if (!staged.ok) {
    const c = classifyRemoteError(staged.stderr)
    return {
      ok: false, localPath, remotePath, bytes: 0, sha256: null, remoteSha256: null, verified: false,
      error: `${c.kind === "tcc" ? "REFUSED BY macOS PRIVACY (TCC)" : "could not stage the file"}: ${c.hint}`,
    }
  }

  const remoteSha = await sha256Remote(t, stage + "/" + name)

  try {
    await mkdir(outDir, { recursive: true })
    await pexec("scp", [...SSH_BASE, `${dest(t)}:${stage}/${name}`, localPath], { timeout: 300_000 })
  } catch (e: any) {
    await sshRun(t, `rm -rf ${shq(stage)}`)
    return {
      ok: false, localPath, remotePath, bytes: 0, sha256: null, remoteSha256: remoteSha, verified: false,
      error: `scp failed: ${String(e?.stderr ?? e?.message ?? e).trim().slice(0, 300)}`,
    }
  }

  await sshRun(t, `rm -rf ${shq(stage)}`)

  const localSha = await sha256Local(localPath)
  const bytes = (await readFile(localPath)).length
  const verified = remoteSha !== null && remoteSha === localSha

  return {
    ok: verified,
    localPath, remotePath, bytes,
    sha256: localSha, remoteSha256: remoteSha, verified,
    error: verified
      ? undefined
      : remoteSha === null
        ? "could not compute a checksum on the node, so this transfer is UNVERIFIED"
        : `CHECKSUM MISMATCH — node ${remoteSha.slice(0, 12)}… vs local ${localSha.slice(0, 12)}…. The file that arrived is not the file that was sent.`,
  }
}

/** Copy one file ON to a node, then verify sha256 at both ends. */
export async function pushFile(t: SshTarget, localPath: string, remoteDir: string): Promise<TransferOutcome> {
  const name = basename(localPath)
  const remotePath = `${remoteDir.replace(/\/$/, "")}/${name}`

  if (!existsSync(localPath)) {
    return { ok: false, localPath, remotePath, bytes: 0, sha256: null, remoteSha256: null, verified: false, error: `no such local file: ${localPath}` }
  }

  const localFile = localRegularFileSize(localPath)
  if ("error" in localFile) {
    return { ok: false, localPath, remotePath, bytes: 0, sha256: null, remoteSha256: null, verified: false, error: localFile.error }
  }

  const bytes = localFile.size
  const localSha = await sha256Local(localPath)

  const mk = await sshRun(t, `mkdir -p ${shqPath(remoteDir)}`)
  if (!mk.ok) {
    const c = classifyRemoteError(mk.stderr)
    return { ok: false, localPath, remotePath, bytes, sha256: localSha, remoteSha256: null, verified: false, error: `could not create ${remoteDir}: ${c.hint}` }
  }

  const spaceError = await checkRemoteFreeSpace(t, remoteDir, bytes)
  if (spaceError) {
    return { ok: false, localPath, remotePath, bytes, sha256: localSha, remoteSha256: null, verified: false, error: spaceError }
  }

  try {
    await pexec("scp", [...SSH_BASE, localPath, `${dest(t)}:${remotePath}`], { timeout: 300_000 })
  } catch (e: any) {
    return { ok: false, localPath, remotePath, bytes, sha256: localSha, remoteSha256: null, verified: false, error: `scp failed: ${String(e?.stderr ?? e?.message ?? e).trim().slice(0, 300)}` }
  }

  const remoteSha = await sha256Remote(t, remotePath)
  const verified = remoteSha !== null && remoteSha === localSha

  return {
    ok: verified,
    localPath, remotePath, bytes,
    sha256: localSha, remoteSha256: remoteSha, verified,
    error: verified
      ? undefined
      : remoteSha === null
        ? "could not compute a checksum on the node, so this transfer is UNVERIFIED"
        : `CHECKSUM MISMATCH — local ${localSha.slice(0, 12)}… vs node ${remoteSha.slice(0, 12)}…. What landed is not what was sent.`,
  }
}
