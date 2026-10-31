import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { MAIL_INBOX_READER_JXA } from "./comms-mail-applescript"
import type { RoutableNode } from "./comms-mail-route"
import {
  missingBodyNote,
  onlineMailNodes,
  readByIdFailureHint,
  readByIdRefusal,
  readHint,
  readMailAccount,
  rowsForDisplay,
  singleMacCall,
  type MailAccountDeps,
} from "./mail-account-read"

// #189480: `mail inbox|search|read` over Hive read whichever Mac the gateway picked. Two Macs hold
// different mailboxes, and "Google" is a different mailbox on each. All data below is invented.
const fresh = new Date(Date.now() - 20_000).toISOString()
const stale = new Date(Date.now() - 3 * 864e5).toISOString()
const mac = (name: string, accounts: any, status = "online", hb = fresh): RoutableNode => ({
  id: `id-${name}`,
  name,
  connection_status: status,
  last_heartbeat_at: hb,
  bridge_capabilities: { apple_mail: accounts === undefined ? { available: true } : { available: true, accounts } },
})
const acct = (id: string, address: string, name = "Google") => ({ name, id, addresses: [address], enabled: true })
const A = mac("mac-a", [acct("A1", "a@example.com")])
const B = mac("mac-b", [acct("B1", "b@example.com")])

const encode = (o: any) => gzipSync(Buffer.from(JSON.stringify(o))).toString("base64")
const row = { sender: "sam@example.org", subject: "hello", date: "2026-10-30T10:00:00.000Z", mailbox: "INBOX" }

function deps(over: Partial<MailAccountDeps> = {}) {
  const remote: { node: string; script: string }[] = []
  const local: string[][] = []
  const d: MailAccountDeps = {
    platform: "linux",
    selfNodeId: null,
    listLocal: async () => ({ ok: true, accounts: [] }),
    readLocal: async () => ({ ok: false, reason: "thread reader must not be used here" }),
    nodes: async () => [A, B],
    runRemote: async (node, script) => {
      remote.push({ node: node.name, script })
      return { stdout: encode({ emails: [row] }), exit_code: 0 }
    },
    runLocalReader: async (argv) => {
      local.push(argv)
      return { ok: true, stdout: JSON.stringify({ emails: [row] }) }
    },
    ...over,
  }
  return { d, remote, local }
}
const Q = { days: 7, from: "@", limit: 50 }

describe("--mail-account routes to the holder, never another Mac", () => {
  test("reads on the node whose heartbeat lists the address, bound to that account's id", async () => {
    const { d, remote } = deps()
    const r = await readMailAccount("b@example.com", Q, "auto", d)
    expect(remote.map((x) => x.node)).toEqual(["mac-b"])
    expect(remote[0].script).toContain("'id:B1'")
    expect(remote[0].script).not.toContain("A1")
    expect(r.ok && r.where).toContain("mac-b")
    expect(r.ok && r.data.emails[0]).toMatchObject({ node: "mac-b", account: "b@example.com" })
  })

  test("the order of the nodes does not matter", async () => {
    const { d, remote } = deps({ nodes: async () => [B, A] })
    await readMailAccount("a@example.com", Q, "auto", d)
    expect(remote.map((x) => x.node)).toEqual(["mac-a"])
  })

  test("this Mac first when it has the address, with no Hive task", async () => {
    const { d, remote, local } = deps({ platform: "darwin", listLocal: async () => ({ ok: true, accounts: [acct("L1", "b@example.com")] }) })
    const r = await readMailAccount("b@example.com", Q, "auto", d)
    expect(remote).toEqual([])
    expect(local[0]).toContain("id:L1")
    expect(r.ok && r.where).toContain("this Mac")
  })

  test("a Mac without the address routes to the one with it", async () => {
    const { d, remote, local } = deps({ platform: "darwin", listLocal: async () => ({ ok: true, accounts: [acct("L1", "other@example.com")] }) })
    await readMailAccount("a@example.com", Q, "auto", d)
    expect(local).toEqual([])
    expect(remote[0].node).toBe("mac-a")
  })

  test("--via local refuses rather than reading another Mac", async () => {
    const { d, remote } = deps({ platform: "darwin", listLocal: async () => ({ ok: true, accounts: [acct("L1", "other@example.com")] }) })
    const r = await readMailAccount("a@example.com", Q, "local", d)
    expect(r.ok).toBe(false)
    expect(remote).toEqual([])
  })

  test("--via hive skips this Mac", async () => {
    const { d, remote, local } = deps({ platform: "darwin", listLocal: async () => ({ ok: true, accounts: [acct("L1", "a@example.com")] }) })
    await readMailAccount("a@example.com", Q, "hive", d)
    expect(local).toEqual([])
    expect(remote[0].node).toBe("mac-a")
  })

  test("a remote failure is a failure, not an empty inbox and not another Mac", async () => {
    const { d } = deps({ runRemote: async () => ({ stdout: "", stderr: "Mail.app is not running", exit_code: 3 }) })
    const r = await readMailAccount("a@example.com", Q, "auto", d)
    expect(!r.ok && r.reason).toContain("mac-a")
    expect(!r.ok && r.reason).toContain("not running")
  })

  test("an over-limit answer says so", async () => {
    const { d } = deps({ runRemote: async () => ({ stdout: "x", exit_code: 0, stdout_truncated: true }) })
    const r = await readMailAccount("a@example.com", Q, "auto", d)
    expect(!r.ok && r.reason).toContain("--limit")
  })
})

