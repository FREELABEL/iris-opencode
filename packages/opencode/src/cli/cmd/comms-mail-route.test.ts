import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import {
  parseMailAccounts,
  resolveMailAccount,
  routeMailAccount,
  locateMailAccount,
  readAppleMailForLead,
  remoteReaderScript,
  decodeRemoteRead,
  type AppleMailReadDeps,
  type MailAccount,
  type RoutableNode,
} from "./comms-mail-route"
import { MAIL_THREAD_READER_JXA, mailThreadReaderArgs } from "./comms-mail-applescript"

// The read-only probe's real output on 2026-10-30 (#191879). Note "Google" is a different mailbox
// on each Mac — the reason a NAME cannot identify an account.
const MACBOOK = parseMailAccounts(
  JSON.stringify([
    { name: "iCloud", id: "M1", addresses: ["mayoalexandertd@icloud.com"], enabled: true },
    { name: "alex@freelabel.net", id: "M2", addresses: ["alex@freelabel.net"], enabled: true },
    { name: "alexander.mayo@bisnow.com", id: "M3", addresses: ["alexander.mayo@bisnow.com"], enabled: true },
    { name: "Google", id: "M4", addresses: ["manage.amrecords@gmail.com"], enabled: true },
    { name: "amayo@mypathwaysai.com", id: "M5", addresses: ["amayo@mypathwaysai.com"], enabled: true },
  ]),
)
const HIVE_002 = parseMailAccounts(
  JSON.stringify([
    { name: "iCloud", id: "5B433AA9", addresses: ["mayoalexandertd@icloud.com"], enabled: true },
    { name: "Google", id: "76FF54FE", addresses: ["alex@freelabel.net"], enabled: true },
    { name: "amayo@mypathwaysai.com", id: "715CB9B9", addresses: ["amayo@mypathwaysai.com"], enabled: true },
    { name: "team@heyiris.io", id: "87CCD17A", addresses: ["Team@HeyIris.io"], enabled: true },
  ]),
)

const NOW = Date.parse("2026-10-30T21:00:00Z")
const node = (name: string, accounts: MailAccount[] | null | undefined, status = "online", hb = "2026-10-30T20:59:40Z"): RoutableNode => ({
  id: `id-${name}`,
  name,
  connection_status: status,
  last_heartbeat_at: hb,
  bridge_capabilities: {
    apple_mail: accounts === undefined ? { available: true } : { available: true, accounts, accounts_reason: accounts ? null : "Mail.app is not running" },
  },
})

describe("resolveMailAccount — an address, not Mail's display name (#191879)", () => {
  test("THE BUG: team@heyiris.io resolves by address to its account on the Mac that has it", () => {
    const r = resolveMailAccount(HIVE_002, "team@heyiris.io")
    expect(r.ok && r.account.id).toBe("87CCD17A")
    expect(r.ok && r.address).toBe("team@heyiris.io")
  })

  test("case-insensitive on the address", () => {
    const r = resolveMailAccount(HIVE_002, "TEAM@heyiris.IO")
    expect(r.ok && r.account.name).toBe("team@heyiris.io")
  })

  test("an address the Mac does not have is refused, naming the accounts it does have", () => {
    const r = resolveMailAccount(MACBOOK, "team@heyiris.io")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("no Mail.app account on this Mac has the address team@heyiris.io")
      expect(r.reason).toContain('"Google" (manage.amrecords@gmail.com)')
    }
  })

  test("an address on two accounts is refused, not guessed", () => {
    const two = [...HIVE_002, { name: "team alias", id: "X9", addresses: ["team@heyiris.io"] }]
    const r = resolveMailAccount(two, "team@heyiris.io")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("is on 2 Mail.app accounts")
      expect(r.reason).toContain("id:87CCD17A")
      expect(r.reason).toContain("id:X9")
    }
  })

  test("an ambiguous NAME is refused and the addresses are shown", () => {
    const dup = [...MACBOOK, { name: "Google", id: "M6", addresses: ["other@gmail.com"] }]
    const r = resolveMailAccount(dup, "Google")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('2 Mail.app accounts on this Mac are named "Google"')
  })

  test("a unique name and an id: selector still work", () => {
    expect(resolveMailAccount(MACBOOK, "Google").ok).toBe(true)
    const r = resolveMailAccount(MACBOOK, "id:M5")
    expect(r.ok && r.account.name).toBe("amayo@mypathwaysai.com")
  })
})

