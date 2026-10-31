// `iris hive creds … --local` — the node vault from the main CLI (#187915).
//
// WHY THIS IS A HAND-OFF AND NOT A REIMPLEMENTATION. The vault itself lives in the daemon
// (iris-daemon lib/node-vault.js): an AES-256-GCM store whose master key is held by the OS keystore
// (Keychain, libsecret, DPAPI), whose TOTP codes are generated on the node, and whose only export is
// a list of names on the heartbeat. A second copy of that crypto in this repo would be a second
// place for the key handling to be wrong. So `--local` runs the daemon's own vault CLI on THIS
// machine, with the terminal attached so the password prompt is hidden and never touches argv.
//
// Nothing here makes a network call. That is the whole point: the server only ever learns the
// credential's NAME, from the node's heartbeat.

import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { spawnSync } from "node:child_process"

export type NodeVaultAction = "add" | "list" | "remove"

export interface NodeVaultAddOptions {
  type?: string
  username?: string
  url?: string
  totp?: boolean
  totpSecret?: string
  passwordStdin?: boolean
  json?: boolean
}

// Same rule as node-vault.js NAME_RE — checked here too so a bad name fails before a prompt opens.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validVaultName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name)
}

export function nodeVaultCliPath(home = os.homedir()): string {
  return path.join(home, ".iris", "bridge", "lib", "node-vault-cli.js")
}

// The daemon pins the node it runs under in ~/.iris/daemon-node. Use the same one, so the vault
// is opened by the binary that will open it at task time; fall back to whatever `node` is on PATH.
export function nodeBinary(home = os.homedir(), read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): string {
  try {
    const pinned = read(path.join(home, ".iris", "daemon-node")).trim()
    if (pinned && fs.existsSync(pinned)) return pinned
  } catch {}
  return "node"
}

// Build the daemon CLI's argv. Secrets are deliberately NOT accepted here except --totp-secret,
// which the daemon itself accepts with a shell-history warning; the password always comes from the
// hidden prompt or stdin.
export function nodeVaultArgv(action: NodeVaultAction, name?: string, opts: NodeVaultAddOptions = {}): string[] {
  if (action === "list") return opts.json ? ["list", "--json"] : ["list"]
  if (!validVaultName(name)) {
    throw new Error(`a vault name is required: letters, digits, "." "_" "-", up to 64 characters (got ${JSON.stringify(name ?? "")})`)
  }
  if (action === "remove") return ["remove", name]
  const argv = ["add", name, "--type", opts.type || "login"]
  if (opts.username) argv.push("--username", opts.username)
  if (opts.url) argv.push("--url", opts.url)
  if (opts.totpSecret) argv.push("--totp-secret", opts.totpSecret)
  else if (opts.totp) argv.push("--totp")
  if (opts.passwordStdin) argv.push("--password-stdin")
  return argv
}

export const NODE_VAULT_MISSING =
  "This machine has no IRIS daemon, so it has no node vault. Install it with:  curl -fsSL https://heyiris.io/install-code | bash"

// Runs the daemon's vault CLI with this terminal attached. Returns its exit code.
export function runNodeVault(action: NodeVaultAction, name?: string, opts: NodeVaultAddOptions = {}): number {
  const cli = nodeVaultCliPath()
  if (!fs.existsSync(cli)) {
    console.error(NODE_VAULT_MISSING)
    return 1
  }
  let argv: string[]
  try {
    argv = nodeVaultArgv(action, name, opts)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 2
  }
  const r = spawnSync(nodeBinary(), [cli, ...argv], { stdio: "inherit" })
  if (r.error) {
    console.error(`error: could not run the node vault (${r.error.message})`)
    return 1
  }
  return r.status ?? 1
}