describe("the errors #408 gives", () => {
  test("holder offline: names it, its last heartbeat, and the Gmail path", async () => {
    const { d, remote } = deps({ nodes: async () => [mac("mac-a", [acct("A1", "a@example.com")], "offline", stale), B] })
    const r = await readMailAccount("a@example.com", Q, "auto", d)
    expect(remote).toEqual([])
    expect(!r.ok && r.reason).toMatch(/mac-a is offline \(last heartbeat 3d ago\)/)
    expect(!r.ok && r.reason).toContain("--channel gmail_api")
  })

  test("nobody has it: lists the nodes checked and the Gmail path", async () => {
    const { d, remote } = deps()
    const r = await readMailAccount("nobody@example.com", Q, "auto", d)
    expect(remote).toEqual([])
    expect(!r.ok && r.reason).toContain("mac-a")
    expect(!r.ok && r.reason).toContain("mac-b")
    expect(!r.ok && r.reason).toContain("--channel gmail_api")
  })

  test("a daemon too old to report accounts is named", async () => {
    const { d } = deps({ nodes: async () => [mac("mac-old", undefined)] })
    const r = await readMailAccount("a@example.com", Q, "auto", d)
    expect(!r.ok && r.reason).toMatch(/mac-old .*too old/)
  })

  test("a name is refused off a Mac: names are not unique across Macs", async () => {
    const { d, remote } = deps()
    const r = await readMailAccount("Google", Q, "auto", d)
    expect(remote).toEqual([])
    expect(!r.ok && r.reason).toContain("pass the email address")
  })
})

