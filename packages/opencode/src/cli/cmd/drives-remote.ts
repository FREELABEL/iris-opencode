/**
 * `iris drives get` from a drive plugged into ANOTHER of your machines (#193362, epic #192914 slice 3).
 *
 *   iris drives get "Studio:Stems/kick.wav" --to ~/Desktop --why "mixdown"            # finds the machine
 *   iris drives get "Studio:Stems/kick.wav" --to ~/Desktop --why "mixdown" --from studio-mac
 *
 * How it works, end to end:
 *   1. The checks that need no drive run HERE first: --why, the drive is cataloged, the path is not
 *      inside a private folder, a sensitive file has --confirm. A refusal never contacts a machine.
 *   2. Which machine: --from, or the drive record's `last_seen_on` machine first, then your other
 *      machines that are online. A folder "drive" (dir:<host>:<path>) lives on one machine only, so
 *      only that machine is asked. This machine is never asked (it already said "not connected").
 *   3. The live check IS the request: over ssh on Tailscale (the same channel as `iris hive fs`), the
 *      machine runs `iris drives serve`, which re-reads the catalog from Atlas and does everything a
 *      local `get` does — resolve the drive, refuse private folders (and links into them), refuse a
 *      sensitive file without --confirm, zip a bundle — then answers with one JSON line: not
 *      connected here (2), moved since scan (3), refused (1), or ready + the sha256 of the original.
 *   4. The bytes come back peer to peer over ssh/scp (`pullFile`, sha256-checked at both ends) and
 *      are checked AGAIN here against the sha256 the serving machine took of the original (for a
 *      bundle: the bundle hash of what is inside the zip). They never pass through our servers.
 *   5. One `drive-reads` row, written by this machine once the copy checks out: read_on = this
 *      machine, served_by = the machine that held the drive. Not on the record → not kept.
 *
 * Why ssh and not `iris hive run`: the Hive task transport is not byte-safe and merges
 * stdout/stderr (see hive-tailscale.ts), and a queued task to an online node can expire unrun
 * (#193063). ssh gives a real exit code, separated output and a byte-safe channel.
 */

import fs from "fs"
import path from "path"
import {
  nameMatches, shq, sshRun, pullFile, resolveSshTarget, ensureSshUser, isSshUnreachable, type SshTarget,
} from "./hive-tailscale"
import { pickNode, looksAlive, type HiveNode } from "./platform-hive-nodes"
import { SENSITIVE, kindOf, utcIso, sha256File } from "./drives-core"
import { resolveRef, insidePrivate, zipBundleHash, formatSize, GET_EXIT, type GetDeps, type GetResult } from "./platform-drives"

/** The line `iris drives serve` prints. Anything else on stdout (banners, update notices) is ignored. */
export const SERVE_MARK = "IRIS_DRIVES_SERVE "

export type ServeReply = {
  ok: boolean
  code: number
  error?: string
  /** the file to fetch on the serving machine: the original, or the bundle's .zip in `stage` */
  file?: string
  /** a temporary folder on the serving machine to delete once fetched (bundles only) */
  stage?: string | null
  drive_id?: string
  drive_label?: string
  path?: string
  bytes?: number
  /** sha256 of the original file, or the bundle hash */
  sha256?: string
  /** sha256 of `file` itself — equal to sha256 for a plain file, the .zip's hash for a bundle */
  file_sha256?: string
  bundle?: boolean
  host?: string
}

export function parseServeReply(stdout: string): ServeReply | null {
  const lines = String(stdout ?? "").split("\n").filter((l) => l.startsWith(SERVE_MARK))
  if (!lines.length) return null
  try {
    const r = JSON.parse(lines[lines.length - 1].slice(SERVE_MARK.length))
    return r && typeof r === "object" && typeof r.code === "number" ? r : null
  } catch {
    return null
  }
}

export type ServeRequest = { driveId: string; rel: string; why: string; confirm: boolean; bloq: number; asker: string }

/**
 * The command run on the serving machine. `iris` is often not on a non-interactive ssh PATH, so
 * the installed one is used first. IRIS_DRIVES_REMOTE_IRIS (set on the ASKING machine) names
 * another binary on the serving machine — a custom install, or a build under test.
 */
export function serveCommand(req: ServeRequest, irisBin = process.env.IRIS_DRIVES_REMOTE_IRIS): string {
  const bin = irisBin
    ? `IRIS=${shq(irisBin)}`
    : 'IRIS="$HOME/.iris/bin/iris"; [ -x "$IRIS" ] || IRIS="$(command -v iris)"'
  return (
    `${bin}; "$IRIS" drives serve ${shq(`${req.driveId}:${req.rel}`)} --why ${shq(req.why)} --bloq ${Math.trunc(req.bloq)}` +
    ` --for ${shq(req.asker)}${req.confirm ? " --confirm" : ""}`
  )
}

