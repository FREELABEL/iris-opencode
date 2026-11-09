import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

/**
 * `iris hive vault put|get|ls|status` on an encrypted PHI vault (#192914).
 *
 * The bug: `vault create --encrypted` made a vault that `vault list` showed, and `vault put` then
 * said `no vault named "<name>"` — put/get/ls/status only looked at replicated vaults — and the
 * failure came out as "Unexpected error" plus a dump of the minified bundle.
 *
 * These run the REAL CLI in a throwaway HOME, so nothing here can touch a real vault. The
 * encrypted-vault module is the installed daemon's own (copied in) when this machine has one —
 * the faithful case — and otherwise a stand-in with the same interface, so CI still runs.
 * The daemon is pointed at a closed port: lock state then comes from the vault registry.
 */

const ROOT = join(import.meta.dir, "..", "..", "..")
const ENTRY = join(ROOT, "src", "index.ts")
const DAEMON_LIB = join(homedir(), ".iris", "bridge", "lib")

// Same interface as iris-daemon lib/encrypted-vault.js, minus the crypto. Lock semantics match.
const FAKE_MODULE = `
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const root = () => path.join(os.homedir(), '.iris', 'vaults')
const reg = () => { try { return JSON.parse(fs.readFileSync(path.join(root(), 'registry.json'), 'utf8')) } catch { return { vaults: {} } } }
const save = (r) => { fs.mkdirSync(root(), { recursive: true }); fs.writeFileSync(path.join(root(), 'registry.json'), JSON.stringify(r)) }
const dir = (e) => path.join(root(), e.id)
const man = (e) => { try { return JSON.parse(fs.readFileSync(path.join(dir(e), 'manifest.json'), 'utf8')) } catch { return { objects: {} } } }
const saveMan = (e, m) => fs.writeFileSync(path.join(dir(e), 'manifest.json'), JSON.stringify(m))
function getEntry (name) { const e = reg().vaults[name]; if (!e) { const x = new Error('no vault named "' + name + '"'); x.code = 'not_found'; throw x } return e }
function dekFor (e) { if (e.locked) { const x = new Error('vault "' + e.name + '" is locked'); x.code = 'locked'; throw x } return Buffer.alloc(32, 7) }
function createVault ({ name, bloqId = null }) { const r = reg(); const entry = { id: crypto.randomUUID(), name, bloq_id: bloqId, key_source: 'keychain', locked: false, phi: true }; r.vaults[name] = entry; save(r); fs.mkdirSync(path.join(dir(entry), 'objects'), { recursive: true }); saveMan(entry, { objects: {} }); return { entry, dek: Buffer.alloc(32) } }
function lock (name) { const r = reg(); r.vaults[name].locked = true; save(r) }
function isLocked (e) { return !!e.locked }
function unlock (name) { const r = reg(); r.vaults[name].locked = false; save(r) }
function summary (e) { const o = Object.values(man(e).objects); return { name: e.name, bloq_id: e.bloq_id, key_source: e.key_source, locked: isLocked(e), phi: e.phi, files: o.length, bytes: o.reduce((a, x) => a + x.size, 0), last_write_at: null } }
async function putFile (e, src, meta = {}) { dekFor(e); const id = crypto.randomUUID(); const b = fs.readFileSync(src); fs.writeFileSync(path.join(dir(e), 'objects', id), Buffer.from(b).reverse()); const m = man(e); m.objects[id] = { size: b.length, kind: meta.kind, name: meta.name, created_at: new Date().toISOString() }; saveMan(e, m); return { fileId: id, size: b.length } }
const plain = (e, id) => { dekFor(e); return Buffer.from(fs.readFileSync(path.join(dir(e), 'objects', id))).reverse() }
async function readObject (e, id) { return { meta: {}, data: plain(e, id) } }
function shredObject (e, id) { const m = man(e); delete m.objects[id]; saveMan(e, m); return 0 }
async function listFiles (name) { const e = getEntry(name); dekFor(e); return Object.entries(man(e).objects).map(([id, o]) => ({ file_id: id, name: o.name, kind: o.kind, size: o.size, created_at: o.created_at })) }
async function exportObject (e, id, out) { fs.writeFileSync(out, plain(e, id)) }
module.exports = { getEntry, dekFor, createVault, lock, isLocked, unlock, summary, putFile, readObject, shredObject, listFiles, exportObject, retentionDays: () => 30 }
`

