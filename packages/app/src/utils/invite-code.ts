/**
 * A friend's invite code, from an iris://invite?code=… link (epic #194525), kept until this person
 * signs in with a code — then sent as `invite_code` to /api/v1/auth/login-with-code, so both get
 * the reward — and forgotten.
 */
const KEY = "iris.invite-code"

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
