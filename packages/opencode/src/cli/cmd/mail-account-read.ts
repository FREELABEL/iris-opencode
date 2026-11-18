/**
 * Which Mac an `iris mail inbox|search|read` answers from (#189480).
 *
 * Two Macs hold different mailboxes, and the same account name is a different mailbox on each. The
 * bridge-call rail cannot pin a node (the gateway takes the first ready one), so it can only answer
 * honestly when there is exactly one Mac it could reach. Two rules follow:
 *
 *   --mail-account <address>  this Mac first, else the online node whose heartbeat lists the address
 *                             (comms-mail-route, the same routing as comms ingest), read there with
 *                             a task pinned to that node and bound to that account's id.
 *   no --mail-account         over Hive, refuse when more than one online Mac has Mail, and list them.
 *                             Reading each and merging was the alternative: it means opening every
 *                             account on every Mac (a whose-clause over many mailboxes can peg Mail
 *                             for minutes), for an answer nobody asked for, and the rail still could
 *                             not reach a chosen node. Refusing is one sentence and cannot mislead.
 *
 * A message id is one Mac's own number, so by-id reads never leave this machine.
 */
import { execFile } from "node:child_process"
import { gunzipSync } from "node:zlib"
import { MAIL_INBOX_READER_JXA, mailResponsive } from "./comms-mail-applescript"
import {
  locateMailAccount,
  nodeMailAccounts,
  online,
  remoteOsascript,
  resolveMailAccount,
  type AppleMailReadDeps,
  type RoutableNode,
} from "./comms-mail-route"
import type { MailVia, RemoteResult } from "./mail-transport"

export interface MailAccountQuery {
  days: number
  from: string
  subject?: string
  limit: number
  /** 0 or absent: envelopes only. */
  maxBody?: number
}

export type RawRead = { ok: true; stdout: string } | { ok: false; reason: string }

export type MailAccountDeps = AppleMailReadDeps & { runLocalReader: (argv: string[]) => Promise<RawRead> }

export type MailAccountAnswer = { ok: true; data: { emails: any[] }; where: string } | { ok: false; reason: string }

export function inboxReaderArgs(selector: string, q: MailAccountQuery): string[] {
  return ["-l", "JavaScript", "-e", MAIL_INBOX_READER_JXA, String(q.days), selector, q.from, q.subject ?? "", String(q.limit), String(q.maxBody ?? 0)]
}