describe("routeMailAccount — the node that advertises the address", () => {
  const fleet = [node("Alexs-MacBook-Pro-11711", MACBOOK), node("iris-hive-002", HIVE_002), node("iris-hive-001", null)]

  test("routes team@heyiris.io to iris-hive-002, not the MacBook", () => {
    const r = routeMailAccount(fleet, "team@heyiris.io", { now: NOW })
    expect(r.ok && r.node.name).toBe("iris-hive-002")
    expect(r.ok && r.account.id).toBe("87CCD17A")
  })

  test("an address no node has: the error names every node checked and the Gmail path", () => {
    const r = routeMailAccount(fleet, "nobody@heyiris.io", { now: NOW, leadId: 30359 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("no Hive node reports a Mail.app account with nobody@heyiris.io")
      expect(r.reason).toContain("Alexs-MacBook-Pro-11711 (online; 5 account(s))")
      expect(r.reason).toContain("iris-hive-002 (online; 4 account(s))")
      expect(r.reason).toContain("iris-hive-001 (online; Mail.app is not running)")
      expect(r.reason).toContain("only work while that Mac is online")
      expect(r.reason).toContain("iris comms ingest 30359 --channel gmail_api --mail-account nobody@heyiris.io")
    }
  })

  test("the node that has it is offline: said plainly, with the Gmail path", () => {
    const off = [node("Alexs-MacBook-Pro-11711", MACBOOK), node("iris-hive-002", HIVE_002, "offline", "2026-10-30T20:40:00Z")]
    const r = routeMailAccount(off, "team@heyiris.io", { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('team@heyiris.io is in Mail.app on iris-hive-002 (account "team@heyiris.io"), but iris-hive-002 is offline (last heartbeat 20m ago)')
      expect(r.reason).toContain("--channel gmail_api")
    }
  })

  test("prefers an online holder over an offline one", () => {
    const both = [node("old-mac", HIVE_002, "offline", "2026-10-01T00:00:00Z"), node("iris-hive-002", HIVE_002)]
    const r = routeMailAccount(both, "team@heyiris.io", { now: NOW })
    expect(r.ok && r.node.name).toBe("iris-hive-002")
  })

  test("a daemon too old to report accounts is listed as such", () => {
    const r = routeMailAccount([node("MacBookPro", undefined)], "team@heyiris.io", { now: NOW })
    expect(!r.ok && r.reason).toContain("MacBookPro (online; daemon too old to report its Mail accounts")
  })

  test("the same address on two accounts of one node is refused", () => {
    const two = [node("iris-hive-002", [...HIVE_002, { name: "alias", id: "X9", addresses: ["team@heyiris.io"] }])]
    const r = routeMailAccount(two, "team@heyiris.io", { now: NOW })
    expect(!r.ok && r.reason).toContain("is on 2 Mail.app accounts on iris-hive-002")
  })
})

describe("locateMailAccount — local first, then the fleet", () => {
  const items = [{ external_message_id: "rfc822_CAB@x", direction: "inbound", subject: "Re: hi", sent_at: "2026-10-30T18:00:00Z", metadata: { source: "apple_mail_applescript" } }]
  const deps = (over: Partial<AppleMailReadDeps> = {}): AppleMailReadDeps & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      platform: "linux",
      listLocal: async () => ({ ok: true, accounts: MACBOOK }),
      readLocal: async (a, _d, sel, own) => (calls.push(`local ${a} ${sel} ${own}`), { ok: true, items, scanned: {} }),
      nodes: async () => [node("Alexs-MacBook-Pro-11711", MACBOOK), node("iris-hive-002", HIVE_002)],
      selfNodeId: null,
      runRemote: async (n, script) => {
        calls.push(`remote ${n.name} ${script.includes("id:87CCD17A")}`)
        return { stdout: gzipSync(Buffer.from(JSON.stringify({ items, scanned: {} }))).toString("base64"), exit_code: 0 }
      },
      ...over,
    }
  }

  test("on Linux, routes to the Mac that has it and tags the node on every message", async () => {
    const d = deps()
    const where = await locateMailAccount("team@heyiris.io", 30, d)
    expect(where.ok && where.where).toBe("iris-hive-002")
    if (!where.ok) return
    const r = await where.read("partner@firm.example")
    expect(d.calls).toEqual(["remote iris-hive-002 true"])
    expect(r.ok && r.items[0].metadata.node).toBe("iris-hive-002")
  })

  test("on a Mac that has the address, reads locally by account id with the account's own address", async () => {
    const d = deps({ platform: "darwin", listLocal: async () => ({ ok: true, accounts: HIVE_002 }) })
    const where = await locateMailAccount("team@heyiris.io", 30, d)
    expect(where.ok && where.where).toBe("this Mac")
    if (where.ok) await where.read("partner@firm.example")
    expect(d.calls).toEqual(["local partner@firm.example id:87CCD17A team@heyiris.io"])
  })

  test("THE BUG, end to end: on the MacBook, team@heyiris.io is read from iris-hive-002 instead of failing -1728", async () => {
    const d = deps({ platform: "darwin", selfNodeId: "id-Alexs-MacBook-Pro-11711" })
    const where = await locateMailAccount("team@heyiris.io", 30, d)
    expect(where.ok && where.where).toBe("iris-hive-002")
  })

  test("a bare account name is refused off the Mac, because names repeat across Macs", async () => {
    const where = await locateMailAccount("Google", 30, deps())
    expect(!where.ok && where.reason).toContain("names are not unique across Macs")
  })

  test("a remote failure is reported with the node's own words", async () => {
    const d = deps({ runRemote: async () => ({ stdout: "", stderr: "Mail.app is not running on this Mac (IRIS does not launch it)", exit_code: 3 }) })
    const where = await locateMailAccount("team@heyiris.io", 30, d)
    if (!where.ok) throw new Error(where.reason)
    const r = await where.read("partner@firm.example")
    expect(!r.ok && r.reason).toContain("Mail.app read on iris-hive-002 failed (exit 3): Mail.app is not running")
  })
})

