import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import {
  runRemoteGet, servingCandidates, parseServeReply, serveCommand, folderHost, SERVE_MARK,
  type RemoteGetDeps, type NodeLike, type ServeReply, type AskOutcome, type ServeRequest,
} from "./drives-remote"
import { runGet, GET_EXIT, type GetDeps } from "./platform-drives"
import { sha256File, bundleMembers, bundleHashFromLines } from "./drives-core"

// #193362 — `iris drives get` from a drive plugged into another of the user's machines. The remote
// layer (ssh to the node, `drives serve` there, scp back) is mocked: `ask` answers like the serving
// machine would, `pull` copies from a local folder standing in for that machine.

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-remote-")) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const now = Date.parse("2026-11-12T20:00:00Z")
const node = (name: string, status = "online", heartbeat = "2026-11-12T19:59:00Z"): NodeLike => ({
  id: `id-${name}-${status}`, name, connection_status: status, last_heartbeat_at: heartbeat,
})

describe("which machine is asked", () => {
  const nodes = [node("studio-mac"), node("laptop"), node("hive-002"), node("old-box", "offline", "2026-10-01T00:00:00Z"), node("hive-001")]

  test("the drive's last-seen machine first, then other machines that are up — never this one, never a dead one", () => {
    const got = servingCandidates({ external_id: "fs:abc", last_seen_on: "hive-002" }, nodes, "hive-001", now).map((n) => n.name)
    expect(got).toEqual(["hive-002", "studio-mac", "laptop"])
  })

  test("the last-seen machine is asked even when its heartbeat is stale (ssh can still work)", () => {
    const got = servingCandidates({ external_id: "fs:abc", last_seen_on: "old-box" }, nodes, "hive-001", now).map((n) => n.name)
    expect(got[0]).toBe("old-box")
  })

  test("a folder drive lives on one machine, so only that machine is asked", () => {
    expect(folderHost("dir:hive-002:/Users/x/Proof")).toBe("hive-002")
    expect(folderHost("fs:1234")).toBeNull()
    const got = servingCandidates({ external_id: "dir:hive-002:/Users/x/Proof", last_seen_on: "hive-002" }, nodes, "hive-001", now)
    expect(got.map((n) => n.name)).toEqual(["hive-002"])
    expect(servingCandidates({ external_id: "dir:hive-001:/srv/x" }, nodes, "hive-001", now)).toEqual([])
  })

  test("a re-registered machine (same name twice) is asked once, the live registration", () => {
    const dup = [node("hive-002", "offline", "2026-09-01T00:00:00Z"), node("hive-002")]
    const got = servingCandidates({ external_id: "fs:abc", last_seen_on: "hive-002" }, dup, "hive-001", now)
    expect(got).toHaveLength(1)
    expect(got[0].connection_status).toBe("online")
  })
})

describe("the serve line", () => {
  test("found among noise; the last one wins; garbage is null", () => {
    const r: ServeReply = { ok: true, code: 0, file: "/x/a.wav", sha256: "ab" }
    expect(parseServeReply(`Update available!\n${SERVE_MARK}${JSON.stringify(r)}\n`)).toEqual(r)
    expect(parseServeReply("zsh: command not found: iris")).toBeNull()
    expect(parseServeReply(`${SERVE_MARK}{not json`)).toBeNull()
  })

  test("the command quotes every argument and finds the installed iris", () => {
    const req: ServeRequest = { driveId: "dir:hive-002:/Users/x/My Proof", rel: "it's here.wav", why: "a; rm -rf /", confirm: true, bloq: 916, asker: "hive-001" }
    const c = serveCommand(req, "")
    expect(c).toContain('IRIS="$HOME/.iris/bin/iris"')
    expect(c).toContain(`drives serve 'dir:hive-002:/Users/x/My Proof:it'\\''s here.wav'`)
    expect(c).toContain(`--why 'a; rm -rf /'`)
    expect(c).toContain("--bloq 916 --for 'hive-001' --confirm")
    expect(serveCommand(req, "/tmp/iris-test")).toStartWith("IRIS='/tmp/iris-test';")
  })
})

