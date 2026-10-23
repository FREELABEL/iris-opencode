import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { cardIdOf, deliveryOf, parseSendJson, readOutbox, resolveDelivery, sendInboxMessage, setInboxState, shortReason, validTarget, type Exec, type TaskView } from "./inbox-actions"

// Fictional rows only — this repo is public.
const row = (o: Record<string, unknown>) => JSON.stringify(o)
function inbox(lines: string[]) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "hib-")), "inbox")
  require("fs").mkdirSync(dir)
  writeFileSync(path.join(dir, ".manifest.jsonl"), lines.join("\n") + "\n")
  const manifest = () => readFileSync(path.join(dir, ".manifest.jsonl"), "utf-8").trim().split("\n")
  return { dir, manifest }
}
const NOW = () => new Date("2026-10-23T12:00:00Z")

describe("setInboxState", () => {
  test("done marks it read too, and stamps when", async () => {
    const { dir, manifest } = inbox([row({ id: "a", read: false, from_node: "studio-mac" })])
    const r = await setInboxState(1, { id: "a", done: true }, { dir, now: NOW, cli: null })
    expect(r).toEqual({ measured: true, read: true, done: true })
    expect(JSON.parse(manifest()[0])).toMatchObject({ id: "a", read: true, done: true, done_at: "2026-10-23T12:00:00.000Z" })
  })

  test("un-done does not make it unread again", async () => {
    const { dir, manifest } = inbox([row({ id: "a", read: true, done: true, done_at: "x" })])
    const r = await setInboxState(1, { id: "a", done: false }, { dir, cli: null })
    expect(r).toMatchObject({ read: true, done: false })
    expect(JSON.parse(manifest()[0]).done_at).toBeNull()
  })

  test("read=false marks it unread — the write the panel never had", async () => {
    const { dir, manifest } = inbox([row({ id: "a", read: true })])
    expect(await setInboxState(1, { id: "a", read: false }, { dir, cli: null })).toMatchObject({ read: false })
    expect(JSON.parse(manifest()[0]).read).toBe(false)
  })

  test("a line it cannot parse is written back byte-for-byte", async () => {
    const { dir, manifest } = inbox(["not json {", row({ id: "b", read: false })])
    await setInboxState(2, { id: "b", done: true }, { dir, cli: null })
    expect(manifest()[0]).toBe("not json {")
    expect(manifest()).toHaveLength(2)
  })

  test("the id wins over a position that has shifted", async () => {
    const { dir, manifest } = inbox([row({ id: "x" }), row({ id: "target" })])
    await setInboxState(1, { id: "target", done: true }, { dir, cli: null })
    expect(JSON.parse(manifest()[0]).done).toBeUndefined()
    expect(JSON.parse(manifest()[1]).done).toBe(true)
  })

  test("a message that is gone says so, and writes nothing", async () => {
    const { dir, manifest } = inbox([row({ id: "a" })])
    const r = await setInboxState(1, { id: "zzz", done: true }, { dir, cli: null })
    expect(r.measured).toBe(false)
    expect(r.reason).toContain("no longer")
    expect(JSON.parse(manifest()[0]).done).toBeUndefined()
  })

  test("resolveCard closes the handoff's card through the CLI, and reports it separately", async () => {
    const { dir } = inbox([row({ id: "h", type: "handoff", item: "bloq:item:5501" })])
    const calls: string[][] = []
    const exec: Exec = async (_f, args) => (calls.push(args), { code: 0, stdout: "", stderr: "" })
    const r = await setInboxState(1, { id: "h", done: true, resolveCard: true }, { dir, cli: "/bin/iris", exec })
    expect(calls).toEqual([["bloqs", "update-item", "5501", "--status", "done"]])
    expect(r.card).toEqual({ item: "bloq:item:5501", ok: true })
  })

  test("a card that would not close is NOT reported as closed — the local done still stands", async () => {
    const { dir } = inbox([row({ id: "h", type: "handoff", item: "bloq:item:5501" })])
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "Error: 403 not a member of this board\n" })
    const r = await setInboxState(1, { id: "h", done: true, resolveCard: true }, { dir, cli: "/bin/iris", exec })
    expect(r.done).toBe(true)
    expect(r.card).toEqual({ item: "bloq:item:5501", ok: false, reason: "Error: 403 not a member of this board" })
  })

  test("without resolveCard the card is never touched", async () => {
    const { dir } = inbox([row({ id: "h", type: "handoff", item: "bloq:item:5501" })])
    let called = false
    const exec: Exec = async () => ((called = true), { code: 0, stdout: "", stderr: "" })
    const r = await setInboxState(1, { id: "h", done: true }, { dir, cli: "/bin/iris", exec })
    expect(called).toBe(false)
    expect(r.card).toBeUndefined()
  })
})

