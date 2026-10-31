/**
 * Which Mac has which mailbox, and reading it from there (#191879).
 *
 * 2026-10-30: Alex added team@heyiris.io to Apple Mail on one Mac. From another,
 * `iris comms ingest 30359 --channel apple_mail --mail-account team@heyiris.io` failed with
 * "Can't get object (-1728)": the reader looked the value up as a Mail.app account NAME
 * (`Mail.accounts.byName`), and no account is named that on the machine it ran on. Names are not
 * identities anyway — "Google" is manage.amrecords@gmail.com on the MacBook and alex@freelabel.net
 * on iris-hive-002. And nothing could say WHICH Mac held the mailbox; each had to be asked by hand.
 *
 * So:
 *   - `--mail-account` takes an ADDRESS (a name still works when it is unambiguous, and
 *     `id:<Mail account id>` always does), resolved against `email addresses of every account`.
 *   - each node's daemon reports its accounts in bridge_capabilities.apple_mail.accounts, and the
 *     read is routed to the node that has the address — this Mac first if it has it.
 *   - when no node has it, or the one that has it is offline, the error names every node checked
 *     and points at the Gmail path (#191878), because a Mail.app read only works while that Mac
 *     is on — it cannot be the only way replies get read.
 *
 * Everything that decides is pure and takes fixtures; the osascript and the Hive task are injected.
 */
import { gunzipSync } from "node:zlib"
import { execFile } from "node:child_process"
import { mailThreadReaderArgs, type MailThreadRead } from "./comms-mail-applescript"

export interface MailAccount {
  name: string
  id: string | null
  addresses: string[]
  enabled?: boolean
}

/** Same probe the daemon runs for its heartbeat: name, id, addresses, enabled — nothing else. */
export const MAIL_ACCOUNTS_JXA = `(() => {
  const a = Application("Mail").accounts
  const n = a.length
  if (n === 0) return "[]"
  const names = a.name(), ids = a.id(), addrs = a.emailAddresses(), en = a.enabled()
  const out = []
  for (let i = 0; i < n; i++) out.push({ name: names[i], id: ids[i], addresses: addrs[i] || [], enabled: en[i] })
  return JSON.stringify(out)
})()`

export function parseMailAccounts(stdout: string): MailAccount[] {
  const data = JSON.parse(String(stdout).trim())
  if (!Array.isArray(data)) throw new Error("Mail accounts probe did not return a list")
  return data
    .filter((a: any) => a && typeof a === "object" && typeof a.name === "string")
    .map((a: any) => ({
      name: a.name,
      id: a.id ? String(a.id) : null,
      addresses: (Array.isArray(a.addresses) ? a.addresses : []).map((x: any) => String(x).trim().toLowerCase()).filter((x: string) => x.includes("@")),
      enabled: a.enabled !== false,
    }))
}

export const isAddress = (s: string) => /^[^@\s<>]+@[^@\s<>]+$/.test(s.trim())

const describeAccounts = (accounts: MailAccount[]) =>
  accounts.length ? accounts.map((a) => `"${a.name}" (${a.addresses.join(", ") || "no address"})`).join(", ") : "none"

export type AccountResolution = { ok: true; account: MailAccount; address: string | null } | { ok: false; reason: string }

/**
 * Which ONE account `spec` means on a machine with these accounts.
 *   address  → the account whose addresses include it (case-insensitive). On two accounts → refused.
 *   id:<id>  → that account.
 *   name     → the account with that exact name, only if exactly one has it.
 */
