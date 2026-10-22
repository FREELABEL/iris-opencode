/**
 * More than one IRIS account on one machine, from the terminal (#189335; the CLI half of #189321).
 *
 * ~/.iris/accounts.json is written by IRIS Desktop (branch iris/1.18.23: packages/opencode/src/iris/
 * account.ts and packages/desktop/src-tauri/src/accounts.rs). The CLI ships from `main`, which
 * contains neither, so the store's code is repeated here. THE FILE FORMAT IS SHARED: change one,
 * change all three.
 *
 * The ACTIVE account stays exactly where it always was — ~/.iris/sdk/.env and the `iris` entry of
 * the auth store. The store holds every account signed in on this machine, so signing in as a
 * second one does not throw the first away, and `iris auth switch` has a key to write.
 *
 * Each account after the first gets its own data dir (Desktop passes it to its engine as
 * XDG_DATA_HOME), because local chat sessions carry no account id. The first account keeps the
 * default dir, so nobody's history moves. `default_owner` records whose history the default dir
 * holds, and outlives that account's removal so a later account does not inherit it.
 *
 * Every function takes `home` so it can be tested against a temporary directory.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import path from "path"

export interface StoredAccount {
  user_id: number | null
  email: string | null
  name: string | null
  key: string
  /** XDG_DATA_HOME for this account's engine. null = the default data dir. */
  data_dir: string | null
}

export interface AccountStore {
  version: 1
  default_owner: string | null
  accounts: StoredAccount[]
}

const EMPTY_STORE = (): AccountStore => ({ version: 1, default_owner: null, accounts: [] })

export function accountStorePath(home: string) {
  return path.join(home, ".iris", "accounts.json")
}

/**
 * How the UI names a stored account to switch to or remove: its user id, or — for a sign-in saved
 * before anyone asked fl-api who it is — a fingerprint of its key. Never the key itself.
 */
export function accountRef(a: Pick<StoredAccount, "user_id" | "key">): string {
  return a.user_id !== null ? String(a.user_id) : `key:${createHash("sha256").update(a.key).digest("hex").slice(0, 12)}`
}

/** Where an account other than the default one keeps its engine data (an XDG_DATA_HOME). */
export function accountDataHome(home: string, userId: number) {
  return path.join(home, ".iris", "accounts", String(userId))
}

/**
 * `readable: false` means the file exists and could not be parsed. Writers refuse in that case:
 * a store we cannot read holds keys, and rewriting it from empty would delete them.
 */
export function readAccountStore(home: string): { store: AccountStore; readable: boolean } {
  const file = accountStorePath(home)
  if (!existsSync(file)) return { store: EMPTY_STORE(), readable: true }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"))
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.accounts)) return { store: EMPTY_STORE(), readable: false }
    const accounts: StoredAccount[] = raw.accounts
      .filter((a: any) => a && typeof a.key === "string" && a.key)
      .map((a: any) => ({
        user_id: typeof a.user_id === "number" ? a.user_id : null,
        email: typeof a.email === "string" ? a.email : null,
        name: typeof a.name === "string" ? a.name : null,
        key: a.key,
        data_dir: typeof a.data_dir === "string" && a.data_dir ? a.data_dir : null,
      }))
    const owner = raw.default_owner
    return {
      store: { version: 1, default_owner: typeof owner === "string" && owner ? owner : null, accounts },
      readable: true,
    }
  } catch {
    return { store: EMPTY_STORE(), readable: false }
  }
}

export function writeAccountStore(home: string, store: AccountStore) {
  const file = accountStorePath(home)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  // `mode` applies only when the file is created. These are keys to whole accounts.
  try {
    chmodSync(file, 0o600)
  } catch {}
}

/**
 * Record who the active key belongs to. Called whenever the app learns it (Settings > Account
 * asks fl-api). Matches by user id first — a re-sign-in mints a new key for the same person and
 * must keep their data dir — then by key. Never changes the data dir of an account already
 * stored: the engine is already running in it.
 */
export function registerAccount(
  home: string,
  key: string,
  who: { id: number | null; email: string | null; name: string | null },
): { stored: boolean } {
  if (!key) return { stored: false }
  const { store, readable } = readAccountStore(home)
  if (!readable) return { stored: false }
  const existing =
    (who.id !== null && store.accounts.find((a) => a.user_id === who.id)) || store.accounts.find((a) => a.key === key)
  if (existing) {
    const before = JSON.stringify(existing)
    existing.key = key
    existing.user_id = who.id ?? existing.user_id
    existing.email = who.email ?? existing.email
    existing.name = who.name ?? existing.name
    if (store.default_owner === null && existing.data_dir === null && existing.user_id !== null) {
      store.default_owner = String(existing.user_id)
    }
    if (JSON.stringify(existing) === before && store.default_owner !== null) return { stored: true }
  } else {
    // First time this account is seen and it is already running — in whichever dir the desktop
    // chose, which for a key not in the store is the default. Say so honestly in the record.
    if (store.default_owner === null && who.id !== null) store.default_owner = String(who.id)
    store.accounts.push({ user_id: who.id, email: who.email, name: who.name, key, data_dir: null })
  }
  writeAccountStore(home, store)
  return { stored: true }
}

