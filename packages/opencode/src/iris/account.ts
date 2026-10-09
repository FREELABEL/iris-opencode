/**
 * Who the app acts as, and signing out of it (#187966 K1, D3).
 *
 * Kept apart from platform.ts so it can be tested against a temporary home directory: these
 * functions decide what gets DELETED from a person's machine, and they take `home` as an
 * argument rather than reading the real one.
 */
import { existsSync, readFileSync, writeFileSync } from "fs"
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
