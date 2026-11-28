// The iPhone app's conversation with the IRIS platform (#194511). Each block below exists because
// a TestFlight build failed in exactly that way first:
//   build 9   "Something went wrong (422)"            → the send-code payload contract
//   build 11  "Signed in, but no token came back"     → the HTTP plugin protocol + unreadable replies
// Run: cd packages/desktop && bun test src/mobile-platform.test.ts
// Live checks against production (no email is ever sent): IRIS_LIVE=1 bun test src/mobile-platform.test.ts
import { describe, expect, test } from "bun:test"
import path from "path"
import {
  AUTH_API,
  HIVE_API,
  SignInExpired,
  cloudUrl,
  engineFor,
  exchangeApple,
  exchangeGoogle,
  googleCode,
  googleStartUrl,
  listMachines,
  machinesFor,
  addAccount,
  removeAccount,
  note,
  problem,
  sendCode,
  sendCodeBody,
  sortMachines,
  verify,
  verifyBody,
  type Node,
} from "./mobile-platform"

const repo = path.resolve(import.meta.dir, "../../..")
const account = { token: "t0ken", userId: 2945, email: "owner@example.com" }

// A network that answers from a table, recording what was asked. TYPED, not recorded: the reply
// shapes are copied from fl-api LoginController::loginWithCode and fl-iris-api#471's phoneToken.
// The "live" block below checks the same shapes against production.
function network(routes: Record<string, (body: unknown) => Response>) {
  const asked: { url: string; body: unknown }[] = []
  const http = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    asked.push({ url, body })
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!route) throw new Error(`unexpected request ${url}`)
    return routes[route]!(body)
  }
  return { http, asked }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

describe("the send-code payload is IRIS Desktop's (build 9: 422)", () => {
  // login.html's send-login-code call, read from the file Desktop actually ships.
  const loginHtml = Bun.file(path.join(repo, "packages/desktop/public/login.html")).text()
  const block = (endpoint: string) => loginHtml.then((html) => html.slice(html.indexOf(endpoint), html.indexOf("});", html.indexOf(endpoint))))

  test("every field Desktop sends to send-login-code, the phone sends with the same value", async () => {
    const desktop = await block("/api/v1/auth/send-login-code")
    // Desktop's own fields, read from its call (the optional promo_code is a spread, so not listed).
    // From Desktop to the phone, not the other way: an email-only payload must fail this (build 9).
    const fields = [...desktop.matchAll(/^\s*([a-z_]+):\s*([^,\n]+),/gm)].map((m) => [m[1]!, m[2]!.trim()] as const)
    // `email` is shorthand there (`email,`), so the literal fields are these three.
    expect(fields.map(([key]) => key)).toEqual(["method", "expiration_minutes", "auto_create"])
    const phone = sendCodeBody(" a@b.co ") as Record<string, unknown>
    expect(phone.email).toBe("a@b.co")
    for (const [key, value] of fields) expect(JSON.stringify(phone[key])).toBe(value)
  })

  test("login-with-code uses login_code and asks for an SDK token, as Desktop does", async () => {
    const desktop = await block("/api/v1/auth/login-with-code")
    expect(desktop).toContain("login_code: code")
    expect(desktop).toContain("generate_sdk_token: true")
    expect(Object.keys(verifyBody("a@b.co", "123456"))).toEqual(
      expect.arrayContaining(["email", "login_code", "generate_sdk_token", "sdk_token_name", "sdk_token_expires_days"]),
    )
  })

  test("a 422 shows the server's own words (the auth API puts them under details)", async () => {
    const { http } = network({
      [AUTH_API]: () => json(422, { success: false, error: "Invalid request data", details: { method: ["The method field is required."] } }),
    })
    await expect(sendCode(http, "a@b.co")).rejects.toThrow("The method field is required.")
  })
})

describe("the HTTP plugin's two halves speak one protocol (build 11: no token came back)", () => {
  test("@tauri-apps/plugin-http in bun.lock is the same release as tauri-plugin-http in Cargo.lock", async () => {
    const js = (await Bun.file(path.join(repo, "bun.lock")).text()).match(/"@tauri-apps\/plugin-http@(\d+\.\d+\.\d+)"/)?.[1]
    const rust = (await Bun.file(path.join(repo, "packages/desktop/src-tauri/Cargo.lock")).text()).match(
      /name = "tauri-plugin-http"\nversion = "(\d+\.\d+\.\d+)"/,
    )?.[1]
    // JS 2.5.9 pulls fetch_read_body with no channel; Rust 2.5.4 requires a stream_channel. Every
    // body read failed. The two are released together; anything else is a mismatch.
    expect(js).toBeDefined()
    expect(js).toBe(rust!)
  })

  test("an unreadable 2xx reply is an error that says so, never an empty answer", async () => {
    const { http } = network({ [AUTH_API]: () => new Response("<html>not json", { status: 200 }) })
    await expect(verify(http, "a@b.co", "123456")).rejects.toThrow("Could not read the server's reply")
  })
})