export type NodeLike = Pick<HiveNode, "id" | "name" | "connection_status" | "last_heartbeat_at"> & { tailscale_ip?: string | null }

/** The one machine a folder "drive" can be on: dir:<host>:<path>. null for a real drive. */
export function folderHost(driveId: string): string | null {
  if (!driveId.startsWith("dir:")) return null
  const rest = driveId.slice(4)
  const i = rest.indexOf(":")
  return i > 0 ? rest.slice(0, i) : null
}

/**
 * Which machines to ask, in order. Never this machine. A re-registered machine keeps its name, so
 * each name is asked once (online first, then the freshest heartbeat — pickNode's rule).
 */
export function servingCandidates(drive: any, nodes: NodeLike[], self: string, now = Date.now()): NodeLike[] {
  const others = nodes.filter((n) => !nameMatches(n.name, self))
  const best = (match: (n: NodeLike) => boolean) => {
    const hits = others.filter(match)
    return hits.length ? (pickNode(hits as HiveNode[], hits[0].name).node as NodeLike | null) : null
  }
  const host = folderHost(String(drive.external_id ?? ""))
  if (host) {
    const n = best((x) => nameMatches(x.name, host))
    return n ? [n] : []
  }
  const out: NodeLike[] = []
  const lastSeen = String(drive.last_seen_on ?? "").trim()
  const first = lastSeen ? best((x) => nameMatches(x.name, lastSeen)) : null
  if (first) out.push(first)
  const names = new Set(out.map((n) => n.name.toLowerCase()))
  for (const n of others) {
    if (names.has(n.name.toLowerCase()) || !looksAlive(n as HiveNode, now)) continue
    names.add(n.name.toLowerCase())
    out.push(best((x) => x.name.toLowerCase() === n.name.toLowerCase())!)
  }
  return out
}

export type AskOutcome =
  | { kind: "reply"; reply: ServeReply }
  /** ssh could not reach it: offline, asleep, or not on the tailnet */
  | { kind: "offline"; error: string }
  /** reached, but IRIS there could not answer (missing, too old, signed out) */
  | { kind: "unable"; error: string }

export type Pulled = { ok: boolean; localPath: string; sha256: string | null; error?: string }

export type RemoteGetDeps = Omit<GetDeps, "resolveMount"> & {
  nodes: () => Promise<NodeLike[]>
  ask: (node: NodeLike, req: ServeRequest) => Promise<AskOutcome>
  pull: (node: NodeLike, remoteFile: string, localDir: string) => Promise<Pulled>
  cleanup: (node: NodeLike, stage: string) => Promise<void>
  bundleHash?: (zip: string) => Promise<{ sha256: string; members: number }>
}

export type RemoteGetArgs = { ref: string; to: string; why?: string; confirm?: boolean; from?: string; bloq: number }
export type RemoteGetResult = GetResult & { served_by?: string }

const lastSeenText = (d: any) =>
  d.last_seen_on ? `It was last seen on ${d.last_seen_on}${d.last_seen_at ? ` (${String(d.last_seen_at).slice(0, 16).replace("T", " ")} UTC)` : ""}.` : "It has not been seen on any machine yet."