describe("cardIdOf", () => {
  test("the shapes a handoff carries", () => {
    expect(cardIdOf("bloq:item:5501")).toBe(5501)
    expect(cardIdOf("atlas:item:7")).toBe(7)
    expect(cardIdOf("#190875")).toBe(190875)
    expect(cardIdOf("12")).toBe(12)
  })
  test("anything else is not a card", () => {
    expect(cardIdOf("bloq:item:12; rm -rf /")).toBeNull()
    expect(cardIdOf(undefined)).toBeNull()
    expect(cardIdOf("lead:9")).toBeNull()
  })
})

describe("sendInboxMessage", () => {
  const ok = (j: object): Exec => async (_f, args) => ({ code: 0, stdout: "◈ noise\n" + JSON.stringify(j) + "\n", stderr: "", args } as any)

  test("argv only, text as the positional — a message starting with '-' stays text, not a flag", async () => {
    const { dir } = inbox([])
    const seen: string[][] = []
    const exec: Exec = async (_f, args) => (seen.push(args), { code: 0, stdout: JSON.stringify({ ok: true, task_id: "t1", node: "studio-mac", via: "own" }), stderr: "" })
    const r = await sendInboxMessage({ to: "studio-mac", text: "--burn everything" }, { dir, cli: "/bin/iris", exec, now: NOW, newId: () => "o1" })
    expect(seen[0]).toEqual(["hive", "inbox", "send", "--target", "studio-mac", "--json", "\u200b--burn everything"])
    // Never `--`: the CLI does not read the message from after it (#190940).
    expect(seen[0]).not.toContain("--")
    expect(r).toEqual({
      measured: true,
      ok: true,
      sent: { id: "o1", to: "studio-mac", text: "--burn everything", sentAt: "2026-10-23T12:00:00.000Z", taskId: "t1" },
    })
  })

  test("a reply is recorded in the outbox with what it answered, and a peer send says relay", async () => {
    const { dir } = inbox([])
    await sendInboxMessage({ to: "kristen-laptop", text: "On it.", replyTo: "m5" }, { dir, cli: "/bin/iris", exec: ok({ ok: true, task_id: "t2", node: "kristen-laptop", via: "peer" }), now: NOW, newId: () => "o2" })
    const { rows } = readOutbox(dir)
    expect(rows).toEqual([{ id: "o2", to: "kristen-laptop", text: "On it.", sentAt: "2026-10-23T12:00:00.000Z", taskId: "t2", replyTo: "m5", via: "relay" }])
  })

  test("a failed send is a failure with the CLI's reason, and nothing is recorded", async () => {
    const { dir } = inbox([])
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: 'No node matching "ghost" among your nodes or your peers\' online nodes.\n' })
    const r = await sendInboxMessage({ to: "ghost", text: "hi" }, { dir, cli: "/bin/iris", exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('No node matching "ghost"')
    expect(readOutbox(dir).rows).toEqual([])
  })

  test("exit 0 without an ok JSON is NOT a send", async () => {
    const { dir } = inbox([])
    const r = await sendInboxMessage({ to: "studio-mac", text: "hi" }, { dir, cli: "/bin/iris", exec: async () => ({ code: 0, stdout: "Done\n", stderr: "" }) })
    expect(r.ok).toBe(false)
  })

  test("refuses before running anything: empty, too long, a flag for a name, no CLI", async () => {
    const { dir } = inbox([])
    let ran = 0
    const exec: Exec = async () => (ran++, { code: 0, stdout: "", stderr: "" })
    expect((await sendInboxMessage({ to: "a", text: "   " }, { dir, cli: "/bin/iris", exec })).reason).toContain("empty")
    expect((await sendInboxMessage({ to: "a", text: "x".repeat(9000) }, { dir, cli: "/bin/iris", exec })).reason).toContain("longer")
    expect((await sendInboxMessage({ to: "--all", text: "hi" }, { dir, cli: "/bin/iris", exec })).ok).toBe(false)
    const nocli = await sendInboxMessage({ to: "a", text: "hi" }, { dir, cli: null, exec })
    expect(nocli).toMatchObject({ measured: false, ok: false })
    expect(ran).toBe(0)
  })
})