describe("signing in", () => {
  const signedIn = { success: true, message: "Login successful", data: { user: { id: 2945 }, sdk_token: { id: 349, name: "IRIS iPhone", key: "k".repeat(64) } } }

  test("the token is read from data.sdk_token.key and the account from whoami", async () => {
    const { http, asked } = network({
      [`${AUTH_API}/api/v1/auth/login-with-code`]: () => json(200, signedIn),
      [`${AUTH_API}/api/v1/auth/whoami`]: () => json(200, { data: { id: 2945, email: "owner@example.com" } }),
    })
    expect(await verify(http, " owner@example.com ", "910500")).toEqual({ token: "k".repeat(64), userId: 2945, email: "owner@example.com" })
    expect(asked[0]!.body).toMatchObject({ email: "owner@example.com", login_code: "910500" })
  })

  test("a wrong code is refused before any request", async () => {
    const { http, asked } = network({})
    await expect(verify(http, "a@b.co", "12345")).rejects.toThrow("6 digits")
    expect(asked).toHaveLength(0)
  })

  test("a 200 without a token is named, not silently accepted", async () => {
    const { http } = network({ [AUTH_API]: () => json(200, { success: true, data: { user: { id: 1 } } }) })
    await expect(verify(http, "a@b.co", "123456")).rejects.toThrow("no token came back")
  })
})

describe("choosing a machine", () => {
  const node = (name: string, online: boolean, phone?: Node["phone"]): Node => ({
    id: name,
    name,
    connection_status: online ? "online" : "offline",
    phone,
  })

  test("ready machines first, then online, then offline; by name within each", () => {
    const sorted = sortMachines([
      node("zeta", false),
      node("beta", true),
      node("iris-hive-002", true, { enabled: true, engine: "running" }),
      node("alpha", true, { enabled: true }),
    ])
    expect(sorted.map((n) => n.name)).toEqual(["alpha", "iris-hive-002", "beta", "zeta"])
  })

  test("each row says why it can or cannot be tapped", () => {
    expect(note(node("a", false, { enabled: true }))).toBe("Offline")
    expect(note(node("a", true))).toBe("Phone access is off on this machine")
    expect(note(node("a", true, { enabled: true, engine: "stopped" }))).toBe("Online · IRIS Desktop is not open")
    expect(note(node("a", true, { enabled: true, engine: "running" }))).toBe("Online")
  })

  test("the machine list is read from nodes[] — the reply GET /api/v6/nodes really sends — and sorted", async () => {
    // RECORDED 2026-11-28 from production: top-level keys are exactly ["nodes", "device_totals"].
    // The first version of this test used {data: [...]} (the CLI's --json wrapper, typed by hand)
    // and passed, while the phone would have shown "No machines yet" for every account.
    const { http, asked } = network({
      [HIVE_API]: () => json(200, { nodes: [node("b", false), node("a", true, { enabled: true })], device_totals: {} }),
    })
    expect((await listMachines(http, account)).map((n) => n.name)).toEqual(["a", "b"])
    expect(asked[0]!.url).toBe(`${HIVE_API}/api/v6/nodes/?user_id=2945`)
  })

  test("a phone token becomes an engine: username iris, password the hp1 token, expiry parsed", async () => {
    const { http, asked } = network({
      [HIVE_API]: () => json(200, { token: "hp1.n.1.ab.cd", url: "https://iris-hive-002-phone.t.heyiris.io", expires_at: "2026-11-28T15:00:00Z" }),
    })
    expect(await engineFor(http, account, "node/1")).toEqual({
      url: "https://iris-hive-002-phone.t.heyiris.io",
      username: "iris",
      password: "hp1.n.1.ab.cd",
      expiresAt: Date.parse("2026-11-28T15:00:00Z"),
    })
    expect(asked[0]!.url).toBe(`${HIVE_API}/api/v6/nodes/node%2F1/phone-token?user_id=2945`)
  })

  test("409 says phone access is off; 401 is a sign-in that expired", async () => {
    const off = network({ [HIVE_API]: () => json(409, { error: "phone_not_enabled" }) })
    await expect(engineFor(off.http, account, "n")).rejects.toThrow("phone access is not turned on")
    const expired = network({ [HIVE_API]: () => json(401, { error: "Invalid token" }) })
    await expect(listMachines(expired.http, account)).rejects.toBeInstanceOf(SignInExpired)
  })
})

