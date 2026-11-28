// The emailed sign-in code: checked before it is sent, and retried when it was mistyped.
// fl-api accepts exactly 6 digits (LoginController::loginWithCode, size:6) and locks the code
// after too many wrong tries (429), so the CLI allows three tries at the same code.

export const MAX_CODE_TRIES = 3

export function loginCodeError(value: string | undefined): string | undefined {
  const v = (value ?? "").replace(/\s/g, "")
  if (!v) return "Enter the 6-digit code from your email"
  if (!/^\d+$/.test(v)) return "The code is only numbers — check it and type it again"
  if (v.length !== 6) return "The code is 6 digits — check it and type it again"
  return undefined
}

export function codeTriesLeftLine(triesUsed: number): string {
  const left = MAX_CODE_TRIES - triesUsed
  return `That code didn't work. ${left} ${left === 1 ? "try" : "tries"} left — type it again.`
}

/** A failure the person can fix by retyping the same code. Expired, locked or unknown is not. */
export function isWrongCodeFailure(status: number, body: any): boolean {
  const text = String(body?.error ?? body?.message ?? "").toLowerCase()
  if (status === 422) return true
  return status === 400 && text.includes("invalid") && !text.includes("expired")
}