describe("helpers", () => {
  test("validTarget", () => {
    expect(validTarget("iris-hive-001")).toBe(true)
    expect(validTarget("alex's macbook pro")).toBe(true)
    expect(validTarget("-x")).toBe(false)
    expect(validTarget("a\nb")).toBe(false)
    expect(validTarget("")).toBe(false)
  })
  test("parseSendJson reads the JSON the CLI prints last", () => {
    expect(parseSendJson('spinner…\n{"ok":true,"task_id":"t"}\n')).toEqual({ ok: true, task_id: "t" })
    expect(parseSendJson("nothing here")).toBeNull()
  })
  test("readOutbox: missing is empty; bad lines are counted, not hidden", () => {
    const { dir } = inbox([])
    expect(readOutbox(dir)).toEqual({ rows: [], unparsed: 0 })
    writeFileSync(path.join(path.dirname(dir), "outbox.jsonl"), 'junk\n{"to":"a","text":"b","id":"1","sentAt":"x"}\n')
    expect(readOutbox(dir)).toEqual({ rows: [{ to: "a", text: "b", id: "1", sentAt: "x" }], unparsed: 1 })
    expect(existsSync(path.join(path.dirname(dir), "outbox.jsonl"))).toBe(true)
  })
})

describe("delivery (#190982)", () => {
  const outbox = (dir: string, rows: object[], extra = "") =>
    writeFileSync(path.join(path.dirname(dir), "outbox.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + extra)
  const row = (id: string, o: object = {}) => ({ id, to: "iris-hive-001", text: "hi", sentAt: "2026-10-23T18:25:00Z", taskId: `t-${id}`, ...o })

  test("deliveryOf reads the task the way a sender needs it", () => {
    expect(deliveryOf({ status: "completed", arrived_at: "2026-10-23T18:25:02Z" })).toEqual({ delivery: "delivered", deliveredAt: "2026-10-23T18:25:02Z" })
    expect(deliveryOf({ status: "failed", error: "Pinned to node 01a1, which is busy (CPU at 137%). Refusing to run it on a different machine." })).toEqual({
      delivery: "failed",
      deliveryReason: "their computer was busy (CPU at 137%)",
    })
    expect(deliveryOf({ status: "pending" })).toEqual({ delivery: "waiting" })
    expect(deliveryOf(null)).toBeNull()
    expect(deliveryOf({})).toBeNull()
  })

  test("shortReason keeps the first sentence and names the common causes plainly", () => {
    expect(shortReason("Node is offline.")).toBe("their computer is offline")
    expect(shortReason("Something else broke. More detail here.")).toBe("Something else broke.")
    expect(shortReason(undefined)).toBeUndefined()
  })

  test("resolves the unresolved rows, writes FINAL answers back, and never looks a final row up again", async () => {
    const { dir } = inbox([])
    outbox(dir, [row("a"), row("b"), row("c", { delivery: "delivered" })])
    const asked: string[] = []
    const tasks: Record<string, TaskView> = { "t-a": { status: "failed", error: "which is busy (CPU at 309%)" }, "t-b": { status: "pending" } }
    const r = await resolveDelivery({ dir, fetchTask: async (id) => (asked.push(id), tasks[id] ?? null) })
    expect(asked).toEqual(["t-a", "t-b"])
    expect(r.rows.map((x) => x.delivery)).toEqual(["failed", "waiting", "delivered"])
    // failed is final and persisted; waiting is not final, so it is looked up again next time
    const again: string[] = []
    await resolveDelivery({ dir, fetchTask: async (id) => (again.push(id), null) })
    expect(again).toEqual(["t-b"])
    expect(readOutbox(dir).rows[0]).toMatchObject({ delivery: "failed", deliveryReason: "their computer was busy (CPU at 309%)" })
  })

  test("a lookup that fails changes nothing — 'accepted' stays the truth", async () => {
    const { dir } = inbox([])
    outbox(dir, [row("a")])
    const r = await resolveDelivery({ dir, fetchTask: async () => { throw new Error("offline") } })
    expect(r.rows[0].delivery).toBeUndefined()
  })

  test("never rewrites an outbox that has a line it could not read", async () => {
    const { dir } = inbox([])
    outbox(dir, [row("a")], "not json\n")
    await resolveDelivery({ dir, fetchTask: async () => ({ status: "completed" }) })
    const raw = readFileSync(path.join(path.dirname(dir), "outbox.jsonl"), "utf-8")
    expect(raw).toContain("not json")
  })

  test("only the newest 20 unresolved rows are looked up", async () => {
    const { dir } = inbox([])
    outbox(dir, Array.from({ length: 30 }, (_, i) => row(String(i))))
    const asked: string[] = []
    await resolveDelivery({ dir, fetchTask: async (id) => (asked.push(id), null) })
    expect(asked.length).toBe(20)
    expect(asked[0]).toBe("t-10")
  })

  test("with no fetcher, the outbox is returned as it is", async () => {
    const { dir } = inbox([])
    outbox(dir, [row("a")])
    expect((await resolveDelivery({ dir, fetchTask: null })).rows).toHaveLength(1)
  })
})