describe("problem(): what the server said", () => {
  test("details, then errors, then message, then error", () => {
    expect(problem({ details: { email: ["bad"], method: ["missing"] } })).toBe("bad missing")
    expect(problem({ errors: { code: ["wrong"] } })).toBe("wrong")
    expect(problem({ message: "m", error: "e" })).toBe("m")
    expect(problem({ error: "User not found" })).toBe("User not found")
    expect(problem(undefined)).toBe("")
  })
})

// Production, read-only for accounts: nothing here sends an email or signs anyone in.
describe.if(process.env.IRIS_LIVE === "1")("live: production agrees with the shapes above", () => {
  test("send-login-code accepts the phone's payload apart from the address (invalid address, so no email goes out)", async () => {
    const response = await fetch(`${AUTH_API}/api/v1/auth/send-login-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(sendCodeBody("not-an-email")),
    })
    const reply = await response.json()
    expect(response.status).toBe(422)
    // Only the address is wrong: method, expiration_minutes and auto_create all passed validation.
    expect(Object.keys(reply.details)).toEqual(["email"])
  })

  test("login-with-code refuses a wrong code with words the phone can show", async () => {
    const response = await fetch(`${AUTH_API}/api/v1/auth/login-with-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(verifyBody("nobody-194511@example.invalid", "000000")),
    })
    expect(response.ok).toBe(false)
    expect(problem(await response.json())).not.toBe("")
  })

  test("Hive answers a bad token with 401, which the phone treats as an expired sign-in", async () => {
    await expect(listMachines(fetch, { ...account, token: "not-a-real-token" })).rejects.toBeInstanceOf(SignInExpired)
    await expect(engineFor(fetch, { ...account, token: "not-a-real-token" }, "x")).rejects.toBeInstanceOf(SignInExpired)
  })
})

