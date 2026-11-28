// What the iPhone app asks the IRIS platform (#194511, ADR-03): sign in by email code, list the
// person's machines, and get a token signed for one of them. No storage and no UI here, and every
// call takes the `fetch` to use, so mobile-platform.test.ts runs the same code the phone runs.

export const AUTH_API = "https://raichu.heyiris.io"
export const HIVE_API = "https://freelabel.net"

export type Account = { token: string; userId: number; email: string }
export type Engine = { url: string; username: string; password: string; expiresAt?: number }
export type Node = {
  id: string
  name: string
  connection_status: string
  last_heartbeat_at?: string | null
  phone?: { enabled?: boolean; url?: string; engine?: string } | null
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The account's token was refused: the caller forgets it and shows sign-in again. */
export class SignInExpired extends Error {
  constructor() {
    super("Your sign-in has expired. Sign in again.")
  }
}

// Exactly IRIS Desktop's payload (public/login.html, checked by a test): `email` alone is a 422
// ("The method field is required."), and auto_create lets an account that never signed in get a code.
export function sendCodeBody(email: string) {
  return { email: email.trim(), method: "with_login_code", expiration_minutes: 30, auto_create: true }
}

export function verifyBody(email: string, code: string) {
  return {
    email: email.trim(),
    login_code: code, // NOT `code`: the endpoint names this field login_code
    generate_sdk_token: true,
    sdk_token_name: "IRIS iPhone",
    sdk_token_expires_days: 365,
  }
}

export async function sendCode(http: Fetch, email: string) {
  if (!email.includes("@")) throw new Error("Enter your email address.")
  await post(http, `${AUTH_API}/api/v1/auth/send-login-code`, sendCodeBody(email))
}

export async function verify(http: Fetch, email: string, code: string): Promise<Account> {
  if (!/^\d{6}$/.test(code)) throw new Error("The code is 6 digits.")
  const reply = await post(http, `${AUTH_API}/api/v1/auth/login-with-code`, verifyBody(email, code))
  // Nested (fl-api LoginController::loginWithCode): {success, message, data: {user, sdk_token: {key}}}.
  return accountFor(http, reply?.data?.sdk_token?.key, email.trim())
}

/** The account behind a freshly issued SDK token: one path after the credential, email or Google. */
async function accountFor(http: Fetch, token: unknown, fallbackEmail: string): Promise<Account> {
  if (typeof token !== "string" || !token) throw new Error("Signed in, but no token came back. Try again.")
  const who = await read(await http(`${AUTH_API}/api/v1/auth/whoami`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }))
  const user = who.data?.data
  if (!who.response.ok || typeof user?.id !== "number") throw new Error("Signed in, but your account could not be read. Try again.")
  return { token, userId: user.id, email: typeof user.email === "string" ? user.email : fallbackEmail }
}

// "Continue with Google" (ADR-04): Apple's sign-in sheet opens this with only the PKCE challenge.
export function googleStartUrl(challenge: string) {
  return `${AUTH_API}/api/v1/auth/google/mobile/start?code_challenge=${encodeURIComponent(challenge)}&app=ios`
}

/** The single-use code from fl-api's redirect to iris://auth/google, or the reason it sent instead. */
export function googleCode(callback: string) {
  const url = URL.canParse(callback) ? new URL(callback) : undefined
  // iris://auth/google parses as host "auth", path "/google".
  if (!url || url.protocol !== "iris:" || url.host !== "auth" || url.pathname !== "/google") throw new Error("Google sign-in came back to an unexpected address.")
  const error = url.searchParams.get("error")
  if (error) throw new Error(GOOGLE_ERRORS[error] ?? `Google sign-in didn't work (${error}).`)
  const code = url.searchParams.get("code")
  if (!code) throw new Error("Google sign-in came back with no code. Try again.")
  return code
}

const GOOGLE_ERRORS: Record<string, string> = {
  access_denied: "Google sign-in was cancelled.",
  email_not_verified: "That Google account's email isn't verified. Use an email code instead.",
  no_code: "Google sign-in didn't work. Try again.",
  sign_in_failed: "Google sign-in didn't work. Try again, or use an email code.",
}