// ── runRemoteGet ──────────────────────────────────────────────────────────────────

const DRIVE = { external_id: "fs:abc", label: "Studio", encrypted: false, private_excluded: "Personal", last_seen_on: "hive-002", last_seen_at: "2026-11-12T19:00:00Z" }

function harness(over: Partial<RemoteGetDeps> & { answers?: Record<string, AskOutcome | ((req: ServeRequest) => AskOutcome)> } = {}) {
  // The serving machine's disk, standing in for the far end of the scp.
  const far = fs.mkdtempSync(path.join(tmp, "far-"))
  fs.writeFileSync(path.join(far, "kick.wav"), "kick drum")
  const asked: string[] = []
  const cleaned: string[] = []
  const audit: any[][] = []
  const served = (file: string, extra: Partial<ServeReply> = {}): AskOutcome => ({
    kind: "reply",
    reply: { ok: true, code: 0, file, stage: null, drive_id: "fs:abc", path: "Stems/kick.wav", bytes: 9, sha256: sha("kick drum"), file_sha256: sha("kick drum"), bundle: false, ...extra },
  })
  const answers: Record<string, AskOutcome | ((req: ServeRequest) => AskOutcome)> = {
    "hive-002": served(path.join(far, "kick.wav")),
    ...over.answers,
  }
  const deps: RemoteGetDeps = {
    drives: async () => [DRIVE],
    findings: async () => [{ path: "Site/.env", kind: "credential", status: "exposed" }],
    ensureReadsDataset: async () => {},
    writeAudit: async (rows) => { audit.push(rows); return { created: rows.length, updated: 0, failed: 0 } },
    account: async () => "alex@example.com",
    host: "hive-001",
    now: () => new Date("2026-11-12T20:00:00Z"),
    nodes: async () => [node("hive-001"), node("hive-002"), node("studio-mac")],
    ask: async (n, req) => {
      asked.push(n.name)
      const a = answers[n.name] ?? { kind: "reply", reply: { ok: false, code: 2, error: "not connected" } }
      return typeof a === "function" ? a(req) : a
    },
    pull: async (_n, remoteFile, localDir) => {
      const dest = path.join(localDir, path.basename(remoteFile))
      fs.copyFileSync(remoteFile, dest)
      return { ok: true, localPath: dest, sha256: sha256File(dest) }
    },
    cleanup: async (_n, stage) => { cleaned.push(stage) },
    ...over,
  }
  const to = fs.mkdtempSync(path.join(tmp, "to-"))
  return { deps, asked, cleaned, audit, to, far, served }
}
const get = (h: ReturnType<typeof harness>, extra: Partial<Parameters<typeof runRemoteGet>[0]> = {}) =>
  runRemoteGet({ ref: "Studio:Stems/kick.wav", to: h.to, why: "mixdown", bloq: 916, ...extra }, h.deps)