// "Continue with Google" (ADR-04 on #194511): the sheet opens fl-api's mobile start with only the
// PKCE challenge; fl-api ends at iris://auth/google?code=… (or ?error=…); the code plus the verifier
// only this app holds buys an SDK token at the exchange Desktop already uses.
describe("Continue with Google", () => {
  test("the sheet opens the mobile start with the challenge, for iOS", () => {
    expect(googleStartUrl("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(
      `${AUTH_API}/api/v1/auth/google/mobile/start?code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&app=ios`,
    )
  })

  test("the callback's code is taken from iris://auth/google, and nothing else is accepted", () => {
    expect(googleCode("iris://auth/google?code=abc123")).toBe("abc123")
    expect(() => googleCode("iris://pair?code=abc123")).toThrow("unexpected")
    expect(() => googleCode("https://evil.example/auth/google?code=abc123")).toThrow("unexpected")
    expect(() => googleCode("iris://auth/google")).toThrow("no code")
  })

  test("each error fl-api can end with reads as a sentence", () => {
    expect(() => googleCode("iris://auth/google?error=access_denied")).toThrow("cancelled")
    expect(() => googleCode("iris://auth/google?error=email_not_verified")).toThrow("isn't verified")
    expect(() => googleCode("iris://auth/google?error=sign_in_failed")).toThrow("didn't work")
    expect(() => googleCode("iris://auth/google?error=something_new")).toThrow("something_new")
  })

  test("the exchange sends code + verifier and returns the account (Desktop's reply shape)", async () => {
    const { http, asked } = network({
      [`${AUTH_API}/api/v1/auth/google/desktop/exchange`]: () =>
        json(200, { success: true, data: { sdk_token: { key: "g".repeat(64) }, user: { email: "owner@example.com", is_new: false } } }),
      [`${AUTH_API}/api/v1/auth/whoami`]: () => json(200, { data: { id: 2945, email: "owner@example.com" } }),
    })
    expect(await exchangeGoogle(http, "abc123", "v".repeat(43))).toEqual({ token: "g".repeat(64), userId: 2945, email: "owner@example.com" })
    expect(asked[0]!.body).toEqual({ code: "abc123", code_verifier: "v".repeat(43) })
  })

  test("an exchange refusal (expired or reused code) says what happened", async () => {
    const { http } = network({ [AUTH_API]: () => json(400, { success: false, error: "That sign-in code expired. Try again." }) })
    await expect(exchangeGoogle(http, "old", "v".repeat(43))).rejects.toThrow("expired")
  })
})

// Several accounts on one phone (Alex: alex@ is personal, admin@ owns the Hive machines). Desktop
// keeps the same list in ~/.iris/accounts.json (#189321). Every machine carries the account that
// owns it, because only that account's token can get it a phone token.
describe("several accounts", () => {
  const alex = { token: "a-token", userId: 2945, email: "alex@example.com" }
  const admin = { token: "b-token", userId: 193, email: "admin@example.com" }
  const machine = (id: string, online: boolean, ready: boolean): Node => ({
    id,
    name: id,
    connection_status: online ? "online" : "offline",
    phone: ready ? { enabled: true, engine: "running" } : null,
  })
  const byToken = (lists: Record<string, Response | (() => Response)>) => async (url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "")
    const reply = lists[token]
    if (!reply) throw new Error(`unexpected token for ${url}`)
    return typeof reply === "function" ? reply() : reply
  }

  test("adding an account keeps the others; signing in again replaces only that account's token", () => {
    const both = addAccount(addAccount([], alex), admin)
    expect(both.map((a) => a.userId)).toEqual([2945, 193])
    expect(addAccount(both, { ...alex, token: "new" })).toEqual([{ ...alex, token: "new" }, admin])
    expect(removeAccount(both, 2945)).toEqual([admin])
  })

  test("the machine list is every account's machines, each tagged with its owner, ready ones first", async () => {
    const http = byToken({
      "a-token": () => json(200, { nodes: [machine("laptop", true, false)], device_totals: {} }),
      "b-token": () => json(200, { nodes: [machine("iris-hive-002", true, true), machine("old-box", false, false)], device_totals: {} }),
    })
    const result = await machinesFor(http, [alex, admin])
    expect(result.machines.map((m) => [m.name, m.owner.userId])).toEqual([
      ["iris-hive-002", 193],
      ["laptop", 2945],
      ["old-box", 193],
    ])
    expect(result.expired).toEqual([])
  })

  test("one account's expired sign-in does not hide the other account's machines", async () => {
    const http = byToken({
      "a-token": () => json(401, { error: "Invalid token" }),
      "b-token": () => json(200, { nodes: [machine("iris-hive-002", true, true)], device_totals: {} }),
    })
    const result = await machinesFor(http, [alex, admin])
    expect(result.machines.map((m) => m.name)).toEqual(["iris-hive-002"])
    expect(result.expired.map((a) => a.userId)).toEqual([2945])
  })

  test("a failure on one account is reported with its email, and the rest still load", async () => {
    const http = byToken({
      "a-token": () => json(500, { message: "Server Error" }),
      "b-token": () => json(200, { nodes: [machine("iris-hive-002", true, true)], device_totals: {} }),
    })
    const result = await machinesFor(http, [alex, admin])
    expect(result.machines).toHaveLength(1)
    expect(result.failures).toEqual(["alex@example.com: Server Error"])
  })
})

