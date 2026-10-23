// DNS-rebinding guard (#190647).
//
// A web page can point its own DNS name at 127.0.0.1 and then talk to a loopback server as if it
// were same-origin. What it cannot change is the Host header the browser sends: that stays the
// page's own name. So a server that knows the only names it is reached by refuses everything else.
//
// Opt-in, because only the launcher knows those names. IRIS Desktop sets
// OPENCODE_SERVER_ALLOWED_HOSTS=127.0.0.1:<port>,localhost:<port> for its engine. Unset, the
// server behaves exactly as before — a remote `serve --hostname 0.0.0.0`, a tunnel, a reverse
// proxy all keep working.

export const ALLOWED_HOSTS_ENV = "OPENCODE_SERVER_ALLOWED_HOSTS"

/** The allowlist from the environment, lowercased. Undefined (no guard) when unset or empty. */
export function allowedHosts(value: string | undefined): Set<string> | undefined {
  const hosts = (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return hosts.length ? new Set(hosts) : undefined
}

/** Whether a request with this Host header may be served. No allowlist means yes. */
export function hostAllowed(host: string | undefined, allowed: Set<string> | undefined) {
  if (!allowed) return true
  if (!host) return false
  return allowed.has(host.trim().toLowerCase())
}

// Pinned at `serve` start and REMOVED from the environment, so processes the engine starts (the
// agent's shell, a PTY, an `iris serve` a playbook runs on another port) do not inherit an
// allowlist naming this server's port — inherited, it would make that other server refuse every
// request it gets.
let pinned: string | undefined

export function pinAllowedHostsFromEnv() {
  const value = process.env[ALLOWED_HOSTS_ENV]
  if (value === undefined) return
  pinned = value
  delete process.env[ALLOWED_HOSTS_ENV]
}

/** The allowlist in force: the pinned one, else whatever the environment says now. */
export function currentAllowedHosts() {
  return allowedHosts(pinned ?? process.env[ALLOWED_HOSTS_ENV])
}

/** Tests only. */
export function resetPinnedAllowedHosts() {
  pinned = undefined
}
