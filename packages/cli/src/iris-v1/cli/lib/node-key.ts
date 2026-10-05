// ============================================================================
// Is this machine's Hive node key still accepted by the server?
//
// A machine holds TWO credentials and they fail independently:
//
//   account token   ~/.iris/sdk/.env        who you are — login, chat, integrations
//   node key        ~/.iris/config.json     which machine this is — the Hive daemon
//
// Logging in (Desktop, `iris auth login`, `iris-login`) only ever touches the first. A node
// key the server no longer has answers 401 on every call, and before this file nothing on
// the machine said how to replace it: doctor printed "key may be invalid", `auth login`
// printed "Already authenticated", and `hive connect` refused because a key was present.
// A client spent a live call re-logging-in while the dead key sat untouched (#185896), and
// the in-app agent, reading the same messages, recommended the same wrong fix (#185893).
//
// The daemon now owns the node key and replaces a rejected one from the signed-in account; every
// surface that can see a rejected key names the one command that makes that happen now.
// ============================================================================

export const NODE_KEY_FIX = "iris hive connect"

export type NodeKeyStatus =
  | "valid" // server accepted it
  | "rejected" // 401 — the server has no node with this key; re-register
  | "suspended" // 403 — the node exists but is not active; re-registering will not help
  | "unreachable" // network failure or any other status — we do not know, so claim nothing

/**
 * Classify a heartbeat response. Only a 401 means "this key is dead" — AuthenticateComputeNode
 * returns 401 for a missing or unknown key and 403 for a suspended node or a non-whitelisted
 * IP. Collapsing those would tell a suspended node to re-register, minting a second row.
 */
export function classifyNodeKeyStatus(httpStatus: number): NodeKeyStatus {
  if (httpStatus >= 200 && httpStatus < 300) return "valid"
  if (httpStatus === 401) return "rejected"
  if (httpStatus === 403) return "suspended"
  return "unreachable"
}

/**
 * The address a DIFFERENT machine would use to reach this one — the first non-internal IPv4.
 *
 * `hive doctor` used to test exposure by fetching http://0.0.0.0:3200. On macOS and Linux a
 * connect to 0.0.0.0 is routed to loopback, so that probe succeeds against a bridge bound to
 * 127.0.0.1 and the check warned "network-accessible" on every machine (#185888). Probing a
 * real interface address is what actually distinguishes the two binds.
 */
export function lanAddress(
  interfaces: Record<string, Array<{ family: string | number; internal: boolean; address: string }> | undefined>,
): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if ((i.family === "IPv4" || i.family === 4) && !i.internal) return i.address
    }
  }
  return undefined
}