export function resolveMailAccount(accounts: MailAccount[], spec: string, where = "this Mac"): AccountResolution {
  const s = spec.trim()
  if (s.startsWith("id:")) {
    const hit = accounts.find((a) => a.id === s.slice(3))
    return hit ? { ok: true, account: hit, address: hit.addresses[0] ?? null } : { ok: false, reason: `no Mail.app account with id ${s.slice(3)} on ${where}` }
  }
  if (isAddress(s)) {
    const addr = s.toLowerCase()
    const hits = accounts.filter((a) => a.addresses.includes(addr))
    if (hits.length === 1) return { ok: true, account: hits[0], address: addr }
    if (hits.length > 1) {
      return {
        ok: false,
        reason:
          `${addr} is on ${hits.length} Mail.app accounts on ${where}: ${hits.map((a) => `"${a.name}" (id:${a.id})`).join(", ")} — ` +
          `pick one with --mail-account id:<id>`,
      }
    }
    return { ok: false, reason: `no Mail.app account on ${where} has the address ${addr} (accounts there: ${describeAccounts(accounts)})` }
  }
  const named = accounts.filter((a) => a.name === s)
  if (named.length === 1) return { ok: true, account: named[0], address: named[0].addresses[0] ?? null }
  if (named.length > 1) {
    return {
      ok: false,
      reason: `${named.length} Mail.app accounts on ${where} are named "${s}" (${named.map((a) => `${a.addresses.join(", ")} id:${a.id}`).join("; ")}) — pass the address instead`,
    }
  }
  return { ok: false, reason: `no Mail.app account named "${s}" on ${where} (accounts there: ${describeAccounts(accounts)}) — pass the email address, e.g. --mail-account you@example.com` }
}

export interface RoutableNode {
  id: string
  name: string
  connection_status?: string
  last_heartbeat_at?: string | null
  bridge_capabilities?: any
}

/** The node's reported accounts, or why there are none to look at. */
export function nodeMailAccounts(node: RoutableNode): { accounts: MailAccount[] } | { unknown: string } {
  const am = node.bridge_capabilities?.apple_mail
  if (!am) return { unknown: "does not report Apple Mail" }
  if (am.available === false) return { unknown: am.reason || "Apple Mail unavailable" }
  if (!("accounts" in am)) return { unknown: "daemon too old to report its Mail accounts — update it (iris hive rollout)" }
  if (!Array.isArray(am.accounts)) return { unknown: am.accounts_reason || "has not listed its Mail accounts yet" }
  return { accounts: am.accounts.map((a: any) => ({ name: String(a.name), id: a.id ?? null, addresses: (a.addresses ?? []).map((x: string) => String(x).toLowerCase()), enabled: a.enabled })) }
}

const online = (n: RoutableNode, now: number) => {
  if (n.connection_status === "online") return true
  const t = Date.parse(n.last_heartbeat_at ?? "")
  return n.connection_status !== "offline" && Number.isFinite(t) && now - t < 10 * 60_000
}