const sources = [
  { label: "stand-in module", real: false },
  ...(existsSync(join(DAEMON_LIB, "encrypted-vault.js")) ? [{ label: "installed daemon module", real: true }] : []),
]

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
// Colour codes, and one dev-tree-only warning a browser-data dependency prints when run from
// source (it is not in the shipped binary).
const strip = (s: string) =>
  s.replace(/\x1b?\[[0-9;]*m/g, "").split("\n").filter((l) => !l.startsWith("[baseline-browser-mapping]")).join("\n")

for (const src of sources) {
  describe(`iris hive vault on an encrypted PHI vault (${src.label})`, () => {
    let home: string
    let work: string
    let env: Record<string, string>

    async function iris(...argv: string[]) {
      const proc = Bun.spawn(["bun", ENTRY, "hive", "vault", ...argv], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env })
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      return { code, stdout: strip(stdout), stderr: strip(stderr) }
    }

    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), "iris-vault-test-"))
      work = join(home, "work")
      mkdirSync(work)
      const lib = join(home, ".iris", "bridge", "lib")
      mkdirSync(lib, { recursive: true })
      if (src.real) {
        cpSync(join(DAEMON_LIB, "encrypted-vault.js"), join(lib, "encrypted-vault.js"))
        cpSync(join(DAEMON_LIB, "node-vault.js"), join(lib, "node-vault.js"))
      } else {
        writeFileSync(join(lib, "encrypted-vault.js"), FAKE_MODULE)
      }
      env = {
        ...process.env,
        HOME: home,
        IRIS_VAULT_BACKEND: "file", // the daemon's keystore, kept inside this HOME
        BRIDGE_URL: "http://127.0.0.1:9", // no daemon: nothing to ask, nothing to touch
        IRIS_NON_INTERACTIVE: "1",
      } as Record<string, string>
      const setup = Bun.spawnSync(["bun", "-e", `
        const v = require(${JSON.stringify(join(lib, "encrypted-vault.js"))})
        v.createVault({ name: "phi-test", bloqId: "503", phi: true })
        v.createVault({ name: "phi-locked", bloqId: "503", phi: true })
        v.lock("phi-locked")
      `], { env, cwd: work })
      if (setup.exitCode !== 0) throw new Error("setup failed: " + setup.stderr.toString())
    })

    afterAll(() => rmSync(home, { recursive: true, force: true }))

    test("put → ls → get round-trips the exact bytes", async () => {
      const bytes = Buffer.concat([randomBytes(3 * 1024 * 1024 + 17), Buffer.from("tail")]) // > 1 MiB chunk
      writeFileSync(join(work, "scan.bin"), bytes)

      const put = await iris("put", "phi-test", join(work, "scan.bin"), "--as", "notes/scan.bin")
      expect(put.stderr).toBe("")
      expect(put.code).toBe(0)
      expect(put.stdout).toContain(sha(bytes))
      expect(put.stdout).toContain("read back and verified")

      const ls = await iris("ls", "phi-test", "--json")
      expect(ls.code).toBe(0)
      const files = JSON.parse(ls.stdout).files
      expect(files.map((f: any) => f.name)).toEqual(["notes/scan.bin"])
      expect(files[0].size).toBe(bytes.length)

      const get = await iris("get", "phi-test", "notes/scan.bin", "--out", join(work, "restored"), "--json")
      expect(get.code).toBe(0)
      const out = readFileSync(join(work, "restored", "scan.bin"))
      expect(out.equals(bytes)).toBe(true)
      expect(JSON.parse(get.stdout).sha256).toBe(sha(bytes))

      const status = await iris("status", "phi-test", "--json")
      expect(status.code).toBe(0)
      expect(JSON.parse(status.stdout)).toMatchObject({ name: "phi-test", files: 1, replicated: false, locked: false })
    }, 120_000)

    if (src.real) {
      test("what lands on disk is ciphertext, not the file", async () => {
        const marker = "PATIENT-NAME-" + randomBytes(8).toString("hex")
        writeFileSync(join(work, "marker.txt"), marker)
        expect((await iris("put", "phi-test", join(work, "marker.txt"))).code).toBe(0)
        const found = Bun.spawnSync(["grep", "-rl", marker, join(home, ".iris", "vaults")])
        expect(found.stdout.toString()).toBe("")
      }, 120_000)
    }

    test("a locked vault refuses put, with how to unlock it", async () => {
      writeFileSync(join(work, "a.txt"), "hello")
      const r = await iris("put", "phi-locked", join(work, "a.txt"))
      expect(r.code).toBe(1)
      expect(r.stderr.trim()).toBe('error: vault "phi-locked" is locked — unlock it first: iris hive vault unlock phi-locked')
      expect(r.stdout.trim()).toBe("")
      const ls = await iris("status", "phi-locked", "--json")
      expect(JSON.parse(ls.stdout).files).toBe(0)
    }, 120_000)

    test("an unknown vault: one sentence on stderr, exit 1, no source dump", async () => {
      writeFileSync(join(work, "a.txt"), "hello")
      for (const argv of [["put", "nope", join(work, "a.txt")], ["get", "nope", "a.txt"], ["ls", "nope"], ["status", "nope"]]) {
        const r = await iris(...argv)
        expect(r.code).toBe(1)
        expect(r.stderr.trim()).toBe('error: no vault named "nope" on this machine. Run: iris hive vault list')
        expect(r.stdout.trim()).toBe("")
      }
    }, 120_000)

    test("replicated vaults behave as before (and win a name clash)", async () => {
      const c = await iris("create", "phi-test", "--json") // same name as the encrypted vault
      expect(c.code).toBe(0)
      const ls = await iris("ls", "phi-test", "--json")
      expect(ls.code).toBe(0)
      const body = JSON.parse(ls.stdout)
      expect(body.encrypted).toBeUndefined()
      expect(body).toMatchObject({ ok: true, vault: "phi-test", seq: 0, files: [] })
    }, 120_000)
  })
}
