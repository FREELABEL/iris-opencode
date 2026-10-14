/**
 * Who the app acts as, and signing out of it (#187966 K1, D3).
 *
 * Kept apart from platform.ts so it can be tested against a temporary home directory: these
 * functions decide what gets DELETED from a person's machine, and they take `home` as an
 * argument rather than reading the real one.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import path from "path"

/**
 * The credential CHAT uses. The model provider reads `process.env.IRIS_API_KEY` and nothing else
 * (provider.ts), which the desktop sets from ~/.iris/sdk/.env when it spawns the engine. The
 * panels resolve their own token and prefer the auth store, so the two can differ (#188506).
 * Settings must name the one the agent acts as.
 */
export function agentCredential(env: NodeJS.ProcessEnv, fallback: () => { token: string | null; source: string }) {
  const key = env.IRIS_API_KEY?.trim()
  if (key) return { token: key, source: "~/.iris/sdk/.env (the key chat uses)" }
  return fallback()
}

/** The Hive node key: it belongs to the machine, and sign-out must leave it alone. */
export function readNodeKey(home: string): string | null {
  try {
    const cfg = path.join(home, ".iris", "config.json")
    if (!existsSync(cfg)) return null
    const key = JSON.parse(readFileSync(cfg, "utf-8"))?.node_api_key
    return typeof key === "string" && key ? key : null
  } catch {
    return null
  }
}

export type CredentialKind = "personal" | "machine" | "none"

export function credentialKind(token: string | null, nodeKey: string | null): CredentialKind {
  if (!token) return "none"
  if (nodeKey && token === nodeKey) return "machine"
  return "personal"
}

const PERSONAL_ENV_KEYS = ["IRIS_API_KEY", "IRIS_USER_ID"]

/** ~/.iris/sdk/.env without the personal sign-in. Every other line is kept as written. */
export function stripPersonalKeys(text: string): { text: string; removed: string[] } {
  const removed: string[] = []
  const kept = text.split("\n").filter((line) => {
    const t = line.trim().replace(/^export\s+/, "")
    const key = PERSONAL_ENV_KEYS.find((k) => t.startsWith(`${k}=`))
    if (key) removed.push(key)
    return !key
  })
  return { text: kept.join("\n"), removed }
}

/**
 * Sign out of IRIS on this machine, for the desktop AND the CLI, which share these files
 * (option A, decided 2026-10-08). Removes the personal key and user id from ~/.iris/sdk/.env
 * and the `iris` entry from the auth store. Leaves ~/.iris/config.json alone: the Hive node key
 * is the machine's, and removing it would take this machine off Hive.
 *
 * The running engine still holds its key in memory. The caller must restart it; the desktop
 * restarts the app, whose startup check then shows the sign-in screen.
 */
export function signOutPersonal(opts: { home: string; dataDir: string }): { removed: string[] } {
  const removed: string[] = []

  const envFile = path.join(opts.home, ".iris", "sdk", ".env")
  if (existsSync(envFile)) {
    const before = readFileSync(envFile, "utf-8")
    const after = stripPersonalKeys(before)
    if (after.removed.length) {
      // writeFileSync keeps the existing file's permissions (0600 from sign-in).
      writeFileSync(envFile, after.text)
      removed.push(...after.removed.map((k) => `~/.iris/sdk/.env ${k}`))
    }
  }

  const authFile = path.join(opts.dataDir, "auth.json")
  if (existsSync(authFile)) {
    try {
      const store = JSON.parse(readFileSync(authFile, "utf-8"))
      if (store && typeof store === "object" && "iris" in store) {
        delete store.iris
        writeFileSync(authFile, JSON.stringify(store, null, 2))
        removed.push("auth store: iris")
      }
    } catch {
      // An unreadable auth store is not ours to rewrite. Report nothing removed from it.
    }
  }

  return { removed }
}

// ---------------------------------------------------------------------------------------------
// More than one account on one machine (#189321, the Desktop half of #188828).
//
// The ACTIVE account stays exactly where it always was — ~/.iris/sdk/.env and the `iris` entry of
// the auth store — so the CLI, the panels and the desktop's key watcher keep reading what they
// read today. ~/.iris/accounts.json holds every account this machine has signed in as, so that
// signing in as a second one does not throw the first one away, and a switch has a key to write.
//
// Each account after the first gets its own engine data dir (passed to the engine as
// XDG_DATA_HOME by the desktop), because local chat sessions carry no account id: without that,
// one account's history shows under the other. The first account keeps the default dir, so
// nobody's existing history moves. `default_owner` records whose history the default dir holds
// and outlives that account's removal — a later account must not inherit it.
//
// The desktop's Rust side writes this file at sign-in (login.rs) and reads it at engine spawn
// (lib.rs). Keep the shape in step with those two.
// ---------------------------------------------------------------------------------------------

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

/**
 * The CLI's data dir as seen from inside an engine the desktop started. When the desktop points
 * XDG_DATA_HOME at a second account it passes the original value in IRIS_PARENT_XDG_DATA_HOME
 * (empty = was unset), so "the default dir" can still be found.
 */
export function cliDataDir(env: NodeJS.ProcessEnv, home: string, platform = process.platform): string {
  const xdg = "IRIS_PARENT_XDG_DATA_HOME" in env ? env.IRIS_PARENT_XDG_DATA_HOME : env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "opencode")
  if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "opencode")
  return path.join(home, ".local", "share", "opencode")
}
