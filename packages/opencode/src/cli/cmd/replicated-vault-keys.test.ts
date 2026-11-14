import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  ReplicatedKeyStore, seal, unseal, passphraseKek, sealExport, openExport, SCRYPT_PARAMS,
  PLAINTEXT_FILE, WRAPPED_FILE, type KeyStoreOptions, type SecretStore,
} from "./replicated-vault-keys"
import { buildEntry, reassemble } from "./vault-core"

/**
 * #193396 — replicated-vault keys wrapped at rest, and the plaintext vault-keys.json migrated.
 * Everything runs in a throwaway directory; no real keystore, node key or ~/.iris is touched.
 */

const ROOT = join(import.meta.dir, "..", "..", "..")
const ENTRY = join(ROOT, "src", "index.ts")

let dir: string
let irisDir: string
let nodeKeyFile: string

const unavailable: SecretStore = { available: () => false, get: () => null, set: () => { throw new Error("no keystore") } }
function memoryKeychain(): SecretStore & { value: Buffer | null } {
  const s: any = { value: null, available: () => true, get: () => s.value, set: (k: Buffer) => { s.value = Buffer.from(k) } }
  return s
}
function writeNodeKey(file: string, key: Buffer): boolean {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o400 })
  return true
}
function opts(over: Partial<KeyStoreOptions> = {}): KeyStoreOptions {
  return { irisDir, nodeKeyFile, keychain: unavailable, libsecret: unavailable, createNodeKey: writeNodeKey, ...over }
}
function legacy(keys: Record<string, Buffer>, mode = 0o600) {
  mkdirSync(irisDir, { recursive: true })
  const obj = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.toString("base64")]))
  writeFileSync(join(irisDir, PLAINTEXT_FILE), JSON.stringify(obj, null, 2), { mode })
  chmodSync(join(irisDir, PLAINTEXT_FILE), mode)
}
const wrappedText = () => readFileSync(join(irisDir, WRAPPED_FILE), "utf8")
const leftovers = () => readdirSync(irisDir).filter((n) => n.includes(".tmp-") || n.includes(".shred-") || n === "vault-keys.lock")
function noKeyBytesIn(text: string, keys: Buffer[]) {
  for (const k of keys) {
    expect(text.includes(k.toString("base64"))).toBe(false)
    expect(text.includes(k.toString("hex"))).toBe(false)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iris-vk-test-"))
  irisDir = join(dir, "home", ".iris")
  nodeKeyFile = join(dir, "etc", "iris", "vault-kek", "1000.key")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("wrap / unwrap", () => {
  test("AES-256-GCM seal opens only with the same key and the same vault id", () => {
    const kek = randomBytes(32), key = randomBytes(32)
    const s = seal(kek, key, "a")
    expect(unseal(kek, s, "a").equals(key)).toBe(true)
    expect(() => unseal(randomBytes(32), s, "a")).toThrow()
    expect(() => unseal(kek, s, "b")).toThrow() // a key cannot be moved to another vault's slot
    const t = { ...s, ct: Buffer.from(Buffer.from(s.ct, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") }
    expect(() => unseal(kek, t, "a")).toThrow()
  })

  test("passphrase KEK: scrypt with the documented parameters, salt-dependent", () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 })
    const salt = randomBytes(16)
    expect(passphraseKek("correct horse", salt).equals(passphraseKek("correct horse", salt))).toBe(true)
    expect(passphraseKek("correct horse", salt).equals(passphraseKek("correct horse", randomBytes(16)))).toBe(false)
    expect(passphraseKek("café", salt).equals(passphraseKek("café", salt))).toBe(true) // NFKC
  }, 120_000)

  test("keychain backend: round trip across store instances, nothing readable on disk", async () => {
    const kc = memoryKeychain()
    const k1 = randomBytes(32), k2 = randomBytes(32)
    await new ReplicatedKeyStore(opts({ keychain: kc })).saveKey("v1", k1)
    await new ReplicatedKeyStore(opts({ keychain: kc })).saveKey("v2", k2)
    const fresh = new ReplicatedKeyStore(opts({ keychain: kc }))
    expect((await fresh.getKey("v1"))!.equals(k1)).toBe(true)
    expect((await fresh.getKey("v2"))!.equals(k2)).toBe(true)
    expect(await fresh.getKey("nope")).toBeNull()
    expect(JSON.parse(wrappedText()).backend).toBe("keychain")
    expect(statSync(join(irisDir, WRAPPED_FILE)).mode & 0o777).toBe(0o600)
    noKeyBytesIn(wrappedText(), [k1, k2, kc.value!])
    expect(existsSync(nodeKeyFile)).toBe(false)
    // the file alone (a backup, a synced folder, a drive) opens nothing
    const thief = new ReplicatedKeyStore(opts({ keychain: memoryKeychain() }))
    await expect(thief.getKey("v1")).rejects.toThrow(/does not open|missing/)
  })

  test("headless: node-key backend outside the iris dir when there is no keystore", async () => {
    const k = randomBytes(32)
    await new ReplicatedKeyStore(opts()).saveKey("v1", k)
    expect(JSON.parse(wrappedText()).backend).toBe("node-key")
    expect(JSON.parse(wrappedText()).node_key_file).toBe(nodeKeyFile)
    expect(nodeKeyFile.startsWith(irisDir)).toBe(false)
    noKeyBytesIn(wrappedText(), [k, Buffer.from(readFileSync(nodeKeyFile, "utf8").trim(), "base64")])
    expect((await new ReplicatedKeyStore(opts()).getKey("v1"))!.equals(k)).toBe(true)
    // the iris dir copied elsewhere (backup, external drive) without the node key: useless
    rmSync(nodeKeyFile)
    await expect(new ReplicatedKeyStore(opts()).getKey("v1")).rejects.toThrow(/missing from the node key file/)
  })

  test("node key readable by others is refused", async () => {
    await new ReplicatedKeyStore(opts()).saveKey("v1", randomBytes(32))
    chmodSync(nodeKeyFile, 0o444)
    await expect(new ReplicatedKeyStore(opts()).getKey("v1")).rejects.toThrow(/chmod 600/)
  })

  test("passphrase backend: right passphrase opens, wrong one and no prompt are refused", async () => {
    const noNode = { createNodeKey: () => false }
    const k = randomBytes(32)
    await new ReplicatedKeyStore(opts({ ...noNode, passphrase: async () => "long enough pass" })).saveKey("v1", k)
    const doc = JSON.parse(wrappedText())
    expect(doc.backend).toBe("passphrase")
    expect(doc.kdf).toMatchObject({ alg: "scrypt", N: 131072, r: 8, p: 1 })
    expect((await new ReplicatedKeyStore(opts({ ...noNode, passphrase: async () => "long enough pass" })).getKey("v1"))!.equals(k)).toBe(true)
    await expect(new ReplicatedKeyStore(opts({ ...noNode, passphrase: async () => "wrong passphrase" })).getKey("v1")).rejects.toThrow(/wrong passphrase/)
    await expect(new ReplicatedKeyStore(opts({ ...noNode })).getKey("v1")).rejects.toThrow(/--passphrase-stdin/)
  }, 120_000)

  test("nowhere safe to keep a key: refuses with the fix, writes nothing", async () => {
    await expect(new ReplicatedKeyStore(opts({ createNodeKey: () => false })).saveKey("v1", randomBytes(32))).rejects.toThrow(/iris vault key setup --node-key/)
    expect(existsSync(join(irisDir, WRAPPED_FILE))).toBe(false)
  })
})

describe("migration from plaintext vault-keys.json", () => {
  test("first use wraps every key, verifies, and shreds the plaintext", async () => {
    const keys = { a: randomBytes(32), b: randomBytes(32), c: randomBytes(32) }
    legacy(keys)
    const s = new ReplicatedKeyStore(opts())
    expect(s.ids()).toEqual(new Set(["a", "b", "c"])) // listing needs no migration
    expect((await s.getKey("b"))!.equals(keys.b)).toBe(true)
    expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(false)
    expect(leftovers()).toEqual([])
    noKeyBytesIn(wrappedText(), Object.values(keys))
    const again = new ReplicatedKeyStore(opts())
    for (const [id, k] of Object.entries(keys)) expect((await again.getKey(id))!.equals(k)).toBe(true)
  })

  test("a key added later by an old CLI is merged on the next use", async () => {
    const a = randomBytes(32), b = randomBytes(32)
    legacy({ a })
    await new ReplicatedKeyStore(opts()).getKey("a")
    legacy({ b })
    const s = new ReplicatedKeyStore(opts())
    expect((await s.getKey("b"))!.equals(b)).toBe(true)
    expect((await s.getKey("a"))!.equals(a)).toBe(true)
    expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(false)
  })

  test("a disagreement between the two files is refused and nothing is shredded", async () => {
    await new ReplicatedKeyStore(opts()).saveKey("a", randomBytes(32))
    legacy({ a: randomBytes(32) })
    await expect(new ReplicatedKeyStore(opts()).getKey("a")).rejects.toThrow(/different key/)
    expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(true)
  })

  for (const mode of [0o644, 0o640, 0o604]) {
    test(`plaintext file with mode ${mode.toString(8)} is refused with a fix, and left untouched`, async () => {
      const k = randomBytes(32)
      legacy({ a: k }, mode)
      const before = readFileSync(join(irisDir, PLAINTEXT_FILE), "utf8")
      const s = new ReplicatedKeyStore(opts())
      await expect(s.getKey("a")).rejects.toThrow(/chmod 600 ~\/\.iris\/vault-keys\.json/)
      expect(() => s.ids()).toThrow(/readable or writable by other users/)
      expect(readFileSync(join(irisDir, PLAINTEXT_FILE), "utf8")).toBe(before)
      expect(existsSync(join(irisDir, WRAPPED_FILE))).toBe(false)
      chmodSync(join(irisDir, PLAINTEXT_FILE), 0o600) // the fix works
      expect((await new ReplicatedKeyStore(opts()).getKey("a"))!.equals(k)).toBe(true)
    })
  }

  test("a group-readable wrapped file is refused too", async () => {
    await new ReplicatedKeyStore(opts()).saveKey("a", randomBytes(32))
    chmodSync(join(irisDir, WRAPPED_FILE), 0o640)
    await expect(new ReplicatedKeyStore(opts()).getKey("a")).rejects.toThrow(/chmod 600 ~\/\.iris\/vault-keys\.wrapped\.json/)
  })

  // The process is KILLED (SIGKILL — no finally blocks, no cleanup) at each step of the
  // migration, then a fresh process runs. Every key must survive, and the plaintext must be gone.
  for (const fault of ["afterTmpWrite", "afterRename", "beforeShred"] as const) {
    test(`interrupted migration (killed ${fault}) loses nothing and finishes on the next run`, async () => {
      const keys = { a: randomBytes(32), b: randomBytes(32), c: randomBytes(32) }
      legacy(keys)
      const script = join(dir, "kill.ts")
      writeFileSync(script, `
        import { ReplicatedKeyStore } from ${JSON.stringify(join(import.meta.dir, "replicated-vault-keys.ts"))}
        import { mkdirSync, writeFileSync } from "fs"
        import { join } from "path"
        const [irisDir, nodeKeyFile, fault] = process.argv.slice(2)
        const die = () => process.kill(process.pid, "SIGKILL")
        const s = new ReplicatedKeyStore({
          irisDir, nodeKeyFile,
          keychain: { available: () => false, get: () => null, set() {} },
          libsecret: { available: () => false, get: () => null, set() {} },
          createNodeKey: (f, k) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, k.toString("base64"), { mode: 0o400 }); return true },
          faults: { [fault]: die },
        })
        await s.getKey("a")
        console.log("NOT KILLED")
      `)
      const p = Bun.spawnSync(["bun", script, irisDir, nodeKeyFile, fault], { stdout: "pipe", stderr: "pipe" })
      expect(p.signalCode ?? p.exitCode).toBe("SIGKILL")
      expect(p.stdout.toString()).not.toContain("NOT KILLED")

      // State right after the crash: at least one complete copy of every key on disk.
      if (fault === "afterTmpWrite") {
        expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(true)
        expect(existsSync(join(irisDir, WRAPPED_FILE))).toBe(false)
        expect(leftovers().some((n) => n.includes(".tmp-"))).toBe(true)
      } else if (fault === "afterRename") {
        expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(true)
        expect(existsSync(join(irisDir, WRAPPED_FILE))).toBe(true)
      } else {
        expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(false)
        expect(leftovers().some((n) => n.includes(".shred-"))).toBe(true)
        expect(existsSync(join(irisDir, WRAPPED_FILE))).toBe(true)
      }
      // The killed process's lock is still on disk; its holder is dead, so the next run takes it.
      expect(existsSync(join(irisDir, "vault-keys.lock"))).toBe(true)

      const s = new ReplicatedKeyStore(opts())
      for (const [id, k] of Object.entries(keys)) expect((await s.getKey(id))!.equals(k)).toBe(true)
      expect(existsSync(join(irisDir, PLAINTEXT_FILE))).toBe(false)
      expect(leftovers()).toEqual([])
      noKeyBytesIn(wrappedText(), Object.values(keys))
    }, 60_000)
  }
})

describe("export / import and a full round trip", () => {
  test("export is passphrase-sealed; a wrong passphrase opens nothing", () => {
    const key = randomBytes(32)
    const b = sealExport({ vault_id: "v1", key: key.toString("base64") }, "export passphrase")
    expect(JSON.stringify(b).includes(key.toString("base64"))).toBe(false)
    expect(Buffer.from(openExport(b, "export passphrase").key, "base64").equals(key)).toBe(true)
    expect(() => openExport(b, "not the passphrase")).toThrow(/wrong passphrase/)
    expect(() => openExport({ ...b, vault_id: "v2" }, "export passphrase")).toThrow()
  }, 120_000)

  test("encrypt on machine A (keychain), restore on machine B (node key), byte-identical", async () => {
    const kcA = memoryKeychain()
    const a = new ReplicatedKeyStore(opts({ keychain: kcA }))
    await a.saveKey("vault-1", randomBytes(32))
    const plain = Buffer.concat([randomBytes(5 * 1024 * 1024), Buffer.from("invented line for #193396\n")])
    const { entry, blobs } = buildEntry((await a.getKey("vault-1"))!, plain, { chunkSize: 1024 * 1024 } as any)
    const bundle = sealExport({ vault_id: "vault-1", key: (await a.getKey("vault-1"))!.toString("base64") }, "move me safely")

    const irisB = join(dir, "machine-b", ".iris")
    const b = new ReplicatedKeyStore(opts({ irisDir: irisB, nodeKeyFile: join(dir, "machine-b-etc", "1000.key") }))
    await b.saveKey("vault-1", Buffer.from(openExport(JSON.parse(JSON.stringify(bundle)), "move me safely").key, "base64"))
    const map = new Map(blobs.map((x) => [x.ref.id, x.bytes]))
    const out = reassemble((await new ReplicatedKeyStore(opts({ irisDir: irisB, nodeKeyFile: join(dir, "machine-b-etc", "1000.key") })).getKey("vault-1"))!, entry, map)
    expect(out.equals(plain)).toBe(true)
    expect(JSON.parse(readFileSync(join(irisB, WRAPPED_FILE), "utf8")).backend).toBe("node-key")
  }, 120_000)
})

describe("iris vault key (the real CLI, throwaway HOME)", () => {
  async function iris(env: Record<string, string>, stdin: string | undefined, ...argv: string[]) {
    const proc = Bun.spawn(["bun", ENTRY, "vault", ...argv], {
      cwd: ROOT, stdout: "pipe", stderr: "pipe", env, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    })
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    // dev-tree-only warning a dependency prints when run from source (not in the shipped binary)
    const strip = (x: string) => x.split("\n").filter((l) => !l.startsWith("[baseline-browser-mapping]")).join("\n")
    return { code, stdout: strip(stdout), stderr: strip(stderr) }
  }
  const envFor = (home: string, nk: string) => ({
    PATH: process.env.PATH ?? "", HOME: home, IRIS_VAULT_KEY_BACKEND: "node-key", IRIS_VAULT_NODE_KEY_FILE: nk,
    IRIS_DAEMON_PORT: "1", NO_COLOR: "1",
  })

  test("create → plaintext legacy migrated by setup → export → import on another HOME", async () => {
    const homeA = join(dir, "A"), homeB = join(dir, "B")
    const envA = envFor(homeA, join(dir, "nkA", "1000.key")), envB = envFor(homeB, join(dir, "nkB", "1000.key"))
    // the node key normally comes from sudo; here it is made in the test dir
    writeNodeKey(envA.IRIS_VAULT_NODE_KEY_FILE, randomBytes(32))
    writeNodeKey(envB.IRIS_VAULT_NODE_KEY_FILE, randomBytes(32))

    const c = await iris(envA, undefined, "create", "zz-193396-test", "--replicas", "1", "--json")
    expect(c.code).toBe(0)
    const created = JSON.parse(c.stdout)
    expect(created.key_backend).toBe("node-key")
    expect(existsSync(join(homeA, ".iris", PLAINTEXT_FILE))).toBe(false)

    // an older CLI's plaintext key for another vault
    const legacyKey = randomBytes(32)
    writeFileSync(join(homeA, ".iris", PLAINTEXT_FILE), JSON.stringify({ "legacy-id": legacyKey.toString("base64") }), { mode: 0o644 })
    const refused = await iris(envA, undefined, "key", "setup")
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("chmod 600 ~/.iris/vault-keys.json")
    chmodSync(join(homeA, ".iris", PLAINTEXT_FILE), 0o600)
    const setup = await iris(envA, undefined, "key", "setup", "--json")
    expect(setup.code).toBe(0)
    expect(JSON.parse(setup.stdout)).toMatchObject({ migrated: 1, backend: "node-key", wrapped_keys: 2, plaintext_file_present: false })
    expect(existsSync(join(homeA, ".iris", PLAINTEXT_FILE))).toBe(false)

    const out = join(dir, "zz.ivk")
    const ex = await iris(envA, "export pass 193396\n", "key", "export", "zz-193396-test", "--out", out, "--passphrase-stdin", "--json")
    expect(ex.code).toBe(0)
    expect(statSync(out).mode & 0o777).toBe(0o600)

    const bad = await iris(envB, "wrong passphrase\n", "key", "import", out, "--passphrase-stdin")
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("wrong passphrase")
    const im = await iris(envB, "export pass 193396\n", "key", "import", out, "--passphrase-stdin", "--json")
    expect(im.code).toBe(0)
    expect(JSON.parse(im.stdout)).toMatchObject({ id: created.vault.id, name: "zz-193396-test", backend: "node-key" })

    const ls = await iris(envB, undefined, "list", "--json")
    const v = JSON.parse(ls.stdout).vaults.find((x: any) => x.id === created.vault.id)
    expect(v.has_key).toBe(true)
    const st = await iris(envB, undefined, "key", "status", "--json")
    expect(JSON.parse(st.stdout)).toMatchObject({ backend: "node-key", wrapped_keys: 1 })
  }, 600_000)
})
