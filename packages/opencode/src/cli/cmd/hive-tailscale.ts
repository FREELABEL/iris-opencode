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

import { execFile } from "child_process"
import { promisify } from "util"
import { createHash } from "crypto"
import { randomUUID } from "crypto"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
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
): Promise<SshTarget | { error: string }> {
  const candidates: (string | null)[] = []
  if (t.user) candidates.push(t.user)
  candidates.push(null) // let ssh_config decide — a Host entry may already name the user
  try {
    candidates.push(userInfo().username)
  } catch {
    /* ignore */
  }

  const tried: string[] = []
  for (const user of candidates) {
    const probe: SshTarget = { ...t, user }
    const r = await sshRun(probe, "true", 15_000)
    if (r.ok) {
      const cache = await readSshCache()
      cache[nodeId] = { host: t.host, ...(user ? { user } : {}) }
      await writeSshCache(cache)
      return probe
    }
    tried.push(user ?? "(ssh_config default)")
  }
  return {
    error:
      `Could not open an ssh session to ${t.host}. Tried: ${tried.join(", ")}. ` +
      `Pass --user <name> once and it will be remembered in ~/.iris/hive-ssh.json.`,
  }
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

  const localSha = await sha256Local(localPath)
  const bytes = (await readFile(localPath)).length

  const mk = await sshRun(t, `mkdir -p ${shqPath(remoteDir)}`)
  if (!mk.ok) {
    const c = classifyRemoteError(mk.stderr)
    return { ok: false, localPath, remotePath, bytes, sha256: localSha, remoteSha256: null, verified: false, error: `could not create ${remoteDir}: ${c.hint}` }
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