/** Code + the verifier only this app holds → an SDK token, at the exchange Desktop already uses. */
export async function exchangeGoogle(http: Fetch, code: string, verifier: string): Promise<Account> {
  const reply = await post(http, `${AUTH_API}/api/v1/auth/google/desktop/exchange`, { code, code_verifier: verifier })
  return accountFor(http, reply?.data?.sdk_token?.key, typeof reply?.data?.user?.email === "string" ? reply.data.user.email : "")
}

// Sign in with Apple (#194555, App Review guideline 4.8). The native sheet signs an identity token
// whose nonce claim is sha256(raw); only this app holds the raw nonce (nonce_pair in lib.rs), so a
// token lifted from somewhere else cannot be replayed here. Apple sends the name on the first
// sign-in only, so it rides along when it is there.
export async function exchangeApple(
  http: Fetch,
  apple: { identityToken: string; rawNonce: string; givenName?: string; familyName?: string },
): Promise<Account> {
  const reply = await post(
    http,
    `${AUTH_API}/api/v1/auth/apple/mobile`,
    {
      identity_token: apple.identityToken,
      nonce: apple.rawNonce,
      ...(apple.givenName ? { given_name: apple.givenName } : {}),
      ...(apple.familyName ? { family_name: apple.familyName } : {}),
    },
    APPLE_ERRORS,
  )
  return accountFor(http, reply?.data?.sdk_token?.key, typeof reply?.data?.user?.email === "string" ? reply.data.user.email : "")
}

// fl-api#346 answers {success: false, error: "<code>"}; a 422 falls through to problem().
const APPLE_ERRORS: Record<string, string> = {
  invalid_token: "Apple sign-in couldn't be verified. Try again.",
  nonce_mismatch: "Apple sign-in couldn't be verified. Try again.",
  email_in_use: "That email is already on an IRIS account. Sign in with your email code instead, then add Apple later.",
  apple_unavailable: "Apple's sign-in service didn't answer. Try again in a minute.",
}

export async function listMachines(http: Fetch, account: Account): Promise<Node[]> {
  const reply = await hive(http, account, `/api/v6/nodes/?user_id=${account.userId}`)
  // {nodes: [...], device_totals} (fl-iris-api ComputeNodeController::index). `data` is the CLI's
  // --json wrapper, not the API's; it is read only as a fallback.
  const list = Array.isArray(reply?.nodes) ? reply.nodes : Array.isArray(reply?.data) ? reply.data : []
  return sortMachines(list)
}

/**
 * IRIS Cloud: heyiris.io/atlas signed in as this account, no machine needed. fl-api mints a
 * 5-minute, single-use magic link for the token's own user; heyiris.io's /login/magic spends it.
 */
export async function cloudUrl(http: Fetch, account: Account, intended = "/atlas") {
  const response = await http(`${AUTH_API}/api/v1/auth/web-handoff`, {
    method: "POST",
    headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ intended }),
  }).catch(() => undefined)
  if (!response) throw new Error("No connection. Check this phone is online.")
  if (response.status === 401) throw new SignInExpired()
  const { data } = await read(response)
  if (!response.ok) throw new Error(problem(data) || `IRIS Cloud didn't open (${response.status}).`)
  const url = data?.data?.url
  // Only heyiris.io's own sign-in page is ever opened with this account's session.
  if (typeof url !== "string" || !url.startsWith("https://heyiris.io/login/magic?")) throw new Error("IRIS Cloud answered with an unexpected address.")
  return url
}

/** A machine, with the signed-in account that owns it: only that account's token can open it. */
export type OwnedNode = Node & { owner: Account }

/** Add or refresh an account (same user → new token, same place in the list). */
export function addAccount(accounts: Account[], account: Account) {
  return accounts.some((a) => a.userId === account.userId)
    ? accounts.map((a) => (a.userId === account.userId ? account : a))
    : [...accounts, account]
}