describe("the remote reader script", () => {
  test("never launches Mail, passes the account by id and the own address, compresses the answer", () => {
    const s = remoteReaderScript("o'brien@firm.example", 30, "87CCD17A", "team@heyiris.io")
    expect(s).toContain("pgrep -x Mail")
    expect(s).toContain("'id:87CCD17A'")
    expect(s).toContain("'team@heyiris.io'")
    expect(s).toContain(`'o'\\''brien@firm.example'`)
    expect(s).toContain("| gzip -9 | base64")
    expect(s).not.toContain("open -a")
  })

  test("a truncated answer is a failure, not a short read", () => {
    expect(decodeRemoteRead("abc", true).ok).toBe(false)
  })

  test("the reader takes id:<id> and stamps the Message-ID and own address on each item", () => {
    expect(MAIL_THREAD_READER_JXA).toContain('sel.indexOf("id:") === 0')
    expect(MAIL_THREAD_READER_JXA).toContain("rfc822_message_id: ids[i]")
    expect(MAIL_THREAD_READER_JXA).toContain("ownAddr || acctName")
    expect(mailThreadReaderArgs("a@b.c", 30, "id:X", true, "me@x.io").slice(4)).toEqual(["a@b.c", "30", "id:X", "body", "me@x.io"])
    expect(() => new Function(MAIL_THREAD_READER_JXA)).not.toThrow()
  })
})

describe("iris comms ingest --channel apple_mail --mail-account <address> (the command's reader)", () => {
  test("lead 30359's mail is read from the Mac that has team@heyiris.io", async () => {
    const item = { external_message_id: "rfc822_CAB@x", direction: "inbound", subject: "Re: hi", sent_at: "2026-10-30T18:00:00Z", metadata: {} }
    const ran: string[] = []
    const read = await readAppleMailForLead(["partner@firm.example"], "team@heyiris.io", 30, {
      platform: "darwin",
      selfNodeId: "id-Alexs-MacBook-Pro-11711",
      listLocal: async () => ({ ok: true, accounts: MACBOOK }),
      readLocal: async () => {
        throw new Error("must not read the MacBook's accounts by name")
      },
      nodes: async () => [node("Alexs-MacBook-Pro-11711", MACBOOK), node("iris-hive-002", HIVE_002)],
      runRemote: async (n) => (ran.push(n.name), { stdout: gzipSync(Buffer.from(JSON.stringify({ items: [item] }))).toString("base64"), exit_code: 0 }),
    })
    expect(ran).toEqual(["iris-hive-002"])
    expect(read.items).toHaveLength(1)
    expect(read.items[0].metadata.node).toBe("iris-hive-002")
  })

  test("no node has it: unavailable, with the Gmail path in the reason", async () => {
    const read = await readAppleMailForLead(["partner@firm.example"], "team@heyiris.io", 30, {
      platform: "linux",
      selfNodeId: null,
      listLocal: async () => ({ ok: false, reason: "n/a" }),
      readLocal: async () => ({ ok: false, reason: "n/a" }),
      nodes: async () => [node("Alexs-MacBook-Pro-11711", MACBOOK)],
      runRemote: async () => ({ stdout: "" }),
    }, 30359)
    expect(read.items).toHaveLength(0)
    expect(read.unavailable.join(" ")).toContain("--channel gmail_api --mail-account team@heyiris.io")
  })
})