export async function runRemoteGet(a: RemoteGetArgs, deps: RemoteGetDeps): Promise<RemoteGetResult> {
  const out: string[] = []
  const err: string[] = []
  const fail = (code: number, msg: string, extra: Partial<RemoteGetResult> = {}): RemoteGetResult => {
    err.push(msg)
    return { code, out, err, ...extra }
  }
  const why = String(a.why ?? "").trim()
  if (!why) return fail(GET_EXIT.refused, '--why is required: say why you are reading this file, e.g. --why "send the brief to the client". It goes on the record.')

  let drives: any[]
  try {
    drives = await deps.drives()
  } catch (e: any) {
    return fail(1, `Could not read your drives from your account (${e?.message ?? e}). Nothing was read.`)
  }
  const labels: Record<string, string> = Object.fromEntries(drives.map((d) => [String(d.external_id), String(d.label ?? d.external_id)]))
  const [driveId, rawRel] = resolveRef(String(a.ref), labels)
  const drive = drives.find((d) => String(d.external_id) === driveId)
  if (!drive) return fail(1, `${driveId} is not a cataloged drive. See your drives with: iris drives list`)
  const name = labels[driveId]
  const excludes = String(drive.private_excluded ?? "").split("\n").filter((x) => x.trim())

  // Everything that can be refused without the drive is refused before any machine is contacted.
  const rel = path.posix.normalize(rawRel.replace(/^\/+/, ""))
  if (!rawRel || rel === "." || rel === ".." || rel.startsWith("../")) return fail(1, `Give a file inside the drive: iris drives get "${name}:<path>" (paths come from iris drives find)`)
  const privateMsg = (p: string) => `${p} is inside a private folder on ${name}. Private folders are never opened, so it cannot be read.`
  if (insidePrivate(rel, excludes)) return fail(1, privateMsg(rel))
  let findings: any[]
  try {
    findings = await deps.findings(driveId)
  } catch (e: any) {
    return fail(1, `Could not check whether ${rel} is a sensitive file (${e?.message ?? e}). Nothing was read.`)
  }
  const finding = findings.find((f) => f?.path === rel && f?.status !== "moved")
  const sensitiveKind = finding?.kind ?? (SENSITIVE.has(kindOf(rel)) ? kindOf(rel) : null)
  if (sensitiveKind && !a.confirm)
    return fail(
      1,
      `${rel} is a sensitive file (${sensitiveKind}) on ${name}${drive.encrypted ? "" : ", and that drive is NOT encrypted"}.\n` +
        `Copying it puts a second copy on this computer. If you mean to, add --confirm. The read is recorded either way.`,
    )

  let nodes: NodeLike[]
  try {
    nodes = await deps.nodes()
  } catch (e: any) {
    return fail(1, `Could not list your machines (${e?.message ?? e}). Nothing was read.`)
  }
  let candidates: NodeLike[]
  if (a.from) {
    const picked = pickNode(nodes as HiveNode[], a.from).node as NodeLike | null
    if (!picked) return fail(1, `None of your machines is called "${a.from}". See them with: iris hive nodes list`)
    candidates = [picked]
  } else {
    candidates = servingCandidates(drive, nodes, deps.host)
  }
  if (!candidates.length)
    return fail(GET_EXIT.notConnected, `${name} is not connected to this computer, and none of your other machines can have it. ${lastSeenText(drive)}`)

  const req: ServeRequest = { driveId, rel, why, confirm: a.confirm === true, bloq: a.bloq, asker: deps.host }
  const offline: Array<[string, string]> = []
  const unable: Array<[string, string]> = []
  const notHere: string[] = []
  let node: NodeLike | null = null
  let reply: ServeReply | null = null
  for (const n of candidates) {
    const o = await deps.ask(n, req)
    if (o.kind === "offline") { offline.push([n.name, o.error]); continue }
    if (o.kind === "unable") { unable.push([n.name, o.error]); continue }
    const r = o.reply
    if (r.code === 0 && r.file) { node = n; reply = r; break }
    if (r.code === GET_EXIT.notConnected) { notHere.push(n.name); continue }
    // Moved since the scan, or refused (private / sensitive / a folder) by the machine that has it.
    return fail(r.code || 1, `${n.name}: ${r.error || "refused the read"}`)
  }

  if (!node || !reply) {
    const lastSeen = String(drive.last_seen_on ?? "")
    const off = offline.find(([n]) => a.from || (lastSeen && nameMatches(n, lastSeen))) ?? (notHere.length || unable.length ? null : offline[0])
    if (off)
      return fail(
        GET_EXIT.nodeOffline,
        `${off[0]} is not answering (offline, asleep, or not reachable over Tailscale), so ${name} cannot be read from it. Nothing was read.` +
          (a.from ? "" : ` ${lastSeenText(drive)}`) + `\n  ${off[1].split("\n")[0]}`,
      )
    if (unable.length && !notHere.length)
      return fail(
        1,
        unable.map(([n, e]) => `IRIS on ${n} could not serve the read (${e.split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "no answer"}). Update it there: iris update`).join("\n"),
      )
    const asked = [...notHere, ...unable.map(([n]) => n), ...offline.map(([n]) => n)]
    return fail(
      GET_EXIT.notConnected,
      a.from
        ? `${name} is not connected to ${a.from}. ${lastSeenText(drive)}`
        : `${name} is not connected to any of your machines (asked: this computer, ${asked.join(", ")}). ${lastSeenText(drive)}`,
    )
  }

  // The serving machine re-resolved the path (links included); hold it to the same rule here.
  const realRel = String(reply.path ?? rel)
  const cleanupStage = async () => { if (reply!.stage) await deps.cleanup(node!, reply!.stage).catch(() => {}) }
  if (insidePrivate(realRel, excludes)) { await cleanupStage(); return fail(1, privateMsg(realRel)) }

  const to = path.resolve(a.to)
  fs.mkdirSync(to, { recursive: true })
  const dest = path.join(to, path.posix.basename(realRel) + (reply.bundle ? ".zip" : ""))
  if (fs.existsSync(dest)) { await cleanupStage(); return fail(1, `${dest} already exists — not overwritten. Choose another --to.`) }

  // Land it in a private folder beside the destination, check it, then move it into place.
  const landing = fs.mkdtempSync(path.join(to, ".iris-get-"))
  const hash = deps.hashFile ?? sha256File
  try {
    const p = await deps.pull(node, String(reply.file), landing)
    if (!p.ok) {
      const mismatch = /checksum mismatch|unverified/i.test(p.error ?? "")
      return fail(mismatch ? GET_EXIT.mismatch : 1, `Fetching ${realRel} from ${node.name} failed: ${p.error ?? "unknown error"}. Nothing was kept or recorded.`)
    }
    const got = p.sha256 ?? hash(p.localPath)
    const want = reply.file_sha256 ?? reply.sha256
    let ok = got === want
    if (ok && reply.bundle) {
      const back = await (deps.bundleHash ?? zipBundleHash)(p.localPath)
      ok = back.sha256 === reply.sha256
    }
    if (!ok)
      return fail(
        GET_EXIT.mismatch,
        `The copy of ${realRel} that arrived from ${node.name} does not match the original (sha256). It was deleted; nothing was recorded. Try again.`,
      )
    if (fs.existsSync(dest)) return fail(1, `${dest} already exists — not overwritten. Choose another --to.`)
    fs.renameSync(p.localPath, dest)
  } finally {
    fs.rmSync(landing, { recursive: true, force: true })
    await cleanupStage()
  }

  const bytes = Number(reply.bytes ?? fs.statSync(dest).size)
  const at = utcIso(deps.now())
  const row = {
    external_id: `${driveId}:${realRel}:${at}`, drive_id: driveId, drive_label: name, path: realRel, bytes, sha256: String(reply.sha256),
    read_by: await deps.account().catch(() => "unknown"), read_on: deps.host, served_by: node.name, purpose: why, at,
  }
  try {
    await deps.ensureReadsDataset()
    const r = await deps.writeAudit([row])
    if (r.failed || r.created + r.updated !== 1) throw new Error(`created ${r.created} · updated ${r.updated} · failed ${r.failed}`)
  } catch (e: any) {
    fs.rmSync(dest, { force: true })
    return fail(1, `Could not record this read in your account (${e?.message ?? e}). The copy was removed. Check your connection and try again.`)
  }
  out.push(`Copied ${realRel} from ${name} on ${node.name} → ${dest}`)
  out.push(`  ${formatSize(bytes)} · sha256 ${row.sha256.slice(0, 16)}… verified end to end · sent machine to machine over your Hive (Tailscale) · recorded in your Drives board (Drive reads)`)
  return { code: 0, out, err, dest, row, served_by: node.name }
}