describe("iris drives get — from another machine", () => {
  test("asks the last-seen machine, fetches, checks, and records BOTH machines", async () => {
    const h = harness()
    const r = await get(h)
    expect(r.code).toBe(0)
    expect(h.asked).toEqual(["hive-002"])
    expect(fs.readFileSync(path.join(h.to, "kick.wav"), "utf8")).toBe("kick drum")
    expect(fs.readdirSync(h.to)).toEqual(["kick.wav"]) // the landing folder is gone
    expect(h.audit).toEqual([[{
      external_id: "fs:abc:Stems/kick.wav:2026-11-12T20:00:00Z", drive_id: "fs:abc", drive_label: "Studio", path: "Stems/kick.wav",
      bytes: 9, sha256: sha("kick drum"), read_by: "alex@example.com", read_on: "hive-001", served_by: "hive-002", purpose: "mixdown",
      at: "2026-11-12T20:00:00Z",
    }]])
    expect(r.served_by).toBe("hive-002")
    expect(r.out.join("\n")).toContain("on hive-002")
  })

  test("not on the last-seen machine → the next machine that is up is asked", async () => {
    const h = harness()
    const h2 = harness({ answers: { "hive-002": { kind: "reply", reply: { ok: false, code: 2, error: "not connected" } }, "studio-mac": h.served(path.join(h.far, "kick.wav")) } })
    const r = await get(h2)
    expect(r.code).toBe(0)
    expect(h2.asked).toEqual(["hive-002", "studio-mac"])
    expect(h2.audit[0][0].served_by).toBe("studio-mac")
  })

  test("--from asks only that machine", async () => {
    const h = harness()
    const r = await get(h, { from: "studio-mac" })
    expect(h.asked).toEqual(["studio-mac"])
    expect(r.code).toBe(GET_EXIT.notConnected)
    expect(r.err.join("\n")).toMatch(/Studio is not connected to studio-mac.*last seen on hive-002/s)
    expect(h.audit).toEqual([])
  })

  test("--from a machine that does not exist is a plain error", async () => {
    const h = harness()
    const r = await get(h, { from: "nope" })
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toMatch(/None of your machines is called "nope"/)
    expect(h.asked).toEqual([])
  })

  test("a sensitive file needs --confirm — refused HERE, no machine is contacted", async () => {
    const h = harness()
    const r = await get(h, { ref: "Studio:Site/.env" })
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toMatch(/sensitive file \(credential\).*--confirm/s)
    expect(h.asked).toEqual([])
    expect(h.audit).toEqual([])
  })

  test("--confirm is passed on to the serving machine", async () => {
    let seen: ServeRequest | null = null
    const h = harness({ answers: { "hive-002": (req) => { seen = req; return { kind: "reply", reply: { ok: false, code: 1, error: "nope" } } } } })
    await get(h, { ref: "Studio:Site/.env", confirm: true })
    expect(seen!.confirm).toBe(true)
    expect(seen!.rel).toBe("Site/.env")
    expect(seen!.asker).toBe("hive-001")
  })

  test("a private folder is never read — refused HERE, no machine is contacted", async () => {
    for (const ref of ["Studio:Personal/taxes.pdf", "Studio:personal/taxes.pdf", "Studio:Stems/../Personal/taxes.pdf"]) {
      const h = harness()
      const r = await get(h, { ref })
      expect(r.code).toBe(1)
      expect(r.err.join("\n")).toMatch(/private folder/)
      expect(h.asked).toEqual([])
    }
  })

  test("a link that resolves into a private folder on the serving machine is not kept", async () => {
    const h = harness()
    const h2 = harness({ answers: { "hive-002": h.served(path.join(h.far, "kick.wav"), { path: "Personal/kick.wav", stage: "/tmp/iris-drives-serve-abc" }) } })
    const r = await get(h2)
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toMatch(/private folder/)
    expect(fs.readdirSync(h2.to)).toEqual([])
    expect(h2.cleaned).toEqual(["/tmp/iris-drives-serve-abc"])
    expect(h2.audit).toEqual([])
  })

  test("a refusal from the serving machine is passed through with its name", async () => {
    const h = harness({ answers: { "hive-002": { kind: "reply", reply: { ok: false, code: 1, error: "Stems is a folder. get copies ONE file" } } } })
    const r = await get(h)
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toBe("hive-002: Stems is a folder. get copies ONE file")
    expect(h.asked).toEqual(["hive-002"]) // a definite answer: nobody else is asked
  })

  test("checksum mismatch after the transfer → exit 5, nothing kept, nothing recorded", async () => {
    const h = harness()
    const h2 = harness({ answers: { "hive-002": h.served(path.join(h.far, "kick.wav"), { file_sha256: sha("something else"), stage: "/tmp/iris-drives-serve-x1" }) } })
    const r = await get(h2)
    expect(r.code).toBe(GET_EXIT.mismatch)
    expect(r.err.join("\n")).toMatch(/does not match the original/)
    expect(fs.readdirSync(h2.to)).toEqual([])
    expect(h2.audit).toEqual([])
    expect(h2.cleaned).toEqual(["/tmp/iris-drives-serve-x1"]) // the serving machine's stage is still cleaned up
  })

  test("the transfer's own checksum failure is exit 5 too", async () => {
    const h = harness({ pull: async () => ({ ok: false, localPath: "", sha256: null, error: "CHECKSUM MISMATCH — node abc… vs local def…" }) })
    const r = await get(h)
    expect(r.code).toBe(GET_EXIT.mismatch)
    expect(h.audit).toEqual([])
  })

  test("file moved since the scan → exit 3, named machine", async () => {
    const h = harness({ answers: { "hive-002": { kind: "reply", reply: { ok: false, code: 3, error: "Studio is connected at /Volumes/Studio, but Stems/kick.wav is not there (moved or deleted since the last scan)" } } } })
    const r = await get(h)
    expect(r.code).toBe(GET_EXIT.moved)
    expect(r.err.join("\n")).toMatch(/^hive-002: .*moved or deleted since the last scan/)
  })

  test("the last-seen machine is offline → exit 4, named", async () => {
    const h = harness({ answers: { "hive-002": { kind: "offline", error: "ssh: connect to host 100.79.138.21 port 22: Operation timed out" } } })
    const r = await get(h)
    expect(r.code).toBe(GET_EXIT.nodeOffline)
    expect(r.err.join("\n")).toMatch(/hive-002 is not answering/)
    expect(h.asked).toEqual(["hive-002", "studio-mac"])
  })

  test("not connected anywhere → exit 2, names where it was last seen", async () => {
    const h = harness({ answers: { "hive-002": { kind: "reply", reply: { ok: false, code: 2, error: "not connected" } } } })
    const r = await get(h)
    expect(r.code).toBe(GET_EXIT.notConnected)
    expect(r.err.join("\n")).toMatch(/Studio is not connected to any of your machines \(asked: this computer, hive-002, studio-mac\)\. It was last seen on hive-002/)
  })

  test("a machine whose IRIS cannot serve says to update it", async () => {
    const h = harness({
      nodes: async () => [node("hive-002")],
      answers: { "hive-002": { kind: "unable", error: "Unknown argument: serve" } },
    })
    const r = await get(h)
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toMatch(/IRIS on hive-002 could not serve the read \(Unknown argument: serve\)\. Update it there: iris update/)
  })

  test("an existing file at the destination is never overwritten", async () => {
    const h = harness()
    fs.writeFileSync(path.join(h.to, "kick.wav"), "mine")
    const r = await get(h)
    expect(r.code).toBe(1)
    expect(fs.readFileSync(path.join(h.to, "kick.wav"), "utf8")).toBe("mine")
    expect(h.audit).toEqual([])
  })

  test("if the read cannot be recorded, the copy is removed", async () => {
    const h = harness({ writeAudit: async () => { throw new Error("HTTP 500") } })
    const r = await get(h)
    expect(r.code).toBe(1)
    expect(fs.readdirSync(h.to)).toEqual([])
  })
})

