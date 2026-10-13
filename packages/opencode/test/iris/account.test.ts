import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  accountRef,
  accountStorePath,
  agentCredential,
  cliDataDir,
  credentialKind,
  forgetActiveAccount,
  readAccountStore,
  readNodeKey,
  registerAccount,
  removeAccount,
  setEnvKeys,
  signOutPersonal,
  stripPersonalKeys,
  switchAccount,
  writeAccountStore,
} from "../../src/iris/account"

function fakeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "iris-account-"))
  const data = path.join(home, "data")
  mkdirSync(path.join(home, ".iris", "sdk"), { recursive: true })
  mkdirSync(data, { recursive: true })
  return { home, data }
}

describe("sign out, option A (#187966 D3)", () => {
  test("removes the personal key and user id, keeps every other line and the Hive node key", () => {
    const { home, data } = fakeHome()
    const env = path.join(home, ".iris", "sdk", ".env")
    writeFileSync(env, "IRIS_API_KEY=personal-key\nexport IRIS_USER_ID=193\nIRIS_ENV=production\n# a comment\n")
    chmodSync(env, 0o600)
    writeFileSync(path.join(home, ".iris", "config.json"), JSON.stringify({ node_api_key: "node-key", node_id: "n1" }))
    writeFileSync(
      path.join(data, "auth.json"),
      JSON.stringify({ iris: { type: "api", key: "personal-key" }, openai: { type: "api", key: "x" } }),
    )

    const r = signOutPersonal({ home, dataDir: data })

    expect(readFileSync(env, "utf-8")).toBe("IRIS_ENV=production\n# a comment\n")
    expect(statSync(env).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path.join(data, "auth.json"), "utf-8"))).toEqual({ openai: { type: "api", key: "x" } })
    expect(readNodeKey(home)).toBe("node-key")
    expect(r.removed).toEqual(["~/.iris/sdk/.env IRIS_API_KEY", "~/.iris/sdk/.env IRIS_USER_ID", "auth store: iris"])
  })

  test("signed out already: nothing removed, nothing created", () => {
    const { home, data } = fakeHome()
    expect(signOutPersonal({ home, dataDir: data }).removed).toEqual([])
    expect(existsSync(path.join(home, ".iris", "sdk", ".env"))).toBe(false)
  })

  test("an unreadable auth store is left exactly as it was", () => {
    const { home, data } = fakeHome()
    writeFileSync(path.join(data, "auth.json"), "{not json")
    signOutPersonal({ home, dataDir: data })
    expect(readFileSync(path.join(data, "auth.json"), "utf-8")).toBe("{not json")
  })

  test("a key whose name merely starts the same is not removed", () => {
    expect(stripPersonalKeys("IRIS_API_KEY_BACKUP=x\nIRIS_API_KEY=y").text).toBe("IRIS_API_KEY_BACKUP=x")
  })
})

describe("who Settings says the app is (#188505, #188506)", () => {
  test("the key chat uses wins over the panels' resolution", () => {
    const c = agentCredential({ IRIS_API_KEY: "chat-key" }, () => ({ token: "auth-store-key", source: "auth store" }))
    expect(c.token).toBe("chat-key")
    const fallback = agentCredential({ IRIS_API_KEY: " " }, () => ({ token: "auth-store-key", source: "auth store" }))
    expect(fallback.token).toBe("auth-store-key")
  })

  test("a Hive node key is the machine, not a person", () => {
    expect(credentialKind("node-key", "node-key")).toBe("machine")
    expect(credentialKind("personal", "node-key")).toBe("personal")
    expect(credentialKind(null, "node-key")).toBe("none")
  })
})

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

  test("inside an engine started for a second account, the CLI's dir is the parent's, not the account's", () => {
    const home = "/h"
    expect(cliDataDir({ XDG_DATA_HOME: "/h/.iris/accounts/5", IRIS_PARENT_XDG_DATA_HOME: "" }, home, "darwin")).toBe(
      "/h/.local/share/opencode",
    )
    expect(cliDataDir({ XDG_DATA_HOME: "/x", IRIS_PARENT_XDG_DATA_HOME: "/p" }, home, "linux")).toBe("/p/opencode")
    expect(cliDataDir({ XDG_DATA_HOME: "/x" }, home, "linux")).toBe("/x/opencode")
    expect(cliDataDir({ LOCALAPPDATA: "C:\\L" }, home, "win32")).toBe(path.join("C:\\L", "opencode"))
  })
})
