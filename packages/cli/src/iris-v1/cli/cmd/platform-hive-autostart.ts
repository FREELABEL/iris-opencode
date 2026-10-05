import { execFileSync } from "child_process"

/**
 * Windows autostart for a Hive node (#186663).
 *
 * WHY THIS LIVES WITH `connect` AND NOT ONLY IN THE INSTALLER.
 *
 * install.ps1 registers a logon task — but inside the branch that installs the daemon, which it
 * skips when Node.js is absent. The common order on Windows is: install the CLI, discover Node is
 * missing, install Node, run `iris hive connect`. That produced a machine that was a node until
 * its next reboot, and said nothing about it. Autostart has to follow the act that MAKES a
 * machine a node.
 *
 * The task name is the installer's, deliberately: two names would leave two tasks racing to start
 * the same daemon at every logon.
 */
export const AUTOSTART_TASK = "IRIS Hive Node"

export type AutostartDecision =
  | { action: "register"; daemonCmd: string }
  | { action: "skip"; reason: string }

/**
 * Whether to register, and — when not — WHY, in words a reader can act on.
 *
 * A skip is always reported by the caller. A machine that will not come back after a reboot must
 * never be reported as one that will (#184597 is that exact shape, one level up).
 */
export function autostartDecision(o: { platform: string; daemonCmd: string | null }): AutostartDecision {
  if (o.platform !== "win32") {
    return { action: "skip", reason: "not Windows — other platforms keep their own autostart" }
  }
  if (!o.daemonCmd) {
    return { action: "skip", reason: "the daemon is not installed on this machine, so there is nothing to start" }
  }
  return { action: "register", daemonCmd: o.daemonCmd }
}

/**
 * The arguments schtasks actually receives.
 *
 * `/TR` carries a COMMAND LINE, not a path, and schtasks splits it on spaces — so the program is
 * quoted inside the value and its argument sits outside the quotes. Unquoted, a path like
 * `C:\Users\First Last\...` registers happily and then fails at every logon: a success that is
 * not one.
 *
 * `/F` replaces: re-running `hive connect` must never stack duplicate tasks.
 * `/RL LIMITED` runs as this user, so no elevation prompt appears at logon.
 */
export function schtasksCreateArgs(daemonCmd: string): string[] {
  return [
    "/Create",
    "/TN", AUTOSTART_TASK,
    "/TR", `"${daemonCmd}" start`,
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/F",
  ]
}

export function schtasksQueryArgs(): string[] {
  return ["/Query", "/TN", AUTOSTART_TASK]
}

/** Does the task already exist? Used only for wording — never as a gate on registering. */
export function autostartRegistered(): boolean {
  try {
    execFileSync("schtasks", schtasksQueryArgs(), { stdio: "ignore", timeout: 10000 })
    return true
  } catch {
    return false
  }
}

/**
 * Register it. Returns a RESULT rather than throwing: a failure here must not fail a connect that
 * otherwise worked — the machine IS online, it simply will not return by itself after a reboot,
 * and the caller says so.
 */
export function ensureAutostart(o: { platform: string; daemonCmd: string | null }): { ok: boolean; skipped?: string; reason?: string } {
  const d = autostartDecision(o)
  if (d.action === "skip") return { ok: false, skipped: d.reason }
  try {
    execFileSync("schtasks", schtasksCreateArgs(d.daemonCmd), { stdio: "ignore", timeout: 15000 })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, reason: e?.message ? String(e.message).split("\n")[0] : "schtasks refused it" }
  }
}
