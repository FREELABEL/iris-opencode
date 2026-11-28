/**
 * What an `iris://` link means (#190233).
 *
 * The desktop shell only checks the scheme; this decides. A fixed set of hosts is accepted and
 * everything else is ignored — a link can come from any web page, so nothing in it is ever
 * navigated to or run. The plan is an opaque slug, used only to look up a name the app already has.
 */
export type IrisLink = { kind: "upgraded"; plan: string | null } | { kind: "invite"; code: string }

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
/** An invite code (epic #194525): opaque, short, URL-safe. Anything else is ignored. */
const INVITE = /^[A-Za-z0-9_-]{3,64}$/

export function parseIrisLink(raw: string): IrisLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "iris:") return null

  // `iris://upgraded?…` puts the target in the host; `iris:upgraded` and `iris:///upgraded` put it
  // in the path. Accept all three spellings of the same link.
  const target = (url.hostname || url.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase()

  if (target === "upgraded") {
    const plan = url.searchParams.get("plan")
    return { kind: "upgraded", plan: plan && SLUG.test(plan) ? plan : null }
  }
  // `iris://invite?code=…` — a friend's invite. Remembered until sign-in, then sent as invite_code.
  if (target === "invite") {
    const code = url.searchParams.get("code")?.trim()
    return code && INVITE.test(code) ? { kind: "invite", code } : null
  }
  return null
}