export function removeAccount(accounts: Account[], userId: number) {
  return accounts.filter((a) => a.userId !== userId)
}

/**
 * Every signed-in account's machines in one list. One account failing never hides another's
 * machines: an expired sign-in is returned in `expired`, anything else in `failures`.
 */
export async function machinesFor(http: Fetch, accounts: Account[]) {
  const results = await Promise.all(
    accounts.map((owner) =>
      listMachines(http, owner).then(
        (list) => ({ owner, list: list.map((node): OwnedNode => ({ ...node, owner })) }),
        (error: Error) => ({ owner, error }),
      ),
    ),
  )
  return {
    machines: sortMachines(results.flatMap((r) => ("list" in r ? r.list : []))) as OwnedNode[],
    expired: results.flatMap((r) => ("error" in r && r.error instanceof SignInExpired ? [r.owner] : [])),
    failures: results.flatMap((r) => ("error" in r && !(r.error instanceof SignInExpired) ? [`${r.owner.email}: ${r.error.message}`] : [])),
  }
}

/** Ready first, then online, then by name: the machine you can tap is at the top. */
export function sortMachines(list: Node[]) {
  const rank = (n: Node) => (n.connection_status === "online" ? (n.phone?.enabled ? 0 : 1) : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function note(node: Node) {
  if (node.connection_status !== "online") return "Offline"
  if (!node.phone?.enabled) return "Phone access is off on this machine"
  if (node.phone.engine === "stopped") return "Online · IRIS Desktop is not open"
  return "Online"
}

/** A token the platform signs for this one machine (hp1, ADR-03), and the address to use it at. */
export async function engineFor(http: Fetch, account: Account, nodeId: string): Promise<Engine> {
  const reply = await hive(http, account, `/api/v6/nodes/${encodeURIComponent(nodeId)}/phone-token?user_id=${account.userId}`, {})
  if (typeof reply?.token !== "string" || typeof reply?.url !== "string") throw new Error("this machine did not return an address.")
  return { url: reply.url, username: "iris", password: reply.token, expiresAt: Date.parse(reply.expires_at) || undefined }
}

async function hive(http: Fetch, account: Account, path: string, body?: unknown) {
  const response = await http(HIVE_API + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => undefined)
  if (!response) throw new Error("No connection. Check this phone is online.")
  if (response.status === 401) throw new SignInExpired()
  const { data } = await read(response)
  if (response.status === 409) throw new Error("phone access is not turned on for this machine yet.")
  if (!response.ok) throw new Error(data?.message || data?.error || `the server answered ${response.status}.`)
  return data
}

/** `errors`: sentences for the error codes this endpoint answers with, by code. */
async function post(http: Fetch, url: string, body: unknown, errors?: Record<string, string>) {
  const response = await http(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined)
  if (!response) throw new Error("No connection. Check this phone is online.")
  const { data } = await read(response)
  if (!response.ok) throw new Error(errors?.[data?.error] || problem(data) || `Something went wrong (${response.status}).`)
  return data
}

/**
 * A reply's JSON. An unreadable body on a 2xx is a fault in the app, not an empty answer: build 11
 * read every body as {} (HTTP plugin JS 2.5.9 against Rust 2.5.4) and said "no token came back"
 * while the server had signed the person in.
 */
async function read(response: Response) {
  const data = await response.json().catch((e: Error) => (response.ok ? new Error(`Could not read the server's reply (${e.message}).`) : {}))
  if (data instanceof Error) throw data
  return { response, data }
}

/** What the server said was wrong: the auth API puts field messages under `details`, Laravel under `errors`. */
export function problem(data: unknown) {
  if (!data || typeof data !== "object") return ""
  const reply = data as { details?: unknown; errors?: unknown; message?: unknown; error?: unknown }
  const fields = reply.details ?? reply.errors
  const detail = fields && typeof fields === "object" ? Object.values(fields).flat().join(" ") : ""
  return detail || (typeof reply.message === "string" ? reply.message : "") || (typeof reply.error === "string" ? reply.error : "")
}
