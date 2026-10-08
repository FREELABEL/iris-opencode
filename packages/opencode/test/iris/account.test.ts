import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { agentCredential, credentialKind, readNodeKey, signOutPersonal, stripPersonalKeys } from "../../src/iris/account"

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
