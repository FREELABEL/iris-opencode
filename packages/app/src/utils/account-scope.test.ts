import { beforeEach, describe, expect, test } from "bun:test"
import {
  AccountScopeTesting,
  accountKey,
  accountLegacy,
  accountScope,
  resolveAccountScope,
  scopeFromAccounts,
  setAccountScope,
} from "./account-scope"

const A = { ref: "193", active: true, separateData: false }
const B = { ref: "5498", active: true, separateData: true }

const answering = (accounts: unknown[]) =>
  (async () => new Response(JSON.stringify({ accounts }), { status: 200 })) as unknown as typeof fetch

beforeEach(() => {
  localStorage.clear()
  AccountScopeTesting.reset()
})

describe("account scope (#189336)", () => {
  test("the account that owns the default data dir keeps the plain keys", () => {
    expect(scopeFromAccounts([A, { ...B, active: false }])).toBe("")
    expect(accountKey("tabs.recent", "")).toBe("tabs.recent")
    expect(accountLegacy(["prompt-history.v1"], "")).toEqual(["prompt-history.v1"])
  })

  test("an account with its own data dir gets its own keys and none of the first account's legacy data", () => {
    expect(scopeFromAccounts([{ ...A, active: false }, B])).toBe("5498")
    expect(accountKey("prompt-history", "5498")).toBe("prompt-history@5498")
    expect(accountLegacy(["prompt-history.v1"], "5498")).toBeUndefined()
  })

  test("nobody signed in, or nobody marked active, is the default", () => {
    expect(scopeFromAccounts(undefined)).toBe("")
    expect(scopeFromAccounts([{ ...B, active: false }])).toBe("")
  })

  test("the engine's answer is remembered across a restart", async () => {
    expect(await resolveAccountScope("http://x/", answering([B]))).toBe("5498")
    AccountScopeTesting.reset()
    expect(accountScope()).toBe("5498")
    expect(accountKey("tabs")).toBe("tabs@5498")
  })

  test("switching back to the first account goes back to the plain keys", async () => {
    setAccountScope("5498")
    expect(await resolveAccountScope("http://x", answering([A]))).toBe("")
    AccountScopeTesting.reset()
    expect(accountScope()).toBe("")
  })

  test("an engine that fails, refuses or hangs leaves the last known account in place", async () => {
    setAccountScope("5498")
    const failing = (async () => {
      throw new Error("down")
    }) as unknown as typeof fetch
    const refusing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch
    const hanging = (() => new Promise(() => {})) as unknown as typeof fetch
    expect(await resolveAccountScope("http://x", failing)).toBe("5498")
    expect(await resolveAccountScope("http://x", refusing)).toBe("5498")
    expect(await resolveAccountScope("http://x", hanging, 20)).toBe("5498")
  })
})
