import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  accountRef,
  accountStorePath,
  describeAccount,
  findAccount,
  forgetActiveAccount,
  readAccountStore,
  readActiveSdkEnv,
  recordSignIn,
  registerAccount,
  removeAccount,
  setEnvKeys,
  switchAccount,
  writeAccountStore,
} from "./auth-accounts"

/**
 * The store's behaviour is ported from the desktop branch (iris/1.18.23, test/iris/account.test.ts)
 * — the two products share ~/.iris/accounts.json, so the same tests guard both copies (#189335).
 */
function fakeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "iris-cli-account-"))
  const data = path.join(home, "data")
  mkdirSync(path.join(home, ".iris", "sdk"), { recursive: true })
  mkdirSync(data, { recursive: true })
  return { home, data }
}

describe("more than one account on one machine (#189321)", () => {
  const A = { id: 193, email: "a@example.com", name: "A" }
  const B = { id: 5498, email: "b@example.com", name: "B" }

  function twoAccounts() {
    const { home, data } = fakeHome()
    const bDir = path.join(home, ".iris", "accounts", "5498")
    writeAccountStore(home, {
      version: 1,
      default_owner: "193",
      accounts: [
        { user_id: 193, email: A.email, name: A.name, key: "key-a", data_dir: null },
        { user_id: 5498, email: B.email, name: B.name, key: "key-b", data_dir: bDir },
      ],
    })
    return { home, data, bDir }
  }

  test("the store is written 0600 and reads back as written", () => {
    const { home } = twoAccounts()
    expect(statSync(accountStorePath(home)).mode & 0o777).toBe(0o600)
    expect(readAccountStore(home).store.accounts.map((a) => a.user_id)).toEqual([193, 5498])
  })

  test("an unreadable store is refused by every writer and left exactly as it was", () => {
    const { home, data } = fakeHome()
    writeFileSync(accountStorePath(home), "{not json")
    expect(readAccountStore(home).readable).toBe(false)
    expect(registerAccount(home, "key-a", A).stored).toBe(false)
    expect(switchAccount({ home, cliDataDir: data }, "193").ok).toBe(false)
    expect(removeAccount(home, "193", null).ok).toBe(false)
    expect(readFileSync(accountStorePath(home), "utf-8")).toBe("{not json")
  })

  test("registering the first account claims the default data dir for it", () => {
    const { home } = fakeHome()
    registerAccount(home, "key-a", A)
    const { store } = readAccountStore(home)
    expect(store.default_owner).toBe("193")
    expect(store.accounts).toEqual([{ user_id: 193, email: A.email, name: A.name, key: "key-a", data_dir: null }])
  })

  test("a re-sign-in mints a new key for the same person and keeps their data dir", () => {
    const { home, bDir } = twoAccounts()
    registerAccount(home, "key-b-2", B)
    const b = readAccountStore(home).store.accounts.find((a) => a.user_id === 5498)!
    expect(b.key).toBe("key-b-2")
    expect(b.data_dir).toBe(bDir)
    expect(readAccountStore(home).store.accounts).toHaveLength(2)
  })

  test("an account saved without an identity gets one when it is next active", () => {
    const { home } = fakeHome()
    writeAccountStore(home, {
      version: 1,
      default_owner: "legacy",
      accounts: [{ user_id: null, email: null, name: null, key: "key-a", data_dir: null }],
    })
    registerAccount(home, "key-a", A)
    const { store } = readAccountStore(home)
    expect(store.accounts).toEqual([{ user_id: 193, email: A.email, name: A.name, key: "key-a", data_dir: null }])
    expect(store.default_owner).toBe("legacy")
  })

  test("switching writes the key where chat AND the CLI read it, and keeps every other line", () => {
    const { home, data, bDir } = twoAccounts()
    const env = path.join(home, ".iris", "sdk", ".env")
    writeFileSync(env, "IRIS_ENV=production\nIRIS_API_KEY=key-a\nexport IRIS_USER_ID=193\n")
    writeFileSync(path.join(data, "auth.json"), JSON.stringify({ iris: { type: "api", key: "key-a" }, openai: { k: 1 } }))
    mkdirSync(path.join(bDir, "opencode"), { recursive: true })
    writeFileSync(path.join(bDir, "opencode", "auth.json"), JSON.stringify({ iris: { type: "api", key: "stale" } }))

    const r = switchAccount({ home, cliDataDir: data }, "5498")

    expect(r.ok).toBe(true)
    expect(readFileSync(env, "utf-8")).toBe("IRIS_ENV=production\nIRIS_API_KEY=key-b\nIRIS_USER_ID=5498\n")
    expect(statSync(env).mode & 0o777).toBe(0o600)
    // The CLI reads the auth store BEFORE .env (platform.ts resolveToken). Left alone, `iris` in a
    // terminal would stay on A after the app switched to B.
    expect(JSON.parse(readFileSync(path.join(data, "auth.json"), "utf-8"))).toEqual({
      iris: { type: "api", key: "key-b" },
      openai: { k: 1 },
    })
    expect(JSON.parse(readFileSync(path.join(bDir, "opencode", "auth.json"), "utf-8")).iris.key).toBe("key-b")
  })

  test("switching does not create an iris auth entry where there was none", () => {
    const { home, data } = twoAccounts()
    writeFileSync(path.join(data, "auth.json"), JSON.stringify({ openai: { k: 1 } }))
    switchAccount({ home, cliDataDir: data }, "5498")
    expect(JSON.parse(readFileSync(path.join(data, "auth.json"), "utf-8"))).toEqual({ openai: { k: 1 } })
  })

  test("switching to an account with no known id removes a stale IRIS_USER_ID instead of keeping it", () => {
    const { home, data } = fakeHome()
    const legacy = { user_id: null, email: null, name: null, key: "key-a", data_dir: null }
    writeAccountStore(home, { version: 1, default_owner: "legacy", accounts: [legacy] })
    const env = path.join(home, ".iris", "sdk", ".env")
    writeFileSync(env, "IRIS_API_KEY=key-b\nIRIS_USER_ID=5498\n")
    expect(switchAccount({ home, cliDataDir: data }, accountRef(legacy)).ok).toBe(true)
    expect(readFileSync(env, "utf-8")).toBe("IRIS_API_KEY=key-a\n")
  })

  test("an account that is not stored cannot be switched to, and nothing is written", () => {
    const { home, data } = twoAccounts()
    expect(switchAccount({ home, cliDataDir: data }, "999").ok).toBe(false)
    expect(existsSync(path.join(home, ".iris", "sdk", ".env"))).toBe(false)
  })

  test("the account in use cannot be removed; another one can, and its data dir stays on disk", () => {
    const { home, bDir } = twoAccounts()
    mkdirSync(bDir, { recursive: true })
    expect(removeAccount(home, "193", "key-a").ok).toBe(false)
    expect(removeAccount(home, "5498", "key-a").ok).toBe(true)
    expect(readAccountStore(home).store.accounts.map((a) => a.user_id)).toEqual([193])
    expect(existsSync(bDir)).toBe(true)
  })

  test("removing an account keeps default_owner, so a later account does not inherit its history", () => {
    const { home } = twoAccounts()
    forgetActiveAccount(home, "key-a")
    expect(readAccountStore(home).store.default_owner).toBe("193")
  })

  test("signing out of the active account names the next one to fall back to", () => {
    const { home } = twoAccounts()
    expect(forgetActiveAccount(home, "key-a").next?.user_id).toBe(5498)
    expect(forgetActiveAccount(home, "key-b").next).toBe(null)
  })

  test("the ref of an unidentified account is a fingerprint, never the key", () => {
    const ref = accountRef({ user_id: null, key: "secret-key" })
    expect(ref.startsWith("key:")).toBe(true)
    expect(ref).not.toContain("secret")
    expect(accountRef({ user_id: 7, key: "x" })).toBe("7")
  })

  test("setEnvKeys replaces exported and plain lines and leaves look-alikes", () => {
    expect(setEnvKeys("IRIS_API_KEY_BACKUP=x\nexport IRIS_API_KEY=y", { IRIS_API_KEY: "z" })).toBe(
      "IRIS_API_KEY_BACKUP=x\nIRIS_API_KEY=z\n",
    )
  })


  // ---- CLI only: what `iris auth login` does before it overwrites ~/.iris/sdk/.env ----

  test("a login as a second account keeps the first and gives the second its own data dir", () => {
    const { home } = fakeHome()
    expect(recordSignIn(home, { key: "key-a", userId: 193 }, "key-b", B)).toBe(true)
    const { store } = readAccountStore(home)
    expect(store.default_owner).toBe("193")
    expect(store.accounts.find((a) => a.key === "key-a")?.data_dir).toBe(null)
    expect(store.accounts.find((a) => a.key === "key-b")?.data_dir).toBe(path.join(home, ".iris", "accounts", "5498"))
  })

  test("the very first login takes the default data dir", () => {
    const { home } = fakeHome()
    recordSignIn(home, { key: null, userId: null }, "key-a", A)
    const { store } = readAccountStore(home)
    expect(store.default_owner).toBe("193")
    expect(store.accounts).toEqual([{ user_id: 193, email: A.email, name: A.name, key: "key-a", data_dir: null }])
  })

  test("logging in again as the same person adds no account and keeps their dir", () => {
    const { home, bDir } = twoAccounts()
    recordSignIn(home, { key: "key-b", userId: 5498 }, "key-b-2", B)
    const { store } = readAccountStore(home)
    expect(store.accounts).toHaveLength(2)
    expect(store.accounts.find((a) => a.user_id === 5498)).toMatchObject({ key: "key-b-2", data_dir: bDir })
  })

  test("an old key with no known user still owns the default dir", () => {
    const { home } = fakeHome()
    recordSignIn(home, { key: "key-a", userId: null }, "key-b", B)
    const { store } = readAccountStore(home)
    expect(store.default_owner).toBe("legacy")
    expect(store.accounts.find((a) => a.key === "key-a")?.data_dir).toBe(null)
    expect(store.accounts.find((a) => a.key === "key-b")?.data_dir).not.toBe(null)
  })

  test("a later account does not inherit a removed account's history", () => {
    const { home } = fakeHome()
    recordSignIn(home, { key: null, userId: null }, "key-a", A)
    forgetActiveAccount(home, "key-a")
    recordSignIn(home, { key: null, userId: null }, "key-c", { id: 777, email: null, name: null })
    expect(readAccountStore(home).store.accounts[0].data_dir).toBe(path.join(home, ".iris", "accounts", "777"))
  })

  test("an unknown identity gets a fingerprinted dir, never one named after its key", () => {
    const { home } = fakeHome()
    recordSignIn(home, { key: "key-a", userId: 193 }, "secret-key", { id: null, email: null, name: null })
    const dir = readAccountStore(home).store.accounts.find((a) => a.key === "secret-key")!.data_dir!
    expect(path.basename(dir).startsWith("key-")).toBe(true)
    expect(dir).not.toContain("secret")
  })

  test("login never rewrites a store it cannot read", () => {
    const { home } = fakeHome()
    writeFileSync(accountStorePath(home), "{not json")
    expect(recordSignIn(home, { key: "key-a", userId: 193 }, "key-b", B)).toBe(false)
    expect(readFileSync(accountStorePath(home), "utf-8")).toBe("{not json")
  })

  test("the active account is read from sdk/.env, quoted or exported", () => {
    const { home } = fakeHome()
    expect(readActiveSdkEnv(home)).toEqual({ key: null, userId: null })
    writeFileSync(path.join(home, ".iris", "sdk", ".env"), 'export IRIS_API_KEY="key-a"\nIRIS_USER_ID=193\n')
    expect(readActiveSdkEnv(home)).toEqual({ key: "key-a", userId: 193 })
  })

  test("an account is found by id, email or name — and an ambiguous name is refused, not guessed", () => {
    const { home } = twoAccounts()
    const { store } = readAccountStore(home)
    expect(findAccount(store, "5498").account?.key).toBe("key-b")
    expect(findAccount(store, "#5498").account?.key).toBe("key-b")
    expect(findAccount(store, "B@Example.com").account?.key).toBe("key-b")
    expect(findAccount(store, "a").account?.key).toBe("key-a")
    expect(findAccount(store, "nobody").account).toBe(null)
    store.accounts[1].name = "A"
    expect(findAccount(store, "a").account).toBe(null)
  })

  test("the listing marks the account in use and never carries a key", () => {
    const { home } = twoAccounts()
    const rows = readAccountStore(home).store.accounts.map((a) => describeAccount(a, "key-b"))
    expect(rows.map((r) => [r.ref, r.active, r.separateData])).toEqual([
      ["193", false, false],
      ["5498", true, true],
    ])
    expect(JSON.stringify(rows)).not.toContain("key-")
  })
})
