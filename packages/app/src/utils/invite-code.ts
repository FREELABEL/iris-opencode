/**
 * A friend's invite code, from an iris://invite?code=… link (epic #194525) or typed at sign-in /
 * in the usage popover (#194575), kept until it is used — sent as `invite_code` on
 * /api/v1/auth/login-with-code, or claimed through /iris/invite/claim once signed in — and forgotten.
 */
const KEY = "iris.invite-code"
/** Set once a claim has a final answer for this account: the popover's "Have an invite code?" goes. */
const SETTLED = "iris.invite-code.settled"

export function rememberInviteCode(code: string) {
  try {
    localStorage.setItem(KEY, code)
  } catch {}
}

export function pendingInviteCode(): string | null {
  try {
    const v = localStorage.getItem(KEY)?.trim()
    return v || null
  } catch {
    return null
  }
}

export function forgetInviteCode() {
  try {
    localStorage.removeItem(KEY)
  } catch {}
}

/** The login-with-code body with the invite added when there is one. Pure, so it is tested. */
export function withInviteCode<T extends Record<string, unknown>>(body: T, code: string | null): T & { invite_code?: string } {
  return code ? { ...body, invite_code: code } : body
}

/**
 * fl-api's own rule (UsageInviteService::normalise): trimmed, lowercased, 4–32 letters and digits.
 * Null when it cannot be a code, so nothing malformed is ever sent.
 */
export function normaliseInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const code = raw.trim().toLowerCase()
  return /^[a-z0-9]{4,32}$/.test(code) ? code : null
}

export const INVITE_CODE_LOOKS_WRONG = "That code doesn't look right"

/** What to say under a typed code: nothing while it is empty or well-formed. */
export function inviteCodeProblem(raw: string): string | null {
  return raw.trim() && !normaliseInviteCode(raw) ? INVITE_CODE_LOOKS_WRONG : null
}

/**
 * Which invite rides on sign-in. The typed field wins when it is open; otherwise the remembered
 * deep-link code. A code that doesn't look right is dropped with a note — sign-in never waits on it.
 */
export function signInInvite(v: { open: boolean; typed: string; remembered: string | null }): {
  code: string | null
  note: string | null
} {
  if (v.open && v.typed.trim()) {
    const code = normaliseInviteCode(v.typed)
    return code ? { code, note: null } : { code: null, note: `${INVITE_CODE_LOOKS_WRONG}, so you'll sign in without it.` }
  }
  return { code: normaliseInviteCode(v.remembered), note: null }
}

export function inviteSettled(): boolean {
  try {
    return localStorage.getItem(SETTLED) === "1"
  } catch {
    return false
  }
}

export function settleInvite() {
  try {
    localStorage.setItem(SETTLED, "1")
  } catch {}
}