const ago = (iso: string | null | undefined, now: number) => {
  const t = Date.parse(iso ?? "")
  if (!Number.isFinite(t)) return "never"
  const m = Math.round((now - t) / 60_000)
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

/** Where to read replies when no Mac can: the Gmail connection (#191878). */
export function gmailAlternative(address: string, leadId?: string | number): string {
  return (
    `Mail.app reads only work while that Mac is online. To read ${address} without a Mac, connect it as Gmail ` +
    `(iris integrations connect gmail, #191878) and run: iris comms ingest ${leadId ?? "<lead>"} --channel gmail_api --mail-account ${address}`
  )
}

export type Route = { ok: true; node: RoutableNode; account: MailAccount; address: string } | { ok: false; reason: string }

/**
 * The node to read `address` from. Online first, then the freshest heartbeat. `skip` is this
 * machine when it was already checked locally.
 */
export function routeMailAccount(nodes: RoutableNode[], address: string, opts: { now?: number; skipNodeId?: string | null; leadId?: string | number } = {}): Route {
  const now = opts.now ?? Date.now()
  const addr = address.trim().toLowerCase()
  const checked: string[] = []
  const holders: { node: RoutableNode; account: MailAccount }[] = []
  for (const n of nodes) {
    if (opts.skipNodeId && n.id === opts.skipNodeId) continue
    const r = nodeMailAccounts(n)
    const state = online(n, now) ? "online" : `offline, last heartbeat ${ago(n.last_heartbeat_at, now)}`
    if ("unknown" in r) {
      if (n.bridge_capabilities?.apple_mail) checked.push(`${n.name} (${state}; ${r.unknown})`)
      continue
    }
    const hits = r.accounts.filter((a) => a.addresses.includes(addr))
    if (hits.length > 1) {
      return { ok: false, reason: `${addr} is on ${hits.length} Mail.app accounts on ${n.name}: ${hits.map((a) => `"${a.name}" (id:${a.id})`).join(", ")} — pick one with --mail-account id:<id>` }
    }
    if (hits.length === 1) holders.push({ node: n, account: hits[0] })
    checked.push(`${n.name} (${state}; ${r.accounts.length} account(s)${hits.length ? `, has ${addr}` : ""})`)
  }
  const live = holders.filter((h) => online(h.node, now))
  live.sort((a, b) => Date.parse(b.node.last_heartbeat_at ?? "") - Date.parse(a.node.last_heartbeat_at ?? ""))
  if (live.length) return { ok: true, node: live[0].node, account: live[0].account, address: addr }
  const alt = gmailAlternative(addr, opts.leadId)
  if (holders.length) {
    const h = holders[0]
    return { ok: false, reason: `${addr} is in Mail.app on ${h.node.name} (account "${h.account.name}"), but ${h.node.name} is offline (last heartbeat ${ago(h.node.last_heartbeat_at, now)}). ${alt}` }
  }
  return { ok: false, reason: `no Hive node reports a Mail.app account with ${addr}. Checked: ${checked.join("; ") || "no node reports Apple Mail"}. ${alt}` }
}

/** POSIX single-quote. */
export const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The script a remote Mac runs: the same reader, never launching Mail, output gzipped + base64 so a
 * month of mail fits the task's 50 KB output limit. Exit 3 = Mail not running.
 */
export function remoteReaderScript(address: string, days: number, accountId: string, ownAddress: string): string {
  const argv = mailThreadReaderArgs(address, days, `id:${accountId}`, true, ownAddress)
  return [
    "#!/bin/bash",
    "set -o pipefail",
    'if ! pgrep -x Mail >/dev/null; then echo "Mail.app is not running on this Mac (IRIS does not launch it) — open Mail, then retry" >&2; exit 3; fi',
    `osascript ${argv.map(shq).join(" ")} | gzip -9 | base64`,
  ].join("\n")
}

/** Decode the remote reader's stdout (base64 gzip of the reader's JSON). */
export function decodeRemoteRead(stdout: string, truncated = false): MailThreadRead {
  if (truncated) return { ok: false, reason: "the read was larger than the Hive task output limit (50 KB) — retry with a smaller --days" }
  try {
    const json = gunzipSync(Buffer.from(stdout.replace(/\s+/g, ""), "base64")).toString("utf8")
    const d = JSON.parse(json)
    return { ok: true, items: d.items ?? [], scanned: d.scanned ?? {} }
  } catch (e: any) {
    return { ok: false, reason: `unreadable answer from the remote Mail.app read: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

export interface AppleMailReadDeps {
  platform: string
  /** This Mac's accounts (osascript), or a reason. Only called on darwin. */
  listLocal: () => Promise<{ ok: true; accounts: MailAccount[] } | { ok: false; reason: string }>
  readLocal: (address: string, days: number, selector: string, ownAddress: string) => Promise<MailThreadRead>
  nodes: () => Promise<RoutableNode[]>
  selfNodeId: string | null
  runRemote: (node: RoutableNode, script: string) => Promise<{ stdout: string; stderr?: string; exit_code?: number | null; stdout_truncated?: boolean }>
}

export type AppleMailRead =
  | { ok: true; where: string; account: MailAccount; address: string | null; read: (leadAddress: string) => Promise<MailThreadRead> }
  | { ok: false; reason: string }

/**
 * Decide WHERE `spec` is read, once per ingest. Returns a reader bound to that place, so a lead
 * with several addresses is read from the same account on the same Mac.
 */
export async function locateMailAccount(spec: string, days: number, deps: AppleMailReadDeps, leadId?: string | number): Promise<AppleMailRead> {
  const s = spec.trim()
  let localNote = ""
  if (deps.platform === "darwin") {
    const local = await deps.listLocal()
    if (local.ok) {
      const r = resolveMailAccount(local.accounts, s)
      if (r.ok) {
        const sel = r.account.id ? `id:${r.account.id}` : r.account.name
        return { ok: true, where: "this Mac", account: r.account, address: r.address, read: (a) => deps.readLocal(a, days, sel, r.address ?? "") }
      }
      // Ambiguous here is a real answer — do not go looking for the same ambiguity elsewhere.
      if (!isAddress(s) || / is on \d+ Mail\.app accounts/.test(r.reason)) return { ok: false, reason: r.reason }
      localNote = r.reason
    } else {
      localNote = `this Mac: ${local.reason}`
    }
  }
  if (!isAddress(s) && !s.startsWith("id:")) {
    return {
      ok: false,
      reason: `"${s}" is a Mail.app account NAME, and names are not unique across Macs ("Google" is a different mailbox on each) — pass the email address so IRIS can find the Mac that has it`,
    }
  }
  if (s.startsWith("id:")) return { ok: false, reason: localNote || `id: selectors only work on the Mac that has the account — pass the email address to route` }

  let nodes: RoutableNode[]
  try {
    nodes = await deps.nodes()
  } catch (e: any) {
    return { ok: false, reason: `${localNote ? localNote + "; " : ""}could not list Hive nodes to find ${s}: ${String(e?.message ?? e).slice(0, 160)}` }
  }
  const route = routeMailAccount(nodes, s, { skipNodeId: deps.platform === "darwin" ? deps.selfNodeId : null, leadId })
  if (!route.ok) return { ok: false, reason: localNote ? `${localNote}. ${route.reason}` : route.reason }
  const { node, account, address } = route
  if (!account.id) return { ok: false, reason: `${node.name} reported ${address} without a Mail account id — update its daemon (iris hive rollout)` }
  return {
    ok: true,
    where: node.name,
    account,
    address,
    read: async (leadAddress) => {
      try {
        const out = await deps.runRemote(node, remoteReaderScript(leadAddress, days, account.id as string, address))
        if (out.exit_code && out.exit_code !== 0) {
          const why = String(out.stderr || out.stdout || "").replace(/\s+/g, " ").trim().slice(-240)
          return { ok: false, reason: `Mail.app read on ${node.name} failed (exit ${out.exit_code}): ${why}` }
        }
        const r = decodeRemoteRead(out.stdout, out.stdout_truncated)
        if (!r.ok) return { ok: false, reason: `${node.name}: ${r.reason}` }
        // Say which Mac it was read on — the server records it as the message's source.
        for (const it of r.items) it.metadata = { ...(it.metadata ?? {}), node: node.name }
        return r
      } catch (e: any) {
        return { ok: false, reason: `could not run the Mail.app read on ${node.name}: ${String(e?.message ?? e).slice(0, 160)} — ${gmailAlternative(address, leadId)}` }
      }
    },
  }
}

/** The real local account listing. Never launches Mail. */
export function listLocalMailAccounts(timeoutMs = 20000): Promise<{ ok: true; accounts: MailAccount[] } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    execFile("/usr/bin/pgrep", ["-x", "Mail"], { timeout: 5000 }, (perr, pout) => {
      if (perr || !String(pout).trim()) return resolve({ ok: false, reason: "Mail.app is not running (IRIS does not launch it)" })
      execFile("osascript", ["-l", "JavaScript", "-e", MAIL_ACCOUNTS_JXA], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, reason: `could not list Mail accounts: ${String(stderr || err.message).replace(/\s+/g, " ").trim().slice(0, 200)}` })
        try {
          resolve({ ok: true, accounts: parseMailAccounts(String(stdout)) })
        } catch (e: any) {
          resolve({ ok: false, reason: `unreadable Mail accounts listing: ${String(e?.message ?? e).slice(0, 120)}` })
        }
      })
    })
  })
}


/**
 * Read every one of a lead's addresses from the mailbox `spec` names, wherever it lives. What
 * `iris comms ingest --channel apple_mail --mail-account <address>` (and pulse) run.
 */
export async function readAppleMailForLead(
  leadEmails: string[],
  spec: string,
  days: number,
  deps: AppleMailReadDeps,
  leadId?: string | number,
): Promise<{ items: any[]; unavailable: string[]; answered?: boolean }> {
  const where = await locateMailAccount(spec, days, deps, leadId)
  if (!where.ok) return { items: [], unavailable: [where.reason] }
  const items: any[] = []
  const failures: string[] = []
  let answered = false
  for (const addr of leadEmails) {
    const r = await where.read(addr)
    if (r.ok) {
      answered = true
      items.push(...r.items)
    } else {
      failures.push(r.reason)
    }
  }
  const seen = new Set<string>()
  const unique = items.filter((i) => (seen.has(i.external_message_id) ? false : (seen.add(i.external_message_id), true)))
  return { items: unique, unavailable: failures, answered }
}