/** Replace (or add) KEY=value lines in an env file's text, keeping every other line as written. */
export function setEnvKeys(text: string, values: Record<string, string | null>): string {
  const names = Object.keys(values)
  const kept = text
    .split("\n")
    .filter((line) => {
      const t = line.trim().replace(/^export\s+/, "")
      return !names.some((k) => t.startsWith(`${k}=`))
    })
    .filter((line, i, all) => !(i === all.length - 1 && line === ""))
  for (const [k, v] of Object.entries(values)) if (v !== null) kept.push(`${k}=${v}`)
  return kept.join("\n") + "\n"
}

/** Point the `iris` entry of an auth store at `key`, only if the store already has one. */
function repointAuthStore(file: string, key: string): boolean {
  if (!existsSync(file)) return false
  try {
    const store = JSON.parse(readFileSync(file, "utf-8"))
    if (!store || typeof store !== "object" || !("iris" in store)) return false
    store.iris = { ...(store.iris ?? {}), type: "api", key }
    writeFileSync(file, JSON.stringify(store, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * Make a stored account the active one. Writes the key where every reader already looks:
 * ~/.iris/sdk/.env (what chat and the desktop's spawn read), and the auth store the CLI reads
 * FIRST (platform.ts resolveToken) — rewriting only .env would leave `iris` in a terminal on the
 * old account. The account's own data dir gets the same treatment, because its engine's panels
 * read that one.
 *
 * `cliDataDir` is the default opencode data dir (the CLI's), NOT the running engine's: an engine
 * started for a second account has XDG_DATA_HOME pointed at that account.
 *
 * The running engine still holds the old key. The caller restarts the app.
 */
export function switchAccount(
  opts: { home: string; cliDataDir: string },
  ref: string,
): { ok: true; account: StoredAccount; written: string[] } | { ok: false; reason: string } {
  const { store, readable } = readAccountStore(opts.home)
  if (!readable) return { ok: false, reason: "~/.iris/accounts.json could not be read; nothing was changed" }
  const account = store.accounts.find((a) => accountRef(a) === ref)
  if (!account) return { ok: false, reason: `No saved sign-in for account ${ref}` }

  const written: string[] = []
  const envFile = path.join(opts.home, ".iris", "sdk", ".env")
  mkdirSync(path.dirname(envFile), { recursive: true })
  const before = existsSync(envFile) ? readFileSync(envFile, "utf-8") : ""
  writeFileSync(envFile, setEnvKeys(before, {
      IRIS_API_KEY: account.key,
      // Removed rather than left stale when unknown: resolveUserId trusts this line over fl-api.
      IRIS_USER_ID: account.user_id !== null ? String(account.user_id) : null,
    }), {
    mode: 0o600,
  })
  try {
    chmodSync(envFile, 0o600)
  } catch {}
  written.push("~/.iris/sdk/.env")

  const authFiles = new Set([path.join(opts.cliDataDir, "auth.json")])
  if (account.data_dir) authFiles.add(path.join(account.data_dir, "opencode", "auth.json"))
  for (const f of authFiles) if (repointAuthStore(f, account.key)) written.push(f)
  return { ok: true, account, written }
}

/**
 * Forget a saved sign-in that is NOT the active one. Its data dir stays on disk — chat history is
 * not ours to delete on a click, and signing back in as that account finds it again.
 */
export function removeAccount(
  home: string,
  ref: string,
  activeKey: string | null,
): { ok: true } | { ok: false; reason: string } {
  const { store, readable } = readAccountStore(home)
  if (!readable) return { ok: false, reason: "~/.iris/accounts.json could not be read; nothing was changed" }
  const account = store.accounts.find((a) => accountRef(a) === ref)
  if (!account) return { ok: false, reason: `No saved sign-in for account ${ref}` }
  if (activeKey && account.key === activeKey) {
    return { ok: false, reason: "That is the account in use. Sign out of it instead, or switch first." }
  }
  store.accounts = store.accounts.filter((a) => a !== account)
  writeAccountStore(home, store)
  return { ok: true }
}

/** Drop the active key's entry (after sign-out) and name the account to fall back to, if any. */
export function forgetActiveAccount(home: string, activeKey: string | null): { next: StoredAccount | null } {
  const { store, readable } = readAccountStore(home)
  if (!readable) return { next: null }
  if (activeKey) store.accounts = store.accounts.filter((a) => a.key !== activeKey)
  writeAccountStore(home, store)
  return { next: store.accounts[0] ?? null }
}


/** Directory name for an account that is not the default one. A fingerprint, never the key. */
function accountDirName(userId: number | null, key: string) {
  return userId !== null ? String(userId) : `key-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`
}

/** The data dir a newly seen account gets: the default only if nobody else's history is there. */
function dataDirFor(home: string, store: AccountStore, userId: number | null, key: string): string | null {
  if (store.default_owner === null) return null
  if (userId !== null && store.default_owner === String(userId)) return null
  return path.join(home, ".iris", "accounts", accountDirName(userId, key))
}

/**
 * Record a sign-in BEFORE the key in ~/.iris/sdk/.env is replaced — the same rule as the desktop's
 * record_sign_in (accounts.rs). `oldKey` / `oldUserId` are what .env held until now; they are kept
 * so signing in as a second account does not throw the first away. A sign-in by the same person
 * again is not a second account: it keeps their data dir, because their history is there.
 *
 * Refuses (returns false) on a store it cannot read rather than rewrite keys it cannot see.
 */
export function recordSignIn(
  home: string,
  old: { key: string | null; userId: number | null },
  newKey: string,
  who: { id: number | null; email: string | null; name: string | null },
): boolean {
  const { store, readable } = readAccountStore(home)
  if (!readable) return false

  const oldKey = old.key && old.key !== newKey ? old.key : null
  const samePerson = old.userId !== null && old.userId === who.id
  if (oldKey && !samePerson && !store.accounts.some((a) => a.key === oldKey)) {
    // The old account's history is in the default dir unless the store says otherwise.
    if (store.default_owner === null) store.default_owner = old.userId !== null ? String(old.userId) : "legacy"
    const inDefault =
      store.default_owner === "legacy" || (old.userId !== null && store.default_owner === String(old.userId))
    store.accounts.push({
      user_id: old.userId,
      email: null,
      name: null,
      key: oldKey,
      data_dir: inDefault ? null : dataDirFor(home, store, old.userId, oldKey),
    })
  }

  const existing =
    (who.id !== null && store.accounts.find((a) => a.user_id === who.id)) ||
    store.accounts.find((a) => a.key === newKey)
  if (existing) {
    existing.key = newKey
    existing.user_id = who.id ?? existing.user_id
    existing.email = who.email ?? existing.email
    existing.name = who.name ?? existing.name
  } else {
    const dataDir = dataDirFor(home, store, who.id, newKey)
    if (store.default_owner === null && dataDir === null && who.id !== null) store.default_owner = String(who.id)
    store.accounts.push({ user_id: who.id, email: who.email, name: who.name, key: newKey, data_dir: dataDir })
  }
  writeAccountStore(home, store)
  return true
}

/** What ~/.iris/sdk/.env holds now: the active account. */
export function readActiveSdkEnv(home: string): { key: string | null; userId: number | null } {
  const file = path.join(home, ".iris", "sdk", ".env")
  if (!existsSync(file)) return { key: null, userId: null }
  const text = readFileSync(file, "utf-8")
  const key = text.match(/^\s*(?:export\s+)?IRIS_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") || null
  const id = Number(text.match(/^\s*(?:export\s+)?IRIS_USER_ID=(\d+)\s*$/m)?.[1])
  return { key, userId: Number.isFinite(id) && id > 0 ? id : null }
}

/**
 * Find a saved account by what a person would type: its ref (user id or key:<fingerprint>), its
 * email, or its name. Ambiguous or unknown → null with the reason, never a guess.
 */
export function findAccount(
  store: AccountStore,
  who: string,
): { account: StoredAccount } | { account: null; reason: string } {
  const q = who.trim().replace(/^#/, "").toLowerCase()
  if (!q) return { account: null, reason: "Say which account: an email, a user id, or a name from `iris auth accounts`." }
  const byRef = store.accounts.filter((a) => accountRef(a).toLowerCase() === q)
  if (byRef.length === 1) return { account: byRef[0] }
  const byEmail = store.accounts.filter((a) => a.email?.toLowerCase() === q)
  if (byEmail.length === 1) return { account: byEmail[0] }
  const byName = store.accounts.filter((a) => a.name?.trim().toLowerCase() === q)
  if (byName.length === 1) return { account: byName[0] }
  if (byEmail.length + byName.length > 1) return { account: null, reason: `More than one saved account matches "${who}". Use the user id.` }
  return { account: null, reason: `No saved account matches "${who}". \`iris auth accounts\` lists them.` }
}

/** One line per account, for the terminal. Never prints a key. */
export function describeAccount(a: StoredAccount, activeKey: string | null) {
  const label = a.name?.trim() || a.email?.trim() || (a.user_id !== null ? `Account #${a.user_id}` : "An account signed in earlier")
  return {
    ref: accountRef(a),
    label,
    email: a.email,
    active: activeKey !== null && a.key === activeKey,
    separateData: a.data_dir !== null,
  }
}