// Sign in with Apple (#194555, guideline 4.8): the native sheet signs an identity token whose nonce
// claim is sha256(raw); fl-api checks it against the raw nonce only this app holds, and answers
// in login-with-code's shape, so the account is read the same way as every other sign-in.
describe("Sign in with Apple", () => {
  const signedIn = { success: true, message: "Login successful", data: { user: { id: 2945, email: "x7@privaterelay.appleid.com" }, sdk_token: { id: 350, name: "IRIS iPhone", key: "a".repeat(64) } } }

  test("the identity token, the RAW nonce and the name go to /auth/apple/mobile, nothing else", async () => {
    const { http, asked } = network({
      [`${AUTH_API}/api/v1/auth/apple/mobile`]: () => json(200, signedIn),
      [`${AUTH_API}/api/v1/auth/whoami`]: () => json(200, { data: { id: 2945, email: "x7@privaterelay.appleid.com" } }),
    })
    await exchangeApple(http, { identityToken: "eyJ.id.tok", rawNonce: "raw-nonce", givenName: "Alex", familyName: "Mayo" })
    expect(asked[0]!.url).toBe(`${AUTH_API}/api/v1/auth/apple/mobile`)
    expect(asked[0]!.body).toEqual({ identity_token: "eyJ.id.tok", nonce: "raw-nonce", given_name: "Alex", family_name: "Mayo" })
  })

  test("Apple sends the name only on the first sign-in: without it, no name fields are sent", async () => {
    const { http, asked } = network({
      [`${AUTH_API}/api/v1/auth/apple/mobile`]: () => json(200, signedIn),
      [`${AUTH_API}/api/v1/auth/whoami`]: () => json(200, { data: { id: 2945, email: "owner@example.com" } }),
    })
    await exchangeApple(http, { identityToken: "eyJ.id.tok", rawNonce: "raw-nonce" })
    expect(asked[0]!.body).toEqual({ identity_token: "eyJ.id.tok", nonce: "raw-nonce" })
  })

  test("success is the account from data.sdk_token.key and whoami (a relay email is a real address)", async () => {
    const { http, asked } = network({
      [`${AUTH_API}/api/v1/auth/apple/mobile`]: () => json(200, signedIn),
      [`${AUTH_API}/api/v1/auth/whoami`]: () => json(200, { data: { id: 2945, email: "x7@privaterelay.appleid.com" } }),
    })
    expect(await exchangeApple(http, { identityToken: "t", rawNonce: "n" })).toEqual({ token: "a".repeat(64), userId: 2945, email: "x7@privaterelay.appleid.com" })
    expect(asked[1]!.url).toBe(`${AUTH_API}/api/v1/auth/whoami`)
  })

  // fl-api#346's error codes, each as {success: false, error: "<code>"}.
  test.each([
    [401, "invalid_token", "Apple sign-in couldn't be verified. Try again."],
    [401, "nonce_mismatch", "Apple sign-in couldn't be verified. Try again."],
    [409, "email_in_use", "That email is already on an IRIS account. Sign in with your email code instead, then add Apple later."],
    [503, "apple_unavailable", "Apple's sign-in service didn't answer. Try again in a minute."],
  ])("%i %s reads as a sentence, not a code", async (status, code, sentence) => {
    const { http } = network({ [AUTH_API]: () => json(status, { success: false, error: code }) })
    const error = await exchangeApple(http, { identityToken: "t", rawNonce: "n" }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(sentence)
  })

  test("a 422 shows the server's own words", async () => {
    const { http } = network({ [AUTH_API]: () => json(422, { success: false, errors: { identity_token: ["The identity token field is required."] } }) })
    await expect(exchangeApple(http, { identityToken: "", rawNonce: "n" })).rejects.toThrow("The identity token field is required.")
  })

  test("an unreadable reply is an error that says so", async () => {
    const { http } = network({ [AUTH_API]: () => new Response("<html>not json", { status: 200 }) })
    await expect(exchangeApple(http, { identityToken: "t", rawNonce: "n" })).rejects.toThrow("Could not read the server's reply")
  })

  test("a 200 without a token is named", async () => {
    const { http } = network({ [AUTH_API]: () => json(200, { success: true, data: { user: { id: 1 } } }) })
    await expect(exchangeApple(http, { identityToken: "t", rawNonce: "n" })).rejects.toThrow("no token came back")
  })
})

// IRIS Cloud (Alex: "we can offer it as IRIS CLOUD"): heyiris.io/atlas, signed in as the phone's
// account, for anyone without a machine. fl-api mints a 5-minute single-use magic link for the
// token's own user (POST /api/v1/auth/web-handoff); heyiris.io's /login/magic redeems it.
describe("IRIS Cloud", () => {
  const handoff = "https://heyiris.io/login/magic?token=" + "a".repeat(64) + "&user=2945&intended=%2Fatlas"

  test("asks for a handoff with the account's token and returns the signed-in link", async () => {
    const asked: { url: string; auth?: string; body: unknown }[] = []
    const http = async (url: string, init?: RequestInit) => {
      asked.push({ url, auth: (init?.headers as Record<string, string>).Authorization, body: JSON.parse(String(init?.body)) })
      return json(200, { success: true, data: { url: handoff, expires_at: "2026-11-28T07:00:00Z" } })
    }
    expect(await cloudUrl(http, account)).toBe(handoff)
    expect(asked).toEqual([{ url: `${AUTH_API}/api/v1/auth/web-handoff`, auth: "Bearer t0ken", body: { intended: "/atlas" } }])
  })

  test("only ever opens heyiris.io's own sign-in page", async () => {
    const elsewhere = network({ [AUTH_API]: () => json(200, { success: true, data: { url: "https://evil.example/login/magic?token=x" } }) })
    await expect(cloudUrl(elsewhere.http, account)).rejects.toThrow("unexpected")
    const noUrl = network({ [AUTH_API]: () => json(200, { success: true, data: {} }) })
    await expect(cloudUrl(noUrl.http, account)).rejects.toThrow("unexpected")
  })

  test("a refused token is an expired sign-in", async () => {
    const { http } = network({ [AUTH_API]: () => json(401, { message: "Unauthenticated." }) })
    await expect(cloudUrl(http, account)).rejects.toBeInstanceOf(SignInExpired)
  })
})