/** Read `spec`'s mailbox where it lives. Never falls through to another Mac's mail. */
export async function readMailAccount(spec: string, q: MailAccountQuery, via: MailVia, deps: MailAccountDeps): Promise<MailAccountAnswer> {
  let place: { node: RoutableNode | null; selector: string; address: string | null }
  if (via === "local") {
    if (deps.platform !== "darwin") return { ok: false, reason: `--via local reads this machine, which is not a Mac (${deps.platform}). Drop --via to find the node that has ${spec}.` }
    const local = await deps.listLocal()
    if (!local.ok) return { ok: false, reason: `this Mac: ${local.reason}` }
    const r = resolveMailAccount(local.accounts, spec)
    if (!r.ok) return { ok: false, reason: `${r.reason}. --via local does not look on other Macs; drop it to route to the node that has it.` }
    place = { node: null, selector: r.account.id ? `id:${r.account.id}` : r.account.name, address: r.address }
  } else {
    // --via hive skips the "this Mac first" step; everything else is the same route as comms ingest.
    const located = await locateMailAccount(spec, q.days, via === "hive" ? { ...deps, platform: "hive" } : deps)
    if (!located.ok) return { ok: false, reason: located.reason }
    place = located
  }

  const label = place.address ?? spec
  const argv = inboxReaderArgs(place.selector, q)
  let out: RawRead
  if (place.node) {
    const node = place.node
    try {
      const r = await deps.runRemote(node, remoteOsascript(argv))
      if (r.exit_code && r.exit_code !== 0) {
        const why = String(r.stderr || r.stdout || "").replace(/\s+/g, " ").trim().slice(-240)
        return { ok: false, reason: `Mail.app read on ${node.name} failed (exit ${r.exit_code}): ${why}` }
      }
      out = { ok: true, stdout: gunzipRemote(r.stdout, r.stdout_truncated) }
    } catch (e: any) {
      return { ok: false, reason: `could not read ${label} on ${node.name}: ${String(e?.message ?? e).slice(0, 200)}` }
    }
  } else {
    out = await deps.runLocalReader(argv)
    if (!out.ok) return { ok: false, reason: out.reason }
  }

  const where = place.node?.name ?? "this Mac"
  try {
    const parsed = JSON.parse(out.stdout)
    if (parsed.no_inbox) return { ok: false, reason: `${label} has no INBOX mailbox on ${where}, so it could not be read (this is not an empty inbox)` }
    const emails = (parsed.emails ?? []).map((row: any) => ({ ...row, node: where, account: label }))
    return { ok: true, data: { emails }, where: place.node ? `Hive node ${where}, which has ${label}` : `this Mac, ${label}` }
  } catch (e: any) {
    return { ok: false, reason: `${where}: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}

function gunzipRemote(stdout: string, truncated?: boolean): string {
  if (truncated) throw new Error("the answer was larger than the Hive task output limit (50 KB) — lower --limit, --days or --max-body")
  return gunzipSync(Buffer.from(stdout.replace(/\s+/g, ""), "base64")).toString("utf8")
}

/** Online Macs with Mail, and what each reports holding. */
export function onlineMailNodes(nodes: RoutableNode[], now = Date.now()) {
  return nodes
    .filter((n) => online(n, now) && n.bridge_capabilities?.apple_mail && n.bridge_capabilities.apple_mail.available !== false)
    .map((node) => {
      const r = nodeMailAccounts(node)
      return { node, holds: "unknown" in r ? r.unknown : r.accounts.flatMap((a) => a.addresses).join(", ") || "no accounts" }
    })
}

/**
 * A Hive read with no account named. Only asks the gateway when it can reach a single Mac, and
 * throws away an answer from any other node: the gateway does the picking, so check what it picked.
 */
export async function singleMacCall(
  listNodes: () => Promise<RoutableNode[]>,
  call: () => Promise<RemoteResult>,
  now = Date.now(),
): Promise<RemoteResult & { nodeName?: string }> {
  let nodes: RoutableNode[]
  try {
    nodes = await listNodes()
  } catch (e: any) {
    return { ok: false, error: `could not list Hive nodes, so cannot tell which Mac would answer: ${String(e?.message ?? e).slice(0, 160)}. Name the mailbox: --mail-account <address>` }
  }
  const macs = onlineMailNodes(nodes, now)
  if (macs.length > 1) {
    return {
      ok: false,
      code: "several_macs",
      error:
        `${macs.length} online Macs have Apple Mail and each is a different mailbox, so IRIS will not pick one. ` +
        `Say which with --mail-account <address>. Online: ${macs.map((m) => `${m.node.name} (${m.holds})`).join("; ")}`,
    }
  }
  const r = await call()
  if (!r.ok) return r
  const only = macs[0]?.node
  if (only && r.nodeId && r.nodeId !== only.id) {
    return { ok: false, code: "wrong_node", error: `the gateway answered from a different node than ${only.name}, the only Mac reporting Mail, so that answer was discarded. Name the mailbox: --mail-account <address>` }
  }
  return { ...r, nodeName: only?.name }
}

const READ_BY_SENDER = (spec?: string) => `read by sender instead: iris mail read <sender> --mail-account ${spec ?? "<address>"}`

/**
 * Why a by-id read must not run, or null when this Mac's own bridge may answer it. Ids are per-Mac
 * and the rail cannot pin a node, so over Hive the same number could be another mailbox's message.
 */
export function readByIdRefusal(a: { platform: string; via: MailVia; mailAccount?: string }): string | null {
  const why = "A message id is one Mac's own number and only this machine's bridge can be asked for it"
  if (a.mailAccount) return `${why}, so an id cannot be combined with --mail-account. ${READ_BY_SENDER(a.mailAccount)}`
  if (a.via === "hive") return `${why}, so an id cannot be read over Hive: it could open a different message in a different mailbox. ${READ_BY_SENDER()}`
  if (a.platform !== "darwin") return `${why}, and this machine is not a Mac (${a.platform}). ${READ_BY_SENDER()}`
  return null
}

/** Added when this Mac's bridge could not answer a by-id read. */
export function readByIdFailureHint(error: string): string | null {
  if (!/\b404\b|not found|cannot get/i.test(error) || /Envelope Index/i.test(error)) return null
  return `this Mac's daemon has no read-by-id yet (it needs iris-daemon #28). ${READ_BY_SENDER()}`
}

/** What to print instead of a blank that looks like an empty email. */
export function missingBodyNote(a: { query: string; where: string; bodyError?: string; readThroughAccount: boolean }): string {
  if (a.readThroughAccount) return a.bodyError ? `(body unavailable: ${a.bodyError})` : "(this email has no body text)"
  return (
    `(no body returned, which does not mean the email is empty: ${a.where === "this machine" ? "this Mac's" : "that node's"} daemon lists envelopes only, ` +
    `and reading a body through it needs iris-daemon #28 and fl-iris-api #119. ` +
    `Read it from Mail.app: iris mail read ${JSON.stringify(a.query)} --mail-account <address>)`
  )
}

/** A row's id only means something on this machine. Elsewhere, drop it so nothing offers it. */
export function rowsForDisplay<T extends { id?: unknown }>(rows: T[], where: string): T[] {
  if (where === "this machine") return rows
  return rows.map(({ id: _id, ...rest }) => rest as T)
}

/** The footer's next step: only offer what will work on the rows shown. */
export function readHint(rows: { id?: unknown; sender?: string }[], mailAccount?: string): string {
  if (rows.some((r) => r.id != null)) return "read one: iris mail read <id>"
  return `read one: iris mail read <sender> --mail-account ${mailAccount ?? "<address>"}`
}

/** The real local run. Never launches Mail, and never queues behind a busy one. */
export async function runLocalInboxReader(argv: string[], timeoutMs = 120000): Promise<RawRead> {
  if (!(await mailResponsive())) {
    return { ok: false, reason: "Mail.app is not answering (not running, or still busy with an earlier request) — not queuing more work behind it; try again in a few minutes" }
  }
  return new Promise((resolve) => {
    execFile("osascript", argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout) })
      const msg = String(stderr || err.message).replace(/\s+/g, " ").trim().slice(0, 240)
      const hint = /-1743|not authori[sz]ed/i.test(msg) ? " — grant this terminal Automation access to Mail (System Settings → Privacy & Security → Automation)" : ""
      resolve({ ok: false, reason: `Mail.app read failed: ${msg}${hint}` })
    })
  })
}
