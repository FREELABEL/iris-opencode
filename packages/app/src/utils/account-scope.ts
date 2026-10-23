// Which IRIS account this window's own storage belongs to (#189336, follow-up to #189321).
//
// Chat history is kept apart per account by the engine's data dir. The webview's storage is not:
// open tabs, recently opened sessions and up-arrow prompt history would carry over from one
// account to the other — dead links to sessions this account does not have, and text typed as
// someone else. Those keys get the account appended.
//
// The account that owns the default data dir keeps the plain keys, the same rule the engine uses
// for chat history, so nobody's existing tabs or history move.
//
// The scope is resolved once at startup, before anything that persists mounts, and remembered:
// if the engine cannot say who is signed in, the last answer is a better guess than the default,
// which would put this account's typing into the first account's history.

const MARKER = "iris.account.scope"

export interface AccountScopeEntry {
  ref: string
  active: boolean
  separateData: boolean
}

let current: string | undefined

function readMarker(): string {
  try {
    return localStorage.getItem(MARKER) ?? ""
  } catch {
    return ""
  }
}

/** "" for the account that owns the default data dir (or when nobody is known), else its ref. */
export function scopeFromAccounts(accounts: AccountScopeEntry[] | undefined): string {
  const active = accounts?.find((a) => a.active)
  return active?.separateData ? active.ref : ""
}

export function accountScope(): string {
  if (current === undefined) current = readMarker()
  return current
}

export function setAccountScope(scope: string) {
  current = scope
  try {
    if (scope) localStorage.setItem(MARKER, scope)
    else localStorage.removeItem(MARKER)
  } catch {
    // Storage blocked: the scope still holds for this run.
  }
}

/** A storage key for this account. Unchanged for the default account. */
export function accountKey(key: string, scope = accountScope()): string {
  return scope ? `${key}@${scope}` : key
}

/** Legacy keys migrate only into the default account; they hold the first account's data. */
export function accountLegacy(legacy: string[] | undefined, scope = accountScope()): string[] | undefined {
  return scope ? undefined : legacy
}

/** Ask the engine who is signed in. Never throws; on any failure the remembered scope stands. */
export async function resolveAccountScope(base: string | undefined, fetcher: typeof fetch, timeoutMs = 3000) {
  if (!base) return accountScope()
  try {
    const res = await Promise.race([
      fetcher(`${base.replace(/\/$/, "")}/iris/accounts`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ])
    if (!res.ok) return accountScope()
    const body = (await res.json()) as { accounts?: AccountScopeEntry[] }
    setAccountScope(scopeFromAccounts(body.accounts))
  } catch {
    // Unreachable or slow engine: keep the last known account.
  }
  return accountScope()
}

export const AccountScopeTesting = {
  reset() {
    current = undefined
  },
}