// ── the serving half: runGet in serve mode ──────────────────────────────────────

describe("iris drives serve (runGet serve mode)", () => {
  let mount: string
  let d: GetDeps
  let audit: any[]
  beforeAll(() => {
    mount = path.join(tmp, "ServeVolume")
    const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(mount, rel)), { recursive: true }); fs.writeFileSync(path.join(mount, rel), body) }
    put("Stems/kick.wav", "kick drum")
    put("Site/.env", "SECRET=1")
    put("Personal/taxes.pdf", "private")
    put("Songs/Track.logicx/Resources/kick.wav", "kick")
    put("Songs/Track.logicx/Alternatives/000/ProjectData", "pd")
    audit = []
    d = {
      drives: async () => [{ external_id: `dir:${os.hostname()}:${mount}`, label: "Studio", private_excluded: "Personal" }],
      findings: async () => [],
      ensureReadsDataset: async () => {},
      writeAudit: async (rows) => { audit.push(rows); return { created: 1, updated: 0, failed: 0 } },
      account: async () => "x",
      host: "hive-002",
      now: () => new Date(),
    }
  })

  test("a plain file is hashed in place: nothing copied, nothing recorded on the serving machine", async () => {
    const stage = fs.mkdtempSync(path.join(tmp, "stage-"))
    const r = await runGet({ ref: "Studio:Stems/kick.wav", to: stage, why: "mixdown", serve: true }, d)
    expect(r.code).toBe(0)
    expect(r.dest).toBe(fs.realpathSync(path.join(mount, "Stems/kick.wav")))
    expect(r.row).toEqual({ drive_id: `dir:${os.hostname()}:${mount}`, drive_label: "Studio", path: "Stems/kick.wav", bytes: 9, sha256: sha("kick drum"), file_sha256: sha("kick drum"), bundle: false })
    expect(fs.readdirSync(stage)).toEqual([])
    expect(audit).toEqual([])
  })

  test("a bundle is zipped into the stage; the reply carries the bundle hash AND the zip's hash", async () => {
    const stage = fs.mkdtempSync(path.join(tmp, "stage-"))
    const r = await runGet({ ref: "Studio:Songs/Track.logicx", to: stage, why: "mixdown", serve: true }, d)
    expect(r.code).toBe(0)
    expect(r.dest).toBe(path.join(stage, "Track.logicx.zip"))
    const members = bundleMembers(path.join(mount, "Songs/Track.logicx"))
    expect(r.row.sha256).toBe(bundleHashFromLines(members.map(([rel, p]) => [rel, sha256File(p)] as [string, string])))
    expect(r.row.file_sha256).toBe(sha256File(r.dest!))
    expect(r.row.bundle).toBe(true)
    expect(audit).toEqual([])
  })

  test("the serving machine applies the same refusals", async () => {
    const stage = fs.mkdtempSync(path.join(tmp, "stage-"))
    expect((await runGet({ ref: "Studio:Personal/taxes.pdf", to: stage, why: "x", serve: true }, d)).code).toBe(1)
    expect((await runGet({ ref: "Studio:Site/.env", to: stage, why: "x", serve: true }, d)).code).toBe(1)
    expect((await runGet({ ref: "Studio:Stems/gone.wav", to: stage, why: "x", serve: true }, d)).code).toBe(GET_EXIT.moved)
    expect(fs.readdirSync(stage)).toEqual([])
  })

  test("end to end: a remote get of a bundle checks the zip's contents against the bundle hash", async () => {
    const stage = fs.mkdtempSync(path.join(tmp, "stage-"))
    const served = await runGet({ ref: "Studio:Songs/Track.logicx", to: stage, why: "mixdown", serve: true }, d)
    const h = harness({ answers: { "hive-002": { kind: "reply", reply: { ok: true, code: 0, file: served.dest, stage, ...served.row, drive_id: "fs:abc", path: "Songs/Track.logicx" } } } })
    const r = await runRemoteGet({ ref: "Studio:Songs/Track.logicx", to: h.to, why: "mixdown", bloq: 916 }, h.deps)
    expect(r.code).toBe(0)
    expect(fs.readdirSync(h.to)).toEqual(["Track.logicx.zip"])
    expect(h.audit[0][0].sha256).toBe(served.row.sha256)
    expect(h.cleaned).toEqual([stage])
  })
})