describe("no --mail-account, more than one online Mac", () => {
  const ok = { ok: true as const, data: { emails: [row] }, nodeId: "id-mac-a" }

  test("refuses, lists both and what they hold, and never asks the gateway", async () => {
    let called = 0
    const r = await singleMacCall(async () => [A, B], async () => (called++, ok))
    expect(called).toBe(0)
    expect(!r.ok && r.error).toContain("--mail-account")
    expect(!r.ok && r.error).toContain("mac-a (a@example.com)")
    expect(!r.ok && r.error).toContain("mac-b (b@example.com)")
  })

  test("one online Mac answers, labelled by name", async () => {
    const r = await singleMacCall(async () => [A, mac("mac-b", [acct("B1", "b@example.com")], "offline", stale)], async () => ok)
    expect(r.ok && r.nodeName).toBe("mac-a")
  })

  test("an answer from any other node is discarded", async () => {
    const r = await singleMacCall(async () => [A], async () => ({ ...ok, nodeId: "id-mac-z" }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe("wrong_node")
  })

  test("cannot list the nodes: refuses rather than guessing", async () => {
    let called = 0
    const r = await singleMacCall(async () => { throw new Error("boom") }, async () => (called++, ok))
    expect(called).toBe(0)
    expect(r.ok).toBe(false)
  })

  test("a node without Mail does not count", () => {
    expect(onlineMailNodes([A, { id: "x", name: "linux", connection_status: "online", bridge_capabilities: {} }]).map((m) => m.node.name)).toEqual(["mac-a"])
  })

  test("a too-old daemon counts as a Mac with Mail, since the gateway could pick it", async () => {
    const r = await singleMacCall(async () => [A, mac("mac-old", undefined)], async () => ok)
    expect(!r.ok && r.error).toContain("too old")
  })
})

describe("read by id fails clearly and stays on this machine", () => {
  test("over Hive, off a Mac, or with --mail-account", () => {
    expect(readByIdRefusal({ platform: "darwin", via: "hive" })).toContain("different mailbox")
    expect(readByIdRefusal({ platform: "linux", via: "auto" })).toContain("not a Mac")
    expect(readByIdRefusal({ platform: "darwin", via: "auto", mailAccount: "a@example.com" })).toContain("--mail-account a@example.com")
  })

  test("a Mac's own bridge may answer", () => {
    expect(readByIdRefusal({ platform: "darwin", via: "auto" })).toBeNull()
  })

  test("a daemon without the endpoint says which change it needs", () => {
    expect(readByIdFailureHint("Cannot GET /api/mail/message")).toContain("#28")
    expect(readByIdFailureHint("HTTP 503")).toBeNull()
  })
})

describe("rows do not offer what will fail", () => {
  test("a Hive row has no id, and the footer offers the sender", () => {
    const rows = rowsForDisplay([{ id: 7, sender: "s@example.org" }], "Hive node mac-a")
    expect(rows[0].id).toBeUndefined()
    expect(readHint(rows)).toContain("<sender>")
    expect(readHint(rows)).not.toContain("<id>")
  })

  test("this machine keeps its ids", () => {
    const rows = rowsForDisplay([{ id: 7, sender: "s@example.org" }], "this machine")
    expect(readHint(rows)).toContain("<id>")
  })
})

describe("a missing body says why", () => {
  test("an envelope-only daemon is not an empty email", () => {
    const n = missingBodyNote({ query: "sam", where: "Hive node mac-a", readThroughAccount: false })
    expect(n).toContain("does not mean the email is empty")
    expect(n).toContain("--mail-account")
  })
  test("read through Mail.app, an empty body really is empty", () => {
    expect(missingBodyNote({ query: "sam", where: "x", readThroughAccount: true })).toContain("no body text")
  })
})

describe("MAIL_INBOX_READER_JXA", () => {
  const box = (rows: any[]) => {
    const seenWhose: any[] = []
    const msgs: any = Object.assign(rows.map((r) => ({ content: () => r.body })), {
      sender: () => rows.map((r) => r.sender),
      subject: () => rows.map((r) => r.subject),
      dateReceived: () => rows.map((r) => new Date(r.date)),
    })
    return { seenWhose, mb: { name: () => "INBOX", messages: { whose: (w: any) => (seenWhose.push(w), msgs) } } }
  }
  const run = (rows: any[], argv: string[]) => {
    const inbox = box(rows)
    const other = { id: () => "OTHER", mailboxes: () => { throw new Error("read the wrong account") } }
    const target = { id: () => "T", mailboxes: () => [inbox.mb] }
    const Application = () => ({ accounts: Object.assign(() => [other, target], { byName: () => target }) })
    const fn = new Function("Application", `${MAIL_INBOX_READER_JXA}; return run`)(Application)
    return JSON.parse(fn(argv))
  }
  const rows = [
    { sender: "Sam Lee <Sam@Example.org>", subject: "older", date: "2026-10-01T00:00:00Z", body: "one" },
    { sender: "alerts@feed.example", subject: "Newest", date: "2026-10-03T00:00:00Z", body: "two" },
    { sender: "Sam Lee <sam@example.org>", subject: "newer", date: "2026-10-02T00:00:00Z", body: "three" },
  ]

  test("reads the account by id, newest first, sender parsed, no bodies unless asked", () => {
    const out = run(rows, ["7", "id:T", "@", "", "50", "0"])
    expect(out.emails.map((e: any) => e.subject)).toEqual(["Newest", "newer", "older"])
    expect(out.emails[1]).toMatchObject({ sender: "sam@example.org", sender_name: "Sam Lee" })
    expect(out.emails[0].body).toBeUndefined()
  })

  test("filters and limits, and the body belongs to its own row", () => {
    const out = run(rows, ["7", "id:T", "sam", "", "1", "100"])
    expect(out.emails).toHaveLength(1)
    expect(out.emails[0]).toMatchObject({ subject: "newer", body: "three" })
    expect(run(rows, ["7", "id:T", "@", "NEWEST", "50", "0"]).emails).toHaveLength(1)
  })

  test("an account id this Mac does not have throws, it does not fall back", () => {
    expect(() => run(rows, ["7", "id:MISSING", "@", "", "50", "0"])).toThrow("no Mail.app account with id")
  })
})