/** The real remote layer: ssh over Tailscale, the same path `iris hive fs` takes. */
export function liveRemoteDeps(fetchNodes: () => Promise<NodeLike[]>): Pick<RemoteGetDeps, "nodes" | "ask" | "pull" | "cleanup"> {
  const targets = new Map<string, SshTarget>()
  return {
    nodes: fetchNodes,
    ask: async (node, req) => {
      const t = await resolveSshTarget(node.id, node.name, { advertised: node.tailscale_ip ?? null })
      if ("error" in t) return { kind: "offline", error: t.error }
      const u = await ensureSshUser(node.id, t)
      if ("error" in u) return { kind: "offline", error: u.error } // no ssh login at all: as good as offline from here
      targets.set(node.id, u)
      const r = await sshRun(u, serveCommand(req), 0) // hashing a large original takes as long as it takes
      const reply = parseServeReply(r.stdout)
      if (reply) return { kind: "reply", reply }
      if (r.code === 255 && isSshUnreachable(r.stderr)) return { kind: "offline", error: r.stderr.trim() }
      return { kind: "unable", error: (r.stderr || r.stdout || `exit ${r.code}`).trim() }
    },
    pull: async (node, remoteFile, localDir) => {
      const t = targets.get(node.id)
      if (!t) return { ok: false, localPath: "", sha256: null, error: "no connection to that machine" }
      const r = await pullFile(t, remoteFile, localDir)
      return { ok: r.ok, localPath: r.localPath, sha256: r.sha256, error: r.error }
    },
    cleanup: async (node, stage) => {
      const t = targets.get(node.id)
      // Only ever a folder `drives serve` made in the temp dir — never anything on the drive.
      if (t && /\/iris-drives-serve-[A-Za-z0-9]+$/.test(stage)) await sshRun(t, `rm -rf ${shq(stage)}`)
    },
  }
}
